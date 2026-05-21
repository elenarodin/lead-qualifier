import { enrichCompany } from "./enrich.js";
import {
  findIndustryById,
  loadRubric,
  primaryAngleForIndustry,
} from "./rubric.js";
import type {
  CompanyScreenResult,
  EnrichmentResult,
  Rubric,
} from "./types.js";

export const MAX_BATCH = 10;
const DEFAULT_CONCURRENCY = 4;

// Bounded-parallel map. Worker pool with a shared cursor — no per-item promise
// allocation. Per-item errors don't abort the batch.
async function pMap<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<U>,
): Promise<U[]> {
  const n = items.length;
  if (n === 0) return [];
  const results: U[] = new Array(n);
  let cursor = 0;
  const workerCount = Math.min(limit, n);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= n) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

function isUSGeo(geo: string, allowed: readonly string[]): boolean {
  const g = geo.trim().toLowerCase();
  if (
    g === "us" ||
    g === "usa" ||
    g === "united states" ||
    g === "united states of america"
  ) {
    return true;
  }
  return allowed.map((a) => a.toLowerCase()).includes(g);
}

function buildResult(args: Partial<CompanyScreenResult> & {
  company: string;
  status: CompanyScreenResult["status"];
  reason: string;
  enrichment: EnrichmentResult;
  industryFamily?: string | null;
  signals: string[];
}): CompanyScreenResult {
  const { enrichment } = args;
  return {
    company: args.company,
    status: args.status,
    industry: args.industry ?? enrichment.industry,
    industry_family: args.industryFamily ?? null,
    size: args.size ?? enrichment.size,
    size_confidence: args.size_confidence ?? enrichment.size_confidence,
    geography: args.geography ?? enrichment.geography,
    angle: args.angle ?? null,
    angle_label: args.angle_label ?? null,
    reason: args.reason,
    signals: args.signals,
  };
}

// Company-only rules — no title checks, no excluded_contacts. Uncertain size
// and uncertain geography never hard-fail. Each branch produces a concrete
// CompanyScreenResult; callers don't synthesize results outside this function.
function applyCompanyRules(
  company: string,
  enrichment: EnrichmentResult,
  rubric: Rubric,
): CompanyScreenResult {
  const signals: string[] = [];
  if (enrichment.source === "web") signals.push("industry_via_web");

  // 1. Industry not identifiable at all → NEEDS_INFO.
  if (!enrichment.identified || enrichment.industry === null) {
    return buildResult({
      company,
      status: "NEEDS_INFO",
      enrichment,
      reason: `Couldn't identify ${company}'s industry, even after a web lookup. Re-send with the company's About section or industry/headcount details.`,
      signals: [...signals, "company_unidentified"],
    });
  }

  const bucketHit = findIndustryById(rubric, enrichment.industry);

  // 2. Industry confidently in excluded bucket → NOT.
  if (bucketHit?.bucket === "excluded") {
    return buildResult({
      company,
      status: "NOT",
      enrichment,
      industryFamily: bucketHit.industry.label,
      reason: `${bucketHit.industry.label} is outside Kombocode's healthcare focus`,
      signals: [...signals, "industry_excluded"],
    });
  }

  // 3. Industry identified but not in any rubric bucket (e.g. "fintech") → NOT.
  if (!bucketHit) {
    return buildResult({
      company,
      status: "NOT",
      enrichment,
      reason: `${enrichment.industry} is outside Kombocode's healthcare focus`,
      signals: [...signals, "industry_off_icp"],
    });
  }

  // From here, industry is in core or expanded (healthcare).
  const familyLabel = bucketHit.industry.label;

  // 4. Size — only DQ on high-confidence out-of-band.
  if (enrichment.size !== null && enrichment.size_confidence === "high") {
    if (enrichment.size < rubric.company_size.min_employees) {
      return buildResult({
        company,
        status: "NOT",
        enrichment,
        industryFamily: familyLabel,
        reason: `Size ${enrichment.size} is below the ${rubric.company_size.min_employees}-employee minimum`,
        signals: [...signals, "size_below_min"],
      });
    }
    if (enrichment.size > rubric.company_size.max_employees) {
      return buildResult({
        company,
        status: "NOT",
        enrichment,
        industryFamily: familyLabel,
        reason: `Size ${enrichment.size} is above the ${rubric.company_size.max_employees}-employee maximum`,
        signals: [...signals, "size_above_max"],
      });
    }
  } else {
    // Unknown size OR size_confidence !== "high" → soft flag, continue.
    signals.push("size_unverified");
  }

  // 5. Geography — only DQ when confidently known to be non-US.
  if (enrichment.geography) {
    const allowed = rubric.geography.allowed;
    if (!isUSGeo(enrichment.geography, allowed)) {
      return buildResult({
        company,
        status: "NOT",
        enrichment,
        industryFamily: familyLabel,
        reason: `Geography ${enrichment.geography} is not US`,
        signals: [...signals, "geography_non_us"],
      });
    }
  }

  // 6. TARGET — pick the family's primary angle from the rubric.
  const primary = primaryAngleForIndustry(rubric, enrichment.industry);
  const sizeBit =
    enrichment.size !== null
      ? `, ~${enrichment.size} employees${enrichment.size_confidence !== "high" ? " (unverified)" : ""}`
      : ", size unverified";
  const angleBit = primary ? ` → opening angle: ${primary.label}` : "";

  return buildResult({
    company,
    status: "TARGET",
    enrichment,
    industryFamily: familyLabel,
    angle: primary?.angle ?? null,
    angle_label: primary?.label ?? null,
    reason: `${familyLabel} match${sizeBit}${angleBit}`,
    signals,
  });
}

export async function qualifyCompany(
  name: string,
): Promise<CompanyScreenResult> {
  const rubric = loadRubric();
  const trimmed = name.trim();
  const enrichment = await enrichCompany(trimmed, rubric);
  return applyCompanyRules(trimmed, enrichment, rubric);
}

export interface ScreenCompaniesOptions {
  maxBatch?: number;
  concurrency?: number;
}

export interface ScreenCompaniesOutput {
  results: CompanyScreenResult[];
  skipped: string[]; // names beyond the cap that we did NOT screen
}

export async function screenCompanies(
  names: string[],
  opts: ScreenCompaniesOptions = {},
): Promise<ScreenCompaniesOutput> {
  const max = opts.maxBatch ?? MAX_BATCH;
  const conc = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const cleaned = names.map((n) => n.trim()).filter((n) => n.length > 0);
  const toScreen = cleaned.slice(0, max);
  const skipped = cleaned.slice(max);

  const results = await pMap(toScreen, conc, async (name) => {
    try {
      return await qualifyCompany(name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        company: name,
        status: "NEEDS_INFO" as const,
        industry: null,
        industry_family: null,
        size: null,
        size_confidence: null,
        geography: null,
        angle: null,
        angle_label: null,
        reason: `Error during screening: ${message}`,
        signals: ["screening_error"],
      };
    }
  });

  return { results, skipped };
}
