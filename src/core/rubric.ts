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
