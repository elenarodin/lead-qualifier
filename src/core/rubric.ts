import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  Rubric,
  RubricIndustry,
  RubricOpeningAngle,
  RubricSegment,
} from "./types.js";

let cached: Rubric | null = null;

export function loadRubric(path = "./rubric.yaml"): Rubric {
  if (cached) return cached;
  const raw = readFileSync(resolve(path), "utf8");
  const parsed = parseYaml(raw) as Rubric;
  cached = parsed;
  return parsed;
}

// Test-only reset hook
export function _resetRubricCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findIndustryById(
  rubric: Rubric,
  id: string,
): { industry: RubricIndustry; bucket: keyof Rubric["industries"] } | null {
  const buckets: (keyof Rubric["industries"])[] = [
    "core",
    "expanded",
    "excluded",
  ];
  for (const bucket of buckets) {
    const found = rubric.industries[bucket].find((i) => i.id === id);
    if (found) return { industry: found, bucket };
  }
  return null;
}

export function findSegmentById(
  rubric: Rubric,
  id: string,
): RubricSegment | null {
  return rubric.segments.find((s) => s.id === id) ?? null;
}

export function findOpeningAngleById(
  rubric: Rubric,
  id: string,
): RubricOpeningAngle | null {
  return rubric.opening_angles.find((a) => a.id === id) ?? null;
}

// For company-mode (1.7): given an industry ID, find the first segment whose
// criteria match that industry and return its first default_angle, plus the
// angle's human label. Returns null if there's no segment for the industry or
// if it has no angles configured. This is how company screening picks an
// opening angle without having a person/title — by data, the rubric's
// payer-diagnostic fence holds (pharma segments don't list those angles).
export function primaryAngleForIndustry(
  rubric: Rubric,
  industryId: string,
): { angle: string; label: string } | null {
  const seg = rubric.segments.find((s) => s.criteria.industry === industryId);
  if (!seg || seg.default_angles.length === 0) return null;
  const angleId = seg.default_angles[0];
  const angle = rubric.opening_angles.find((a) => a.id === angleId);
  if (!angle) return null;
  return { angle: angleId, label: angle.label };
}

// All industry IDs grouped by bucket — useful for the classifier prompt.
export function industryIdsByBucket(rubric: Rubric): {
  core: string[];
  expanded: string[];
  excluded: string[];
} {
  return {
    core: rubric.industries.core.map((i) => i.id),
    expanded: rubric.industries.expanded.map((i) => i.id),
    excluded: rubric.industries.excluded.map((i) => i.id),
  };
}
