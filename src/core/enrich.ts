import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getAnthropicClient } from "./anthropic.js";
import { industryIdsByBucket } from "./rubric.js";
import type {
  CompanyIdentifier,
  ConfidenceLevel,
  DataSource,
  EnrichmentResult,
  MatchConfidence,
  ProfileData,
  ResolutionCandidate,
  ResolvedVia,
  Rubric,
} from "./types.js";

// Haiku 4.5 only supports the "direct" caller form (no programmatic tool
// calling), so we pin `allowed_callers` explicitly.
// 1.8: when a domain is provided we also pin `allowed_domains` so the model
// can only read pages on that specific domain — strongest possible anchor.
function buildWebSearchTool(
  allowedDomain: string | null,
): Anthropic.WebSearchTool20260209 {
  const tool: Anthropic.WebSearchTool20260209 = {
    type: "web_search_20260209",
    name: "web_search",
    allowed_callers: ["direct"],
    max_uses: 2,
  };
  if (allowedDomain) {
    tool.allowed_domains = [allowedDomain];
  }
  return tool;
}

const VALID_CONFIDENCE: ReadonlySet<ConfidenceLevel> = new Set([
  "high",
  "medium",
  "low",
]);

export interface EnrichCompanyHints {
  about?: string | null;
  title?: string | null;
  geography?: string | null;
}

// ---------------------------------------------------------------------------
// System / user prompt construction
// ---------------------------------------------------------------------------

function buildSystem(): string {
  return `You identify companies for the Kombocode lead-qualifier.

You may receive one of three identifier types:
- DOMAIN — the source of truth. Web search is restricted to that domain. Read what the company at that specific domain says about itself. Do NOT let a similarly-named company you remember from training override what this domain owns.
- LINKEDIN SLUG — entity anchor. Use a broad web search with the slug to identify the company. Do NOT attempt to scrape LinkedIn directly.
- BARE NAME — resolve by name using your knowledge first, then web search if you don't recognize it. If multiple distinct companies plausibly share this name, return them in "candidates" and do NOT silently pick one.

Output JSON (no other keys):
{
  "identified": boolean,
  "industry": string | null,
  "industry_confidence": "high" | "medium" | "low" | null,
  "sub_industry": string | null,
  "size": integer | null,
  "size_confidence": "high" | "medium" | "low" | null,
  "geography": string | null,
  "source": "knowledge" | "web" | "unknown",
  "resolved_domain": string | null,
  "resolved_via": "domain" | "linkedin" | "name",
  "match_confidence": "high" | "medium" | "low",
  "candidates": [{ "domain": string | null, "description": string }]
}

Resolution paths:
1. DOMAIN given → resolved_via="domain", match_confidence="high". resolved_domain echoes the input (lowercased, no scheme/www). candidates=[].
2. LINKEDIN SLUG given → resolved_via="linkedin", match_confidence="high" if found. resolved_domain is the company's actual website domain when known. candidates=[].
3. BARE NAME given:
   - Single confident match → resolved_via="name", match_confidence="high" or "medium". resolved_domain is the company's website if you know it. candidates=[].
   - Multiple distinct companies plausibly share this name → populate candidates with up to 3 entries (each { domain, description }) and set identified=true. Set industry=null in this case — do NOT pick one.
   - Truly unidentifiable → identified=false, source="unknown", all other fields null, candidates=[].

Field rules:
- "industry": prefer a rubric industry ID from the list provided. Else short lowercase free-text label (e.g. "fintech", "consumer retail").
- "sub_industry": ALWAYS set when identified=true and not ambiguous. Granular descriptor of what the company actually does (e.g. "prior-auth automation for payers", "PBM software", "RWD/RWE analytics for life sciences", "denial-trace AI for Medicaid MCOs"). NOT the rubric family — the granular truth.
- "size_confidence": "high" is rare (current authoritative public data). Default to "medium" or "low".
- "geography": "US" if US-based, else country name. null if uncertain.

Respond with raw JSON only — no prose, no markdown fences.`;
}

function buildUserMessage(
  identifier: CompanyIdentifier,
  rubric: Rubric,
  hints: EnrichCompanyHints,
): string {
  const ids = industryIdsByBucket(rubric);
  const allIds = [...ids.core, ...ids.expanded, ...ids.excluded];

  const parts: string[] = [];
  if (identifier.domain) {
    parts.push(`Identifier type: DOMAIN`);
    parts.push(`Domain: ${identifier.domain}`);
    if (identifier.name) parts.push(`Company name (if helpful): ${identifier.name}`);
    parts.push(`Web search is restricted to this domain. Read what the company at this domain says about itself.`);
  } else if (identifier.linkedin_slug) {
    parts.push(`Identifier type: LINKEDIN SLUG`);
    parts.push(`Slug: ${identifier.linkedin_slug}`);
    if (identifier.name) parts.push(`Company name (if helpful): ${identifier.name}`);
    parts.push(
      `Use a broad web search with the slug "${identifier.linkedin_slug}" or the URL "linkedin.com/company/${identifier.linkedin_slug}" to identify the company. Do not scrape LinkedIn directly.`,
    );
  } else if (identifier.name) {
    parts.push(`Identifier type: BARE NAME`);
    parts.push(`Company name: ${identifier.name}`);
    parts.push(
      `If you can think of more than one distinct company under this name, populate "candidates" with each (do NOT pick a single industry).`,
    );
  } else {
    parts.push(`Identifier type: NONE`);
    parts.push(`(no name, no domain, no slug — return identified=false)`);
  }

  if (hints.title) parts.push(`Title (for person-mode context): ${hints.title}`);
  if (hints.geography)
    parts.push(`Person geography (for context): ${hints.geography}`);
  if (hints.about) {
    parts.push(`About / paste excerpt:`);
    parts.push(hints.about);
  }
  parts.push("");
  parts.push(`Rubric industry IDs to prefer when applicable:`);
  parts.push(JSON.stringify(allIds));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

function extractAnswerText(content: Anthropic.ContentBlock[]): string | null {
  let lastToolIdx = -1;
  for (let i = 0; i < content.length; i++) {
    const t = content[i].type;
    if (t === "server_tool_use" || t === "web_search_tool_result") {
      lastToolIdx = i;
    }
  }
  const parts: string[] = [];
  for (let i = lastToolIdx + 1; i < content.length; i++) {
    const block = content[i];
    if (block.type === "text") parts.push(block.text);
  }
  if (parts.length === 0) {
    for (const block of content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function findFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function safeConfidence(v: unknown): ConfidenceLevel | null {
  return typeof v === "string" && VALID_CONFIDENCE.has(v as ConfidenceLevel)
    ? (v as ConfidenceLevel)
    : null;
}

function safeMatchConfidence(v: unknown): MatchConfidence | null {
  return typeof v === "string" && VALID_CONFIDENCE.has(v as MatchConfidence)
    ? (v as MatchConfidence)
    : null;
}

function safeSource(v: unknown): EnrichmentResult["source"] {
  if (v === "knowledge" || v === "web" || v === "unknown") return v;
  return "unknown";
}

function safeResolvedVia(v: unknown): ResolvedVia {
  if (v === "domain" || v === "linkedin" || v === "name") return v;
  return "name";
}

function normalizeDomain(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // Strip scheme + www, drop everything after the first slash
  const stripped = s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0];
  return stripped.length > 0 ? stripped : null;
}

function safeCandidates(v: unknown): ResolutionCandidate[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (c): c is Record<string, unknown> => typeof c === "object" && c !== null,
    )
    .map((c) => ({
      domain:
        typeof c.domain === "string" && c.domain.trim().length > 0
          ? normalizeDomain(c.domain)
          : null,
      description:
        typeof c.description === "string" ? c.description.trim() : "",
    }))
    .filter((c) => c.description.length > 0 || c.domain !== null)
    .slice(0, 3);
}

function validate(parsed: unknown, fallbackVia: ResolvedVia): EnrichmentResult {
  if (!parsed || typeof parsed !== "object") {
    throw new SyntaxError("Enrichment output is not an object");
  }
  const o = parsed as Record<string, unknown>;
  return {
    identified: o.identified === true,
    industry:
      typeof o.industry === "string" && o.industry.trim().length > 0
        ? o.industry.trim()
        : null,
    industry_confidence: safeConfidence(o.industry_confidence),
    sub_industry:
      typeof o.sub_industry === "string" && o.sub_industry.trim().length > 0
        ? o.sub_industry.trim()
        : null,
    size: typeof o.size === "number" && Number.isFinite(o.size) ? o.size : null,
    size_confidence: safeConfidence(o.size_confidence),
    geography:
      typeof o.geography === "string" && o.geography.trim().length > 0
        ? o.geography.trim()
        : null,
    source: safeSource(o.source),
    resolved_domain:
      typeof o.resolved_domain === "string"
        ? normalizeDomain(o.resolved_domain)
        : null,
    resolved_via: o.resolved_via ? safeResolvedVia(o.resolved_via) : fallbackVia,
    match_confidence: safeMatchConfidence(o.match_confidence),
    candidates: safeCandidates(o.candidates),
  };
}

// Map a free-text industry label to a rubric ID when possible (case-insensitive
// match on either the ID or the label). Unrecognized labels pass through as-is
// so callers (classifier, company-mode rules) can decide what to do with them.
export function normalizeIndustryToRubricId(
  rawIndustry: string,
  rubric: Rubric,
): string {
  const target = rawIndustry.toLowerCase().trim();
  for (const bucket of ["core", "expanded", "excluded"] as const) {
    for (const ind of rubric.industries[bucket]) {
      if (ind.id.toLowerCase() === target) return ind.id;
      if (ind.label.toLowerCase() === target) return ind.id;
    }
  }
  return rawIndustry;
}

// ---------------------------------------------------------------------------
// Underlying primitive — one Haiku call with web_search.
// ---------------------------------------------------------------------------

function emptyResult(fallbackVia: ResolvedVia): EnrichmentResult {
  return {
    identified: false,
    industry: null,
    industry_confidence: null,
    sub_industry: null,
    size: null,
    size_confidence: null,
    geography: null,
    source: "unknown",
    resolved_domain: null,
    resolved_via: fallbackVia,
    match_confidence: null,
    candidates: [],
  };
}

export async function enrichCompany(
  identifier: CompanyIdentifier,
  rubric: Rubric,
  hints: EnrichCompanyHints = {},
): Promise<EnrichmentResult> {
  // Determine resolution path / fallback `via`.
  const fallbackVia: ResolvedVia = identifier.domain
    ? "domain"
    : identifier.linkedin_slug
      ? "linkedin"
      : "name";

  // Without any identifier at all, nothing to enrich.
  if (!identifier.name && !identifier.domain && !identifier.linkedin_slug) {
    return emptyResult(fallbackVia);
  }

  const allowedDomain = identifier.domain
    ? normalizeDomain(identifier.domain)
    : null;

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: buildSystem(),
    tools: [buildWebSearchTool(allowedDomain)],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: buildUserMessage(identifier, rubric, hints),
      },
    ],
  });

  const finalText = extractAnswerText(response.content);
  if (process.env.DEBUG_ENRICH === "1") {
    const label =
      identifier.domain ??
      identifier.linkedin_slug ??
      identifier.name ??
      "(none)";
    // eslint-disable-next-line no-console
    console.error(
      `[enrich:${label}] stop=${response.stop_reason} blocks=${response.content.map((b) => b.type).join(",")} text=${finalText?.slice(0, 500)}`,
    );
  }
  if (!finalText) return emptyResult(fallbackVia);

  const fenceless = stripFences(finalText);
  const candidate = (() => {
    try {
      JSON.parse(fenceless);
      return fenceless;
    } catch {
      return findFirstJsonObject(fenceless);
    }
  })();
  if (!candidate) return emptyResult(fallbackVia);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return emptyResult(fallbackVia);
  }

  const enrichment = validate(parsed, fallbackVia);

  // Normalize the industry to a rubric ID when possible.
  if (enrichment.industry) {
    enrichment.industry = normalizeIndustryToRubricId(
      enrichment.industry,
      rubric,
    );
  }

  // For domain-anchored calls, force the resolved_domain to match the input
  // (the model occasionally echoes a slightly different form).
  if (identifier.domain && enrichment.identified) {
    enrichment.resolved_domain =
      enrichment.resolved_domain ?? allowedDomain ?? null;
    enrichment.resolved_via = "domain";
    enrichment.match_confidence = enrichment.match_confidence ?? "high";
  }

  return enrichment;
}

// Person-mode wrapper: enriches a ProfileData, honoring the merge rule — only
// fill fields the paste left null, never overwrite paste-derived data.
export async function enrichProfile(
  profile: ProfileData,
  rubric: Rubric,
): Promise<ProfileData> {
  if (!profile.company && !profile.company_domain) return profile;

  const enrichment = await enrichCompany(
    {
      name: profile.company,
      domain: profile.company_domain,
      linkedin_slug: null, // person mode doesn't parse LinkedIn slugs from the paste
    },
    rubric,
    {
      about: profile.about,
      title: profile.title,
      geography: profile.geography,
    },
  );

  const out: ProfileData = { ...profile };
  const enrichSource: DataSource =
    enrichment.source === "web" ? "web" : "knowledge";

  if (
    out.industry == null &&
    enrichment.identified &&
    enrichment.industry !== null
  ) {
    out.industry = enrichment.industry;
    out.industry_source = enrichSource;
    out.industry_confidence = enrichment.industry_confidence;
  }

  if (out.sub_industry == null && enrichment.sub_industry !== null) {
    out.sub_industry = enrichment.sub_industry;
  }

  if (out.company_size == null && enrichment.size !== null) {
    out.company_size = enrichment.size;
    out.size_source = enrichSource;
    out.size_confidence = enrichment.size_confidence;
  }

  if (out.geography == null && enrichment.geography !== null) {
    out.geography = enrichment.geography;
  }

  if (out.company_domain == null && enrichment.resolved_domain !== null) {
    out.company_domain = enrichment.resolved_domain;
  }

  return out;
}
