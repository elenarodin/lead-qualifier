import { classifyLead } from "./classifier.js";
import { enrichProfile } from "./enrich.js";
import { extractProfile } from "./extract.js";
import { applyRules } from "./rules.js";
import { loadRubric } from "./rubric.js";
import type {
  ClassifierOutput,
  ProfileData,
  QualificationResult,
  Qualified,
  Tier,
} from "./types.js";

const MIN_PROFILE_LENGTH = 50;

export class TooShortError extends Error {
  constructor() {
    super("Profile text too short to qualify");
    this.name = "TooShortError";
  }
}

function qualifiedFromTier(tier: Tier): Qualified {
  if (tier === "HOT" || tier === "WARM") return "PASS";
  if (tier === "COLD") return "REVIEW";
  return "FAIL";
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function disqualifyResult(args: {
  disqualifier: string;
  notes: string;
  decision_rationale: string;
  segment?: string | null;
  segment_label?: string | null;
  signals?: string[];
}): QualificationResult {
  return {
    qualified: "FAIL",
    tier: "DISQUALIFIED",
    segment: args.segment ?? null,
    segment_label: args.segment_label ?? null,
    opening_angle: null,
    opening_angle_label: null,
    notes: args.notes,
    disqualifier: args.disqualifier,
    decision_rationale: args.decision_rationale,
    signals: args.signals ?? [],
  };
}

function needsInfoResult(
  profile: ProfileData,
  extraSignals: string[],
): QualificationResult {
  const co = profile.company ?? "this company";
  return {
    qualified: "NEEDS_INFO",
    tier: null,
    segment: null,
    segment_label: null,
    opening_angle: null,
    opening_angle_label: null,
    notes: `Couldn't identify ${co}'s industry, even after a web lookup. Reply with the company's industry + rough headcount (or paste its About section) and re-send, and I'll finish qualifying.`,
    disqualifier: null,
    decision_rationale: `Industry could not be determined for ${co} after extraction and enrichment.`,
    signals: dedupe([
      "company_unidentified",
      ...extraSignals,
      ...profile.signals,
    ]),
  };
}

function mergeClassifier(
  c: ClassifierOutput,
  extraSignals: string[],
): QualificationResult {
  const isDQ = c.tier === "DISQUALIFIED";
  return {
    qualified: qualifiedFromTier(c.tier),
    tier: c.tier,
    segment: c.segment,
    segment_label: c.segment_label,
    opening_angle: isDQ ? null : c.opening_angle,
    opening_angle_label: isDQ ? null : c.opening_angle_label,
    notes: c.notes,
    disqualifier: isDQ ? c.decision_rationale : null,
    decision_rationale: c.decision_rationale,
    signals: dedupe([...c.signals, ...extraSignals]),
  };
}

export interface QualifyOptions {
  profile?: ProfileData; // bypass extraction (testing)
  rubricPath?: string;
  // Fires when the pipeline enters the enrichment branch. The Telegram adapter
  // uses this to edit the "Qualifying…" ack into "🔍 Looking up [Company]…" so
  // the bot doesn't feel hung while Claude does its lookup.
  onEnrichStart?: (company: string | null) => Promise<void> | void;
}

export async function qualifyLead(
  profileText: string,
  opts: QualifyOptions = {},
): Promise<{ profile: ProfileData; result: QualificationResult }> {
  if (profileText.trim().length < MIN_PROFILE_LENGTH) {
    throw new TooShortError();
  }

  const rubric = loadRubric(opts.rubricPath);

  // Stage 1: extract
  let profile = opts.profile ?? (await extractProfile(profileText));

  // Stage 1b (1.6): enrich when industry or size is missing. Skip for tests
  // that supply a fully-populated `opts.profile`.
  let enrichRan = false;
  if (profile.industry == null || profile.company_size == null) {
    enrichRan = true;
    if (opts.onEnrichStart) await opts.onEnrichStart(profile.company);
    profile = await enrichProfile(profile, rubric);
  }

  // Signals derived from the orchestration step (not from rules/classifier).
  const orchSignals: string[] = [];
  if (profile.industry_source === "web") orchSignals.push("industry_via_web");

  // Stage 2: deterministic rules. May surface soft signals (size_unverified,
  // geography_unverified) which we fold into the final result.
  const rules = applyRules(profile, rubric);
  if (!rules.pass) {
    return {
      profile,
      result: disqualifyResult({
        disqualifier: rules.disqualifier,
        notes: rules.disqualifier,
        decision_rationale: `Hard rule violation: ${rules.disqualifier}.`,
        signals: dedupe([...orchSignals, ...profile.signals]),
      }),
    };
  }

  // Stage 2b (1.6): NEEDS_INFO when enrichment ran but the company is still
  // unidentified. Distinct from DISQUALIFIED — different downstream UX.
  if (enrichRan && profile.industry == null) {
    return {
      profile,
      result: needsInfoResult(profile, [...orchSignals, ...rules.signals]),
    };
  }

  // Stage 3: LLM classifier (segment + tier + angle + notes + rationale).
  const classified = await classifyLead(profile, rubric);
  return {
    profile,
    result: mergeClassifier(classified, [...rules.signals, ...orchSignals]),
  };
}
