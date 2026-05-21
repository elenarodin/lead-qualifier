import { enrichCompany } from "./enrich.js";
import {
  findIndustryById,
  loadRubric,
  primaryAngleForIndustry,
} from "./rubric.js";
import type {
  CompanyIdentifier,
  CompanyScreenResult,
  EnrichmentResult,
  Rubric,
} from "./types.js";

export const MAX_BATCH = 10;
const DEFAULT_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// /company line parser
//
// Accepts forms like:
//   "Quadax, quadax.com"                            → name=Quadax · domain=quadax.com
//   "quadax.com"                                    → domain only
//   "https://www.quadax.com/about"                  → domain only
//   "linkedin.com/company/datavant"                 → linkedin_slug only
//   "Datavant, linkedin.com/company/datavant"       → name + slug
//   "Welkin"                                        → bare name
//   "Acme, Inc"                                     → name="Acme, Inc"  (right side not a URL)
// ---------------------------------------------------------------------------

const LINKEDIN_SLUG_RE =
  /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/company\/([^/?#\s]+)/i;
const URL_RE = /^https?:\/\/(?:www\.)?([^/?#\s]+)/i;
const BARE_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

function extractLinkedInSlug(s: string): string | null {
  const m = s.match(LINKEDIN_SLUG_RE);
  return m ? m[1].toLowerCase() : null;
}

function extractDomain(s: string): string | null {
  const trimmed = s.trim();
  const urlMatch = trimmed.match(URL_RE);
  if (urlMatch) return urlMatch[1].toLowerCase().replace(/^www\./, "");
  if (BARE_DOMAIN_RE.test(trimmed)) {
    return trimmed.toLowerCase().replace(/^www\./, "");
  }
  return null;
}

export function parseCompanyLine(line: string): CompanyIdentifier {
  const trimmed = line.trim();
  if (!trimmed) {
    return { name: null, domain: null, linkedin_slug: null };
  }

  const commaIdx = trimmed.indexOf(",");
  if (commaIdx > 0) {
    const left = trimmed.slice(0, commaIdx).trim();
    const right = trimmed.slice(commaIdx + 1).trim();
    const slug = extractLinkedInSlug(right);
    if (slug) return { name: left || null, domain: null, linkedin_slug: slug };
    const domain = extractDomain(right);
    if (domain) return { name: left || null, domain, linkedin_slug: null };
    // Right side isn't a recognizable identifier — treat the whole line as a name.
    return { name: trimmed, domain: null, linkedin_slug: null };
  }

  const slug = extractLinkedInSlug(trimmed);
  if (slug) return { name: null, domain: null, linkedin_slug: slug };
  const domain = extractDomain(trimmed);
  if (domain) return { name: null, domain, linkedin_slug: null };
  return { name: trimmed, domain: null, linkedin_slug: null };
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

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

function pickDisplayName(
  identifier: CompanyIdentifier,
  enrichment: EnrichmentResult,
): string {
  return (
    identifier.name ||
    enrichment.resolved_domain ||
    identifier.domain ||
    identifier.linkedin_slug ||
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function applyCompanyRules(
  identifier: CompanyIdentifier,
  enrichment: EnrichmentResult,
  rubric: Rubric,
): CompanyScreenResult {
  const displayName = pickDisplayName(identifier, enrichment);

  // Common resolution-echo fields applied to every outcome.
  const resolution = {
    resolved_domain: enrichment.resolved_domain,
    resolved_via: enrichment.resolved_via,
    match_confidence: enrichment.match_confidence,
  };

  const baseSignals: string[] = [];
  if (enrichment.source === "web") baseSignals.push("industry_via_web");
  if (enrichment.resolved_via === "domain")
    baseSignals.push("resolved_via_domain");

  // 1. AMBIGUOUS first — bare-name collisions, never silently picked.
  if (enrichment.candidates.length >= 2) {
    const retryHint = `/company ${displayName}, <domain>`;
    return {
      company: displayName,
      status: "AMBIGUOUS",
      industry: null,
      industry_family: null,
      sub_industry: null,
      size: enrichment.size,
      size_confidence: enrichment.size_confidence,
      geography: enrichment.geography,
      angle: null,
      angle_label: null,
      reason: `Multiple distinct companies match "${displayName}". Add a domain to disambiguate, e.g. ${retryHint}.`,
      signals: [...baseSignals, "ambiguous_resolution"],
      ...resolution,
      candidates: enrichment.candidates,
    };
  }

  // 2. NEEDS_INFO if not identified or no industry resolved.
  if (!enrichment.identified || enrichment.industry === null) {
    return {
      company: displayName,
      status: "NEEDS_INFO",
      industry: null,
      industry_family: null,
      sub_industry: null,
      size: enrichment.size,
      size_confidence: enrichment.size_confidence,
      geography: enrichment.geography,
      angle: null,
      angle_label: null,
      reason: `Couldn't identify ${displayName}'s industry, even after a web lookup. Add a domain or re-send with a description.`,
      signals: [...baseSignals, "company_unidentified"],
      ...resolution,
      candidates: [],
    };
  }

  const bucketHit = findIndustryById(rubric, enrichment.industry);

  // 3. Industry confidently excluded → NOT.
  if (bucketHit?.bucket === "excluded") {
    return {
      company: displayName,
      status: "NOT",
      industry: enrichment.industry,
      industry_family: bucketHit.industry.label,
      sub_industry: enrichment.sub_industry,
      size: enrichment.size,
      size_confidence: enrichment.size_confidence,
      geography: enrichment.geography,
      angle: null,
      angle_label: null,
      reason: `${bucketHit.industry.label} is outside Kombocode's healthcare focus`,
      signals: [...baseSignals, "industry_excluded"],
      ...resolution,
      candidates: [],
    };
  }

  // 4. Industry identified but not in any rubric bucket → off-ICP NOT.
  if (!bucketHit) {
    return {
      company: displayName,
      status: "NOT",
      industry: enrichment.industry,
      industry_family: null,
      sub_industry: enrichment.sub_industry,
      size: enrichment.size,
      size_confidence: enrichment.size_confidence,
      geography: enrichment.geography,
      angle: null,
      angle_label: null,
      reason: `${enrichment.industry} is outside Kombocode's healthcare focus`,
      signals: [...baseSignals, "industry_off_icp"],
      ...resolution,
      candidates: [],
    };
  }

  const familyLabel = bucketHit.industry.label;

  // 5. Size — only DQ on high-confidence out-of-band.
  const signals: string[] = [...baseSignals];
  if (enrichment.size !== null && enrichment.size_confidence === "high") {
    if (enrichment.size < rubric.company_size.min_employees) {
      return {
        company: displayName,
        status: "NOT",
        industry: enrichment.industry,
        industry_family: familyLabel,
        sub_industry: enrichment.sub_industry,
        size: enrichment.size,
        size_confidence: enrichment.size_confidence,
        geography: enrichment.geography,
        angle: null,
        angle_label: null,
        reason: `Size ${enrichment.size} is below the ${rubric.company_size.min_employees}-employee minimum`,
        signals: [...signals, "size_below_min"],
        ...resolution,
        candidates: [],
      };
    }
    if (enrichment.size > rubric.company_size.max_employees) {
      return {
        company: displayName,
        status: "NOT",
        industry: enrichment.industry,
        industry_family: familyLabel,
        sub_industry: enrichment.sub_industry,
        size: enrichment.size,
        size_confidence: enrichment.size_confidence,
        geography: enrichment.geography,
        angle: null,
        angle_label: null,
        reason: `Size ${enrichment.size} is above the ${rubric.company_size.max_employees}-employee maximum`,
        signals: [...signals, "size_above_max"],
        ...resolution,
        candidates: [],
      };
    }
  } else {
    signals.push("size_unverified");
  }

  // 6. Geography — only DQ when confidently non-US.
  if (
    enrichment.geography &&
    !isUSGeo(enrichment.geography, rubric.geography.allowed)
  ) {
    return {
      company: displayName,
      status: "NOT",
      industry: enrichment.industry,
      industry_family: familyLabel,
      sub_industry: enrichment.sub_industry,
      size: enrichment.size,
      size_confidence: enrichment.size_confidence,
      geography: enrichment.geography,
      angle: null,
      angle_label: null,
      reason: `Geography ${enrichment.geography} is not US`,
      signals: [...signals, "geography_non_us"],
      ...resolution,
      candidates: [],
    };
  }

  // 7. TARGET — primary angle from the family's first segment.
  const primary = primaryAngleForIndustry(rubric, enrichment.industry);
  const sizeBit =
    enrichment.size !== null
      ? `, ~${enrichment.size} employees${enrichment.size_confidence !== "high" ? " (unverified)" : ""}`
      : ", size unverified";
  const angleBit = primary ? ` → opening angle: ${primary.label}` : "";

  return {
    company: displayName,
    status: "TARGET",
    industry: enrichment.industry,
    industry_family: familyLabel,
    sub_industry: enrichment.sub_industry,
    size: enrichment.size,
    size_confidence: enrichment.size_confidence,
    geography: enrichment.geography,
    angle: primary?.angle ?? null,
    angle_label: primary?.label ?? null,
    reason: `${familyLabel} match${sizeBit}${angleBit}`,
    signals,
    ...resolution,
    candidates: [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function qualifyCompany(
  identifier: CompanyIdentifier,
): Promise<CompanyScreenResult> {
  const rubric = loadRubric();
  const enrichment = await enrichCompany(identifier, rubric);
  return applyCompanyRules(identifier, enrichment, rubric);
}

export interface ScreenCompaniesOptions {
  maxBatch?: number;
  concurrency?: number;
}

export interface ScreenCompaniesOutput {
  results: CompanyScreenResult[];
  skipped: string[]; // raw lines beyond the cap that we did NOT screen
}

// Caller passes already-parsed identifiers AND a parallel array of raw lines so
// we can echo the skipped originals to the user verbatim.
export async function screenCompanies(
  identifiers: CompanyIdentifier[],
  rawLines: string[],
  opts: ScreenCompaniesOptions = {},
): Promise<ScreenCompaniesOutput> {
  const max = opts.maxBatch ?? MAX_BATCH;
  const conc = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const toScreen = identifiers.slice(0, max);
  const skipped = rawLines.slice(max);

  const results = await pMap(toScreen, conc, async (identifier) => {
    try {
      return await qualifyCompany(identifier);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const label =
        identifier.name ??
        identifier.domain ??
        identifier.linkedin_slug ??
        "unknown";
      return {
        company: label,
        status: "NEEDS_INFO" as const,
        industry: null,
        industry_family: null,
        sub_industry: null,
        size: null,
        size_confidence: null,
        geography: null,
        angle: null,
        angle_label: null,
        reason: `Error during screening: ${message}`,
        signals: ["screening_error"],
        resolved_domain: null,
        resolved_via: null,
        match_confidence: null,
        candidates: [],
      };
    }
  });

  return { results, skipped };
}
