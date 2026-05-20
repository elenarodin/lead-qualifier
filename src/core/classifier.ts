import { callClaudeJson } from "./anthropic.js";
import {
  findOpeningAngleById,
  findSegmentById,
  industryIdsByBucket,
} from "./rubric.js";
import type {
  ClassifierOutput,
  ProfileData,
  Rubric,
  Tier,
} from "./types.js";

const VALID_TIERS: ReadonlySet<Tier> = new Set([
  "HOT",
  "WARM",
  "COLD",
  "DISQUALIFIED",
]);

// Compact, JSON-stable view of the rubric for the prompt. We include enough
// for Claude to pick a segment + tier + angle; we omit examples since they
// blow up the token count without helping classification.
function rubricBrief(rubric: Rubric): object {
  const ids = industryIdsByBucket(rubric);
  return {
    geography_allowed: rubric.geography.allowed,
    company_size: {
      min: rubric.company_size.min_employees,
      max: rubric.company_size.max_employees,
      ideal_band: rubric.company_size.ideal_band,
    },
    industries: ids,
    segments: rubric.segments.map((s) => ({
      id: s.id,
      label: s.label,
      criteria: s.criteria,
      default_angles: s.default_angles,
      notes: s.notes,
    })),
    opening_angles: rubric.opening_angles.map((a) => ({
      id: a.id,
      label: a.label,
      description: a.description,
      best_for: a.best_for,
      signals_that_strengthen: a.signals_that_strengthen,
    })),
    tier_signals_hot: [
      "Recent (last 90 days) post on denials, prior auth, claims AI, or audit readiness",
      "Active job posting for AI/platform/eng leadership",
      "Engaged with Lena's content (liked, commented, reposted)",
      "Recently announced funding with stated AI build plans",
      "Company size in ideal_band (80-300)",
      "Public post mentioning a Kombocode-relevant deadline (CMS-0057, HEDIS, AEP)",
      // pharma / biotech (1.5)
      "Recent post on clinical-trial AI, drug-discovery ML, GxP validation, or FDA submission tooling",
      "Hiring AI or platform leadership in a pharma/biotech context",
      "Public discussion of precision medicine, pharmacogenomics, or AI-assisted prescribing",
    ],
  };
}

const SYSTEM = `You are the Kombocode lead-qualifier classifier. Given a structured profile and the rubric, decide segment, tier, and opening angle.

Output a single JSON object with this exact shape:
{
  "segment": string | null,
  "segment_label": string | null,
  "tier": "HOT" | "WARM" | "COLD" | "DISQUALIFIED",
  "opening_angle": string | null,
  "opening_angle_label": string | null,
  "notes": string,
  "decision_rationale": string,
  "signals": string[]
}

Decision rules:
1. The profile may include an "industry" field. If present, treat it as authoritative — do not second-guess it. Match it against rubric segments via their criteria.industry. If absent, infer industry from the company/about text as before.
2. Pick exactly one segment ID from rubric.segments, or null if no segment fits well.
3. If the resolved industry is in the rubric's "excluded" bucket, set segment=null, tier="DISQUALIFIED", opening_angle=null. Notes should explain why (consumer health, pure provider, non-healthcare).
4. If the resolved industry is identifiable but NOT in any rubric bucket (e.g., "fintech", "aerospace"), set segment=null, tier="DISQUALIFIED" with notes "Industry outside Kombocode focus".
5. If a clear segment match exists, pick tier per rubric:
   - HOT = clean segment match + at least one strong signal present (recent relevant post, hiring AI/eng leadership, engaged with Lena's content, recent funding for AI build, size in 80-300, deadline mention, pharma/biotech signals like clinical-trial AI / drug-discovery ML / FDA tooling / precision medicine).
   - WARM = clean segment match, no strong signals.
   - COLD = borderline (uncertain segment, ambiguous title, stale signals, or company_size is unverified / unknown).
6. Opening angle: pick from the chosen segment's default_angles ONLY — never from outside that list. Prefer the angle whose signals_that_strengthen best match the profile signals. If no signal points elsewhere, pick the first listed default_angle. The payer-specific diagnostics (trace_any_denial, cms_0057_scorecard) are NOT in any pharma segment's default_angles — do not select them for pharma segments.
7. "notes": 1-2 lines in Lena's voice. Direct, no marketing language, no "great opportunity". Be specific about WHY this person matters or doesn't. If HOT, name the angle and why. If WARM, what would make them HOT. If COLD/DISQUALIFIED, one-line why.
8. "decision_rationale": 1-3 sentences explaining the tier + segment choice.
9. "signals": the observed signals (snake_case-ish strings) that drove the tier — e.g., "payer_tech_match", "ex_optum", "recent_cms_0057_post", "precision_medicine_signal".

If company_size is unverified (signals list will include "size_unverified") and the profile is otherwise a clean match, return WARM or COLD with a notes line that does not pretend you know the size — do NOT guess. Never HOT on size_sweet_spot when size is unverified.

Respond with raw JSON only. No prose. No fences.`;

function validate(parsed: unknown): ClassifierOutput {
  if (!parsed || typeof parsed !== "object") {
    throw new SyntaxError("Classifier output is not an object");
  }
  const o = parsed as Record<string, unknown>;
  const tier = o.tier;
  if (typeof tier !== "string" || !VALID_TIERS.has(tier as Tier)) {
    throw new SyntaxError(`Classifier returned invalid tier: ${String(tier)}`);
  }
  if (typeof o.notes !== "string" || typeof o.decision_rationale !== "string") {
    throw new SyntaxError("Classifier missing required string fields");
  }
  return {
    segment: typeof o.segment === "string" ? o.segment : null,
    segment_label: typeof o.segment_label === "string" ? o.segment_label : null,
    tier: tier as Tier,
    opening_angle:
      typeof o.opening_angle === "string" ? o.opening_angle : null,
    opening_angle_label:
      typeof o.opening_angle_label === "string" ? o.opening_angle_label : null,
    notes: o.notes,
    decision_rationale: o.decision_rationale,
    signals: Array.isArray(o.signals)
      ? o.signals.filter((s): s is string => typeof s === "string")
      : [],
  };
}

// Reconciles classifier output against the rubric — if the model named a segment
// or angle ID that doesn't exist, we null it out and fall back. Also fills in
// labels from the rubric (preferring the canonical label over whatever the
// model wrote).
function reconcileWithRubric(
  out: ClassifierOutput,
  rubric: Rubric,
): ClassifierOutput {
  let segment = out.segment;
  let segment_label = out.segment_label;
  let opening_angle = out.opening_angle;
  let opening_angle_label = out.opening_angle_label;

  if (segment) {
    const seg = findSegmentById(rubric, segment);
    if (seg) {
      segment_label = seg.label;
    } else {
      // Unknown segment ID — drop it.
      segment = null;
      segment_label = null;
    }
  }

  if (opening_angle) {
    const angle = findOpeningAngleById(rubric, opening_angle);
    if (angle) {
      opening_angle_label = angle.label;
    } else {
      opening_angle = null;
      opening_angle_label = null;
    }
  }

  return {
    ...out,
    segment,
    segment_label,
    opening_angle,
    opening_angle_label,
  };
}

export async function classifyLead(
  profile: ProfileData,
  rubric: Rubric,
): Promise<ClassifierOutput> {
  const userPayload = {
    profile,
    rubric: rubricBrief(rubric),
  };

  const raw = await callClaudeJson<unknown>({
    system: SYSTEM,
    user: JSON.stringify(userPayload, null, 2),
    maxTokens: 1024,
  });

  const validated = validate(raw);
  return reconcileWithRubric(validated, rubric);
}
