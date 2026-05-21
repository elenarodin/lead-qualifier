---
name: kombocode-lead-qualifier
description: Qualifies a lead against the Kombocode ICP and returns a structured QualificationResult (tier, segment, opening angle, notes, disqualifier). Use this skill whenever Lena, Ross, or any team member asks to qualify a lead, check if a profile is ICP, score a prospect, or assign a segment — also when reviewing leads in bulk from a CSV, evaluating LinkedIn profiles for outbound fit, or deciding which Kombocode offer matches a buyer. Always consult `rubric.yaml` as the source of truth for ICP definition; this skill defines the workflow, the rubric defines the criteria.
---

# Kombocode Lead Qualifier

The brain behind Kombocode's lead qualification across Telegram, Slack, and any future surface. The job is simple: given a lead, decide whether they fit ICP, which segment they belong to, what tier they score, and which Kombocode offer is the right opening angle.

## When to invoke

Any of these triggers:

- "Qualify this lead" / "Is this person ICP?" / "Run this through the qualifier"
- A LinkedIn URL or profile text dropped into Telegram/Slack
- A CSV of monthly leads from Ross
- Any question that's effectively "should I reach out to this person?"

Do not invoke for:

- Existing pipeline contacts (Gopinath, Larry Trotter, Eugene Chan, Clinton Browning) — these are tracked elsewhere

## The rubric is the source of truth

Before classifying anything, read `rubric.yaml`. It defines:

- Industries (core / expanded / excluded)
- Title scope
- Geography and company size bounds
- Segments with IDs and criteria
- Opening angles with `best_for` segment mappings
- Tier criteria and signals
- Hard disqualifiers

When ICP changes, edit `rubric.yaml`. Do not encode ICP in this file. This file describes the workflow.

## Workflow

Three stages. Stop early if any stage produces a disqualifier.

### Stage 1: Hard rule check (deterministic, no LLM)

Check disqualifiers in order:

1. Geography is US? (use profile location, not headquarters fallback)
2. Company size in `[min_employees, max_employees]` band?
3. Industry is in `core` or `expanded`? (reject `excluded`)
4. Title is in `accept` list, not in `reject` list?

If any check fails → return `QualificationResult` with `tier: DISQUALIFIED` and populated `disqualifier` reason. Done.

Note: as of 1.5, pharma/biotech is a co-primary family in `core` alongside payer/managed-care — no longer auto-disqualified. The payer-specific diagnostics (`trace_any_denial`, `cms_0057_scorecard`) remain payer-only; pharma segments default to `production_stabilization` and `architect_and_build`.

### Stage 2: Segment classification (LLM)

Call Claude with the rubric's segment list and the lead's data (title, company, company description, about section, recent activity). Ask Claude to pick the single best segment ID.

Rules for the classifier:

- Pick exactly one segment, or `null` if no segment fits well enough
- If the company spans multiple segments (e.g., a health data platform that also does payer tech), pick the segment matching their primary product
- If the title doesn't make their role obvious, weight company > title
- Return reasoning in 1-2 sentences for `decision_rationale`

If the classifier returns `null` → `tier: DISQUALIFIED`, `disqualifier: "No segment match"`.

### Stage 3: Tier scoring + opening angle (LLM)

Once segment is assigned:

- Tier: classify HOT / WARM / COLD using rubric's tier criteria. Signals matter (recent posts on denial rates, CMS-0057 prep, hiring AI/eng roles, public engagement with Lena's content, regulatory event mentions).
- Opening angle: from the segment's `default_angles` in rubric, pick the strongest fit given the lead's specific signals. Default to the segment's first listed angle if no specific signal points elsewhere.
- Notes: generate a 1-2 line note in Lena's voice — what makes this person worth (or not worth) the conversation. No corporate-speak. Specific, not generic.

## Output schema

Every qualification returns this exact shape:

```typescript
type QualificationResult = {
  qualified: "PASS" | "REVIEW" | "FAIL";
  tier: "HOT" | "WARM" | "COLD" | "DISQUALIFIED";
  segment: string | null;          // segment ID from rubric, or null
  segment_label: string | null;    // human-readable
  opening_angle: string | null;    // angle ID from rubric
  opening_angle_label: string | null;
  notes: string;                   // 1-2 lines, Lena's voice
  disqualifier: string | null;     // null if qualified
  decision_rationale: string;      // 1-3 sentences explaining tier + segment choice
  signals: string[];               // observed signals that pushed the tier
};
```

`qualified` mapping:
- `PASS` = tier HOT or WARM
- `REVIEW` = tier COLD (borderline, Lena eyeballs)
- `FAIL` = tier DISQUALIFIED

## Examples

### Example 1: clean HOT

Input:
- Title: "CTO"
- Company: "ZenPayer Health"
- Company size: 180
- About: "Building prior authorization automation for regional payers. Previously platform lead at Optum."

Output:
```json
{
  "qualified": "PASS",
  "tier": "HOT",
  "segment": "payer_tech_cto",
  "segment_label": "Payer Tech CTO",
  "opening_angle": "trace_any_denial",
  "opening_angle_label": "Trace-Any-Denial Diagnostic",
  "notes": "CTO at a 180-person payer tech building PA automation. Ex-Optum platform lead means he speaks the language. Trace-Any-Denial is a direct fit — his product IS the denial workflow.",
  "disqualifier": null,
  "decision_rationale": "Perfect ICP — payer tech, CTO title, US, in size band. HOT because his product domain is denial automation, which is exactly what the diagnostic addresses.",
  "signals": ["payer tech industry match", "prior auth domain", "ex-Optum credibility"]
}
```

### Example 2: pharma WARM (clinical trial tech)

Input:
- Title: "VP Engineering"
- Company: "BioGenix Trial Platform"
- Company size: 220
- About: "Building eClinical workflow tooling for decentralized oncology trials."

Output:
```json
{
  "qualified": "PASS",
  "tier": "WARM",
  "segment": "clinical_trial_tech",
  "segment_label": "Clinical Trial Tech",
  "opening_angle": "production_stabilization",
  "opening_angle_label": "Production Stabilization Retainer",
  "notes": "VP Eng at a 220-person clinical trial platform. Right title, right industry, no public AI scar tissue yet — WARM for now. Single touch, not a sequence.",
  "disqualifier": null,
  "decision_rationale": "Clean clinical_trial_tech match: VP Engineering at a 220-employee trial-ops platform, size in ideal band. No strong recency signals → WARM.",
  "signals": ["clinical_trial_tech_match", "size_sweet_spot"]
}
```

### Example 3: size disqualifier

Input:
- Title: "CTO"
- Company: "HealthMega Insurance"
- Company size: 12000

Output:
```json
{
  "qualified": "FAIL",
  "tier": "DISQUALIFIED",
  "segment": null,
  "segment_label": null,
  "opening_angle": null,
  "opening_angle_label": null,
  "notes": "Enterprise scale (12k employees) — outside the 40-1000 sweet spot. Different buying motion, different cycle. Skip.",
  "disqualifier": "Company size 12000 exceeds max 1000",
  "decision_rationale": "Hard rule violation on company size.",
  "signals": []
}
```

## Company screening (1.7)

A second mode operates alongside person qualification: `/company` (or `/co`) followed by 1-10 company names, one per line. Use it to screen which companies fit ICP *before* anyone hunts a specific person at them.

Workflow per name:

1. **Enrich** the company by name (knowledge first; web search as fallback). Same enrichment primitive that person mode uses for missing data.
2. **Apply company-only rules** — no title check, no `excluded_contacts` check:
   - Industry confidently in rubric `excluded` bucket → ⛔ NOT
   - Industry identifiable but not in any rubric bucket (e.g. fintech) → ⛔ NOT
   - Industry not identifiable even after enrichment → ❓ NEEDS_INFO
   - Size confidently outside `[min_employees, max_employees]` → ⛔ NOT (high-confidence only — uncertain size never hard-fails, attach `size_unverified`)
   - Geography confidently non-US → ⛔ NOT (uncertain never fails)
   - Otherwise → ✅ TARGET
3. **Map to industry family + primary angle** for TARGETs: take the first segment matching the industry's ID, use its first `default_angles[]`. No person-level segment or title is assigned in company mode.

The payer-diagnostic fence is preserved by data, not code: pharma segments never list `trace_any_denial` or `cms_0057_scorecard` in their `default_angles`, so those diagnostics can only surface for payer/PBM family companies.

The `excluded_contacts` list (people already in pipeline) does **not** apply to company mode — that's a person-name filter, not a company filter.

Output shape (`CompanyScreenResult`) differs from `QualificationResult`: it carries `status` (TARGET/NOT/NEEDS_INFO) instead of `tier`, plus `industry_family`, suggested angle, size + size_confidence, geography, and a 1-2 sentence reason. No segment, no person-level fields.

## Edge cases

- **Stealth company or no public size:** if size cannot be determined from inputs, return `qualified: REVIEW` with `tier: COLD` and `notes` flagging the missing data. Do not guess.
- **Title is "Co-Founder" with no engineering signal:** check the about section. Co-Founder without a technical signal goes to REVIEW. Co-Founder + "previously eng lead at X" goes to PASS.
- **Recently left the company:** if `experience` shows the role ended <90 days ago, return REVIEW with a flag in notes — they may have already moved.
- **Multiple companies (advisor/board):** classify based on their primary current role, not advisory positions.
- **Wrong title (engineer, senior engineer, IC):** disqualify. We sell to decision-makers, not implementers.
- **CEO at a company with a CTO:** disqualify only if their LinkedIn shows no technical background. CEO/Founder with engineering history at a company without a separate CTO is PASS.

## Notes voice

Notes are written as if Lena is sketching a quick reaction for Ross or herself. Direct, no marketing language, no "this could be a great opportunity to discuss." Mention the specific reason this person matters or doesn't. If HOT, name the angle and why. If WARM, note what would make them HOT. If COLD or DISQUALIFIED, one-line why.

Bad notes (do not generate these):
- "Strong candidate for outreach given alignment with our ICP."
- "Could benefit from our diagnostic tool."
- "Recommended for follow-up sequence."

Good notes:
- "CTO at a payer tech doing PA automation. Trace-Any-Denial is literally his product surface. Reach now."
- "Right title, right industry, but his last post was 14 months ago. WARM — worth a single touch, not a sequence."
- "Director of Eng at a care mgmt SaaS that just raised. Too early to know if they have the AI scar tissue — REVIEW after one more signal."
