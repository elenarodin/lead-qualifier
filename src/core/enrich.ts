import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getAnthropicClient } from "./anthropic.js";
import { industryIdsByBucket } from "./rubric.js";
import type {
  ConfidenceLevel,
  DataSource,
  EnrichmentResult,
  ProfileData,
  Rubric,
} from "./types.js";

// Server-side web search tool. Verified at type level — see
// node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts.
// max_uses keeps cost bounded; the model decides per call whether to invoke.
//
// Haiku 4.5 only supports the "direct" caller form (no programmatic tool
// calling), so we pin `allowed_callers` explicitly. Without this the API
// returns 400.
const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20260209 = {
  type: "web_search_20260209",
  name: "web_search",
  allowed_callers: ["direct"],
  max_uses: 2,
};

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

function buildSystem(): string {
  return `You identify companies for the Kombocode lead-qualifier.

Output a single JSON object (no other keys):
{
  "identified": boolean,
  "industry": string | null,
  "industry_confidence": "high" | "medium" | "low" | null,
  "size": integer | null,
  "size_confidence": "high" | "medium" | "low" | null,
  "geography": string | null,
  "source": "knowledge" | "web" | "unknown"
}

Process:
1. Use your training knowledge FIRST. Only invoke the web_search tool if you do NOT recognize the company from its name + context. Do not search for companies you already know — that wastes a call.
2. If you recognize it from training → set source="knowledge".
3. If you must search and the search succeeds → set source="web".
4. If you genuinely cannot identify the company even after searching → set identified=false, source="unknown", all other fields null.

Field rules:
- "industry": prefer a rubric industry ID from the list provided in the user message when the company clearly fits one. If the company is identifiable but outside the rubric's families (e.g., a fintech or consumer-goods company), return a short lowercase label like "fintech" or "consumer goods".
- "industry_confidence":
  - "high" = well-known company, public profile, unambiguous fit
  - "medium" = fairly confident
  - "low" = educated guess
- "size": approximate US employee count, integer. Use the most recent figure you have.
- "size_confidence":
  - "high" = current and authoritative (rare from training data alone)
  - "medium" = roughly right within ~2x
  - "low" = old data, ranges, or a search snippet that may be stale
  Headcounts shift fast — when in doubt, choose "medium" or "low".
- "geography": "US" if US-based, else country code or country name. null if uncertain.

Respond with raw JSON only — no prose, no markdown fences.`;
}

function buildUserMessage(
  company: string,
  rubric: Rubric,
  hints: EnrichCompanyHints,
): string {
  const ids = industryIdsByBucket(rubric);
  const allIds = [...ids.core, ...ids.expanded, ...ids.excluded];
  const parts = [`Company: ${company}`];
  if (hints.title) parts.push(`Title (for context): ${hints.title}`);
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

// When the model uses server-side tools (web_search), the response is a mix
// of `server_tool_use`, `web_search_tool_result`, and `text` blocks. The
// model's actual answer is spread across the text blocks *after* the last
// tool result — earlier text blocks are "thinking out loud" between searches.
// We concatenate the answer-phase text and pull a JSON object out of it.
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
    // No tools at all (knowledge path) — just concatenate all text blocks.
    for (const block of content) {
      if (block.type === "text") parts.push(block.text);
    }
  }
  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

// Scan a string for the first balanced top-level JSON object and return it.
// Handles cases where the model wraps JSON in prose or fences without first
// having to escape them. Returns the raw object substring or null.
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

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function safeConfidence(v: unknown): ConfidenceLevel | null {
  return typeof v === "string" && VALID_CONFIDENCE.has(v as ConfidenceLevel)
    ? (v as ConfidenceLevel)
    : null;
}

function safeSource(v: unknown): EnrichmentResult["source"] {
  if (v === "knowledge" || v === "web" || v === "unknown") return v;
  return "unknown";
}

function validate(parsed: unknown): EnrichmentResult {
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
    size: typeof o.size === "number" && Number.isFinite(o.size) ? o.size : null,
    size_confidence: safeConfidence(o.size_confidence),
    geography:
      typeof o.geography === "string" && o.geography.trim().length > 0
        ? o.geography.trim()
        : null,
    source: safeSource(o.source),
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

// Underlying primitive: one Haiku call with web_search, returning a structured
// EnrichmentResult. Used by both person mode (wrapped via enrichProfile) and
// company mode (called directly with just a name).
export async function enrichCompany(
  company: string,
  rubric: Rubric,
  hints: EnrichCompanyHints = {},
): Promise<EnrichmentResult> {
  const trimmed = company.trim();
  if (!trimmed) {
    return {
      identified: false,
      industry: null,
      industry_confidence: null,
      size: null,
      size_confidence: null,
      geography: null,
      source: "unknown",
    };
  }

  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: buildSystem(),
    tools: [WEB_SEARCH_TOOL],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: buildUserMessage(trimmed, rubric, hints),
      },
    ],
  });

  const finalText = extractAnswerText(response.content);
  if (process.env.DEBUG_ENRICH === "1") {
    // eslint-disable-next-line no-console
    console.error(
      `[enrich:${trimmed}] stop=${response.stop_reason} blocks=${response.content.map((b) => b.type).join(",")} text=${finalText?.slice(0, 500)}`,
    );
  }
  if (!finalText) {
    return {
      identified: false,
      industry: null,
      industry_confidence: null,
      size: null,
      size_confidence: null,
      geography: null,
      source: "unknown",
    };
  }

  let parsed: unknown;
  // Try the stripped-fence whole-string parse first; fall back to scanning for
  // an embedded JSON object when the model wraps JSON in prose.
  const fenceless = stripFences(finalText);
  const candidate = (() => {
    try {
      JSON.parse(fenceless);
      return fenceless;
    } catch {
      return findFirstJsonObject(fenceless);
    }
  })();
  if (!candidate) {
    return {
      identified: false,
      industry: null,
      industry_confidence: null,
      size: null,
      size_confidence: null,
      geography: null,
      source: "unknown",
    };
  }
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      identified: false,
      industry: null,
      industry_confidence: null,
      size: null,
      size_confidence: null,
      geography: null,
      source: "unknown",
    };
  }

  const enrichment = validate(parsed);

  // Normalize industry to a rubric ID when possible so downstream consumers
  // can do equality checks against rubric.industries IDs.
  if (enrichment.industry) {
    enrichment.industry = normalizeIndustryToRubricId(
      enrichment.industry,
      rubric,
    );
  }

  return enrichment;
}

// Person-mode wrapper: enriches a ProfileData, honoring the merge rule — only
// fill fields the paste left null, never overwrite paste-derived data.
export async function enrichProfile(
  profile: ProfileData,
  rubric: Rubric,
): Promise<ProfileData> {
  if (!profile.company) return profile;

  const enrichment = await enrichCompany(profile.company, rubric, {
    about: profile.about,
    title: profile.title,
    geography: profile.geography,
  });

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

  if (out.company_size == null && enrichment.size !== null) {
    out.company_size = enrichment.size;
    out.size_source = enrichSource;
    out.size_confidence = enrichment.size_confidence;
  }

  if (out.geography == null && enrichment.geography !== null) {
    out.geography = enrichment.geography;
  }

  return out;
}
