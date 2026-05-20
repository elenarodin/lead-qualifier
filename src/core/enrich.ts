import type Anthropic from "@anthropic-ai/sdk";
import { CLAUDE_MODEL, getAnthropicClient } from "./anthropic.js";
import { industryIdsByBucket } from "./rubric.js";
import type {
  ConfidenceLevel,
  DataSource,
  ProfileData,
  Rubric,
} from "./types.js";

// Server-side web search tool. Verified at type level — see
// node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts.
// max_uses keeps cost bounded; the model decides per call whether to invoke.
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

interface EnrichmentResponse {
  identified: boolean;
  industry: string | null;
  industry_confidence: ConfidenceLevel | null;
  size: number | null;
  size_confidence: ConfidenceLevel | null;
  geography: string | null;
  source: "knowledge" | "web" | "unknown";
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

function buildUserMessage(profile: ProfileData, rubric: Rubric): string {
  const ids = industryIdsByBucket(rubric);
  const allIds = [...ids.core, ...ids.expanded, ...ids.excluded];
  const parts = [
    `Company: ${profile.company ?? "(unknown — cannot enrich without a company name)"}`,
    `Title (for context): ${profile.title ?? "(unknown)"}`,
    `Person geography (for context): ${profile.geography ?? "(unknown)"}`,
    `About / paste excerpt:`,
    profile.about ?? "(none)",
    ``,
    `Rubric industry IDs to prefer when applicable:`,
    JSON.stringify(allIds),
  ];
  return parts.join("\n");
}

// Pulls the last text block out of the response, accepting any content layout
// (the API may emit interleaved tool_use / tool_result / text blocks).
function extractFinalText(content: Anthropic.ContentBlock[]): string | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "text") return block.text;
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

function safeSource(v: unknown): EnrichmentResponse["source"] {
  if (v === "knowledge" || v === "web" || v === "unknown") return v;
  return "unknown";
}

function validate(parsed: unknown): EnrichmentResponse {
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
// so the classifier can decide what to do with them.
function normalizeIndustryToRubricId(
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

export async function enrichProfile(
  profile: ProfileData,
  rubric: Rubric,
): Promise<ProfileData> {
  // Nothing to enrich without a company name.
  if (!profile.company) return profile;

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
        content: buildUserMessage(profile, rubric),
      },
    ],
  });

  const finalText = extractFinalText(response.content);
  if (!finalText) {
    // No text block came back — treat as unidentified, leave profile unchanged.
    return profile;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(finalText));
  } catch {
    return profile;
  }

  const enrichment = validate(parsed);

  // Honor the merge rule: only fill fields that the paste left null. Never
  // overwrite paste-derived data.
  const out: ProfileData = { ...profile };
  const enrichSource: DataSource = enrichment.source === "web" ? "web" : "knowledge";

  if (
    out.industry == null &&
    enrichment.identified &&
    enrichment.industry !== null
  ) {
    out.industry = normalizeIndustryToRubricId(enrichment.industry, rubric);
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
