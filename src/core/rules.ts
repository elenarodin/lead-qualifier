import type { ProfileData, Rubric, RulesResult } from "./types.js";

// Director-level titles need a 250+ employee company per rubric.
const DIRECTOR_TITLE_RE = /\bdirector\b/i;

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function titleMatchesList(title: string, list: string[]): boolean {
  const t = normalize(title);
  if (!t) return false;
  return list.some((entry) => {
    const e = normalize(entry);
    if (!e) return false;
    return t === e || t.includes(e);
  });
}

// Hard-rule disqualifiers — deterministic, no LLM. Industry checks are NOT
// done here: industry resolution requires LLM judgment, so the classifier
// handles industry-based DQ (excluded bucket) downstream.
//
// 1.6 changes:
// - Size DQ is gated on size_confidence === "high". Anything weaker becomes
//   a soft `size_unverified` signal and continues to the classifier.
// - Geography DQ requires the geography field to be present at all (unknown
//   geography → soft `geography_unverified`, continues).
// - Director-at-sub-250 DQ also requires high-confidence size.
export function applyRules(profile: ProfileData, rubric: Rubric): RulesResult {
  const signals: string[] = [];

  // Geography — only DQ when confidently known to be non-US.
  if (profile.geography) {
    const geo = normalize(profile.geography);
    const allowedNormalized = rubric.geography.allowed.map(normalize);
    const isUS =
      geo === "us" ||
      geo === "usa" ||
      geo === "united states" ||
      geo === "united states of america" ||
      allowedNormalized.includes(geo);
    if (!isUS) {
      return {
        pass: false,
        disqualifier: `Profile location is ${profile.geography}, not US`,
      };
    }
  } else {
    signals.push("geography_unverified");
  }

  // Size — only DQ on high-confidence out-of-band. Anything else is soft.
  const sizeKnown =
    profile.company_size !== null && profile.company_size !== undefined;
  const sizeIsHighConfidence = profile.size_confidence === "high";
  if (sizeKnown && sizeIsHighConfidence) {
    const { min_employees, max_employees } = rubric.company_size;
    const size = profile.company_size as number;
    if (size < min_employees) {
      return {
        pass: false,
        disqualifier: `Company size ${size} below min ${min_employees}`,
      };
    }
    if (size > max_employees) {
      return {
        pass: false,
        disqualifier: `Company size ${size} exceeds max ${max_employees}`,
      };
    }
  } else {
    // Unknown size OR size_confidence < high → soft flag, continue.
    signals.push("size_unverified");
  }

  // Title — reject list is hard. Missing title falls through (classifier handles).
  if (profile.title) {
    if (titleMatchesList(profile.title, rubric.titles.reject)) {
      return {
        pass: false,
        disqualifier: `Title '${profile.title}' is too junior or not a decision-maker`,
      };
    }

    // Director-level only valid at 250+ employee orgs — only enforce when
    // we're confident about the size.
    if (
      DIRECTOR_TITLE_RE.test(profile.title) &&
      sizeKnown &&
      sizeIsHighConfidence &&
      (profile.company_size as number) < 250
    ) {
      return {
        pass: false,
        disqualifier: `Director-level title at sub-250 company — too tactical for our buyer`,
      };
    }
  }

  return { pass: true, signals };
}
