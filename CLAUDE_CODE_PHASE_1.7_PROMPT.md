# Build Prompt: Kombocode Lead Qualifier — Phase 1.7

Paste into Claude Code (project dir) after this file is in the folder. Phase 1.6 is **deployed and live**; this adds a new mode without changing person qualification.

---

You are extending the **deployed** Kombocode Lead Qualifier. This is **Phase 1.7**: add a **company screening mode** alongside the existing person qualification. Workflow intent: screen companies for ICP fit *first*, then qualify a specific person at the companies that pass. Both modes coexist; person mode must remain unchanged.

## Read first — before editing

Read the live files and confirm:
- `./src/core/qualify.ts`, `enrich.ts`, `rules.ts`, `classifier.ts`, `types.ts`
- `./src/adapters/telegram.ts`
- `./src/db/schema.ts`, `./src/db/queries.ts`
- `./src/version.ts`, `./SKILL.md`, `./rubric.yaml`

**Stop Point #1** — present the change plan, the exact company-rule decision table, and where `qualifyCompany` / `screenCompanies` slot into the pipeline. Wait for approval.

---

## Change 1 — Company screening mode (new)

New command **`/company`** (alias **`/co`**) followed by **1-10 company names, one per line**. Default text paste remains person qualification, untouched.

### Behavior per company (no person, no title)

1. **Enrich** the company by name (reuse `enrich.ts`; refactor it to be callable standalone with just a company name and no person context). Get industry, size, size_confidence, geography, source (knowledge|web|unknown). Web search fires only when Claude doesn't recognize the company.
2. **Company-level rules** (no title checks at all):
   - Industry *confidently* in rubric `excluded` → **⛔ NOT** (reason).
   - Size *confidently* outside [40, 1000] → **⛔ NOT** (reason). Uncertain/unknown size **NEVER** fails — attach `size_unverified`.
   - Geography *confidently* non-US → **⛔ NOT**. Uncertain never fails.
   - Industry not determinable even after enrich → **❓ NEEDS_INFO**.
   - Otherwise → **✅ TARGET**.
3. For **TARGET**: map to the rubric **industry family** and suggest that family's **primary angle** (first in its `default_angles`). The payer-diagnostic fence still holds: payer/PBM families may suggest `trace_any_denial` / `cms_0057_scorecard`; pharma families get `production_stabilization` / `architect_and_build` — never a diagnostic. No person-level segment or title is assigned.
4. `excluded_contacts` (a person-name list) does **NOT** apply to company mode — we're screening companies, not people.

### Core additions

- `qualifyCompany(name: string): Promise<CompanyScreenResult>`
- `screenCompanies(names: string[]): Promise<CompanyScreenResult[]>` — bounded concurrency (max ~3-4 in flight), cap input at 10 (if more provided, screen the first 10 and note the rest were skipped).

## Change 2 — Types

```typescript
type CompanyScreenResult = {
  company: string;
  status: "TARGET" | "NOT" | "NEEDS_INFO";
  industry: string | null;
  industry_family: string | null;   // rubric family label
  size: number | null;
  size_confidence: "high" | "medium" | "low" | null;
  geography: string | null;
  angle: string | null;              // angle id, TARGET only
  angle_label: string | null;
  reason: string;                    // why TARGET/NOT/NEEDS_INFO, 1-2 sentences
  signals: string[];
};
```

## Change 3 — Persistence

- Add a discriminator to the `leads` table: `type TEXT NOT NULL DEFAULT 'person'`. Company screens insert with `type='company'`, `name=NULL`, `title=NULL`, `company=<name>`, `company_size=<size or null>`, `result_json=<CompanyScreenResult>`.
- `/recent`, `/why`, and `/feedback` work across both types. `/why <id>` detects the record type and renders the appropriate card. Feedback table is unchanged (keyed by `lead_id`).

## Change 4 — Telegram

- `/company` and `/co` handler: parse the lines after the command into names, cap 10, send a progress ping (`🔍 Screening N companies…`), run `screenCompanies`, then reply with a compact summary:
  ```
  Screened 4 companies — 2 ✅ targets, 1 ⛔ out, 1 ❓ unknown

  1. ✅ ZenPayer Health · Payer Tech · ~180 emp → Trace-Any-Denial   (id 20)
  2. ✅ Welkin · Care Mgmt SaaS · ~90 emp → Stabilization            (id 21)
  3. ⛔ Acme Retail · consumer retail — not ICP                       (id 22)
  4. ❓ Stealthco · couldn't identify                                 (id 23)

  /why <id> to expand · /feedback to flag
  ```
  Mark `size_unverified` inline (e.g. `size 1000+ ⚠️ verify`). Escape MarkdownV2 specials in company names.
- `/why <id>` for a company record → full card: status, industry + family, size + confidence, geography, suggested angle, reasoning, enrichment source — with 👍 / 👎 buttons (same feedback flow as person cards).
- **Cost firewall:** `/company` reachable only after the access gate. Unauthorized users get the gate reply and trigger zero LLM calls and zero web searches.
- Update `/start` and `/help` to document `/company` (one line: "Screen 1-10 companies for ICP fit — `/company` then one name per line").

## Change 5 — SKILL.md

Add a "Company screening" section documenting the variant: company-only rules (industry / size / geography / excluded — no title), family→angle mapping, the TARGET / NOT / NEEDS_INFO outcomes, the same payer-diagnostic fence, and that the person-name `excluded_contacts` list does not apply here.

## Change 6 — Version

Bump `VERSION` to `"1.7.0"`. Update startup log and `/version`.

---

## Stop points

1. After reading live files — plan + company-rule decision table + pipeline placement. Wait.
2. After core (`qualifyCompany` / `screenCompanies`) built — run the company test cases below, show results. Wait.
3. After Telegram + version + full validation. Wait. (Deploy handled separately.)

## Company test cases (Stop Point #2)

1. Known payer tech (e.g. Cohere Health) → ✅ TARGET, payer family, `trace_any_denial`, via knowledge (no web search).
2. Obscure small health-data startup → web search → ✅ TARGET (or ❓ if truly unidentifiable); size flagged if uncertain.
3. Consumer retail company → ⛔ NOT (excluded industry).
4. A clinical-trial-tech / pharma company → ✅ TARGET, pharma family, `production_stabilization` (NOT a diagnostic — fence intact).
5. Giant payer (e.g. UnitedHealth, >1000 employees) → ⛔ NOT on size, per the current 40-1000 band. **Flag this in your Stop Point #2 report** so Lena can confirm it's intended (see note below).
6. Unidentifiable name → ❓ NEEDS_INFO.
7. Batch of 1 and batch of 10 both work; >10 handled gracefully.
8. Person mode (paste a profile) still works unchanged.

## Out of scope for 1.7 — do NOT do

- Mixed person+company batches (separate modes)
- CSV / file upload
- Clay or Proxycurl integration
- Slack adapter, HubSpot sync

## Validation checklist — done when ALL pass

- [ ] `npm run build` clean, no `any` in `src/core/`
- [ ] `/company` screens 1-10 names, returns compact summary with assigned IDs
- [ ] TARGET / NOT / NEEDS_INFO logic correct; uncertain size and uncertain geography NEVER hard-fail
- [ ] Payer/PBM targets may suggest diagnostics; pharma targets get build/stabilization (fence intact)
- [ ] `/why <id>` expands a company record with 👍/👎; `/feedback` includes company down-votes
- [ ] Unauthorized user triggers zero LLM/search on `/company` (verify in logs)
- [ ] Person mode unchanged; prior behavior intact
- [ ] `/version` returns `1.7.0`; `/start` and `/help` mention `/company`

## Begin

Read the live files, then present (1) the change plan, (2) the exact company-rule decision table, (3) where `qualifyCompany` and `screenCompanies` slot into the pipeline. Wait for approval. (Stop Point #1.)
