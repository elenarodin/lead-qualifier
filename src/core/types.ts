// ---------------------------------------------------------------------------
// Provenance: where a field came from + how sure we are. Introduced in 1.6 so
// downstream code (rules, classifier, telegram card) can treat paste-derived
// data, model-knowledge data, and web-search data differently — most importantly
// so a low-confidence employee count never hard-disqualifies a real lead.
// ---------------------------------------------------------------------------
export type ConfidenceLevel = "high" | "medium" | "low";
export type DataSource = "paste" | "knowledge" | "web" | "unknown";

// ---------------------------------------------------------------------------
// Profile data — extracted from raw paste text by Stage 1 (extract.ts) and
// optionally filled in by Stage 1b (enrich.ts) when industry/size are missing.
// ---------------------------------------------------------------------------
export interface ProfileData {
  name: string | null;
  title: string | null;
  company: string | null;
  company_size: number | null;
  size_source: DataSource;
  size_confidence: ConfidenceLevel | null;
  geography: string | null;
  industry: string | null; // rubric industry ID when matched, else free-text label
  industry_source: DataSource;
  industry_confidence: ConfidenceLevel | null;
  about: string | null;
  signals: string[];
}

// ---------------------------------------------------------------------------
// Hard-rules outcome (Stage 2 — rules.ts). On pass we also surface any soft
// flags (e.g., size_unverified) so the orchestrator can fold them into the
// final result.
// ---------------------------------------------------------------------------
export type RulesResult =
  | { pass: true; signals: string[] }
  | { pass: false; disqualifier: string };

// ---------------------------------------------------------------------------
// Classifier output (Stage 3 — classifier.ts, LLM)
// ---------------------------------------------------------------------------
export type Tier = "HOT" | "WARM" | "COLD" | "DISQUALIFIED";
export type Qualified = "PASS" | "REVIEW" | "FAIL" | "NEEDS_INFO";

export interface ClassifierOutput {
  segment: string | null;
  segment_label: string | null;
  tier: Tier;
  opening_angle: string | null;
  opening_angle_label: string | null;
  notes: string;
  decision_rationale: string;
  signals: string[];
}

// ---------------------------------------------------------------------------
// Final qualification result. As of 1.6: `tier` is nullable because NEEDS_INFO
// outcomes carry no tier (we couldn't identify the company well enough to
// place one). `qualified === "NEEDS_INFO"` is the canonical check; tier-null
// without NEEDS_INFO is never produced by the pipeline.
// ---------------------------------------------------------------------------
export interface QualificationResult {
  qualified: Qualified;
  tier: Tier | null;
  segment: string | null;
  segment_label: string | null;
  opening_angle: string | null;
  opening_angle_label: string | null;
  notes: string;
  disqualifier: string | null;
  decision_rationale: string;
  signals: string[];
}

// ---------------------------------------------------------------------------
// Company screening (1.7) — output shape for `/company` mode. Distinct from
// QualificationResult: no person-level tier/segment/angle is assigned; only
// the industry family and the family's primary angle.
// ---------------------------------------------------------------------------
export type CompanyStatus = "TARGET" | "NOT" | "NEEDS_INFO";

export interface CompanyScreenResult {
  company: string;
  status: CompanyStatus;
  industry: string | null;          // rubric industry ID when matched, else free-text label
  industry_family: string | null;   // rubric industry's human label
  size: number | null;
  size_confidence: ConfidenceLevel | null;
  geography: string | null;
  angle: string | null;              // rubric opening_angle ID — TARGET only
  angle_label: string | null;
  reason: string;                    // 1-2 sentences explaining the status
  signals: string[];
}

// Raw output of the enrich step — exported so the company-mode primitive
// (`enrichCompany`) can return it directly to callers that don't need a
// ProfileData wrapper.
export interface EnrichmentResult {
  identified: boolean;
  industry: string | null;
  industry_confidence: ConfidenceLevel | null;
  size: number | null;
  size_confidence: ConfidenceLevel | null;
  geography: string | null;
  source: "knowledge" | "web" | "unknown";
}

// ---------------------------------------------------------------------------
// Rubric — typed shape of rubric.yaml. Only the fields we read are declared.
// ---------------------------------------------------------------------------
export interface RubricIndustry {
  id: string;
  label: string;
  description?: string;
  examples?: string[];
}

export interface RubricIndustries {
  core: RubricIndustry[];
  expanded: RubricIndustry[];
  excluded: RubricIndustry[];
}

export interface RubricTitles {
  accept: string[];
  reject: string[];
  notes?: string;
}

export interface RubricSegment {
  id: string;
  label: string;
  criteria: {
    industry?: string;
    title_includes?: string[];
  };
  default_angles: string[];
  notes?: string;
}

export interface RubricOpeningAngle {
  id: string;
  label: string;
  description?: string;
  best_for: string[];
  signals_that_strengthen?: string[];
  notes?: string;
}

export interface RubricGeography {
  allowed: string[];
  notes?: string;
}

export interface RubricCompanySize {
  min_employees: number;
  max_employees: number;
  ideal_band: [number, number];
  notes?: string;
}

export interface Rubric {
  version: number;
  last_updated: string;
  owner: string;
  geography: RubricGeography;
  company_size: RubricCompanySize;
  industries: RubricIndustries;
  titles: RubricTitles;
  segments: RubricSegment[];
  opening_angles: RubricOpeningAngle[];
}
