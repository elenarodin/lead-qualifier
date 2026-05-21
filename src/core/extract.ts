import { callClaudeJson } from "./anthropic.js";
import type { ProfileData } from "./types.js";

const SYSTEM = `You extract structured fields from raw LinkedIn-style profile text pasted by the user.

Output a single JSON object with this exact shape (no other keys):
{
  "name": string | null,
  "title": string | null,
  "company": string | null,
  "company_domain": string | null,
  "company_size": number | null,
  "geography": string | null,
  "industry": string | null,
  "sub_industry": string | null,
  "about": string | null,
  "signals": string[]
}

Rules:
- If a field is not present in the text, return null. Never fabricate. Critically: do NOT use external knowledge about the company. Only use what the paste literally says. A separate enrichment step uses model knowledge.
- "title" is the person's CURRENT primary role (e.g., "CTO", "VP Engineering"). Not past roles.
- "company" is the company name attached to the current role.
- "company_domain" is the company's primary website host (e.g. "zenpayer.com"), but ONLY if the paste contains it explicitly — a "Company website: example.com" line, a "linkedin.com/company/X" link, or a URL anywhere in the paste that clearly belongs to this employer. Strip scheme and "www.". Do NOT guess from the company name. Return null if not literally present.
- "company_size": the employee count as an integer, but ONLY when the paste contains an explicit employee count or range (e.g., "180 employees", "501-1000 employees"). Accept ranges by picking the lower bound. If the paste does NOT state a number, return null — do NOT use what you "know" about the company's size.
- "geography" is a country code or country name. If the text says "Greater Philadelphia Area" return "US". If it says "London, UK" return "UK". Use the PERSON's location as stated in the paste, not the company HQ.
- "industry": ONLY when the paste's About / company description directly describes what the company does at the BUCKET level (e.g., "we build claims AI for payers" → "payer tech"; "Industry: Health Tech" → "health tech"). Use lowercase short labels. DO NOT use the company name alone or external knowledge.
- "sub_industry": ONLY when the paste describes what the company does at a GRANULAR level — the specific product or vertical descriptor (e.g., "prior-auth automation for regional payers", "RWD/RWE analytics for life sciences", "AI-assisted prescribing"). This is more precise than "industry". Return null if the paste doesn't describe what the company does in granular terms.
- "about" is a 1-3 sentence distillation of their bio / about section, in their own words where possible. Null if no bio is present.
- "signals" is a short list of strings flagging notable things in the profile that may matter for tier scoring: recent posts on relevant topics, prior experience at named companies (e.g., "ex-Optum"), hiring posts, recent funding mentions, regulatory mentions (CMS-0057, HEDIS), engaged with relevant content, etc. Maximum 8 signals. Empty array if nothing notable.
- Respond with raw JSON only — no markdown fences, no commentary.`;

interface ExtractResponse {
  name?: string | null;
  title?: string | null;
  company?: string | null;
  company_domain?: string | null;
  company_size?: number | null;
  geography?: string | null;
  industry?: string | null;
  sub_industry?: string | null;
  about?: string | null;
  signals?: string[];
}

function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const stripped = s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0];
  // Sanity check: must look like a domain (has a dot, alphanumeric with hyphens).
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(stripped) ? stripped : null;
}

export async function extractProfile(profileText: string): Promise<ProfileData> {
  const result = await callClaudeJson<ExtractResponse>({
    system: SYSTEM,
    user: `Profile text:\n\n${profileText}`,
    maxTokens: 800,
  });

  const hasSize = typeof result.company_size === "number";
  const hasIndustry =
    typeof result.industry === "string" && result.industry.trim().length > 0;
  const hasSubIndustry =
    typeof result.sub_industry === "string" &&
    result.sub_industry.trim().length > 0;
  const domain = normalizeDomain(result.company_domain);

  return {
    name: result.name ?? null,
    title: result.title ?? null,
    company: result.company ?? null,
    company_domain: domain,
    company_size: hasSize ? (result.company_size as number) : null,
    size_source: hasSize ? "paste" : "unknown",
    size_confidence: hasSize ? "high" : null,
    geography: result.geography ?? null,
    industry: hasIndustry ? (result.industry as string).trim() : null,
    industry_source: hasIndustry ? "paste" : "unknown",
    industry_confidence: hasIndustry ? "high" : null,
    sub_industry: hasSubIndustry ? (result.sub_industry as string).trim() : null,
    about: result.about ?? null,
    signals: Array.isArray(result.signals) ? result.signals.slice(0, 8) : [],
  };
}
