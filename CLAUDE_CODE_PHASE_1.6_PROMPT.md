# Build Prompt: Kombocode Lead Qualifier — Phase 1.6

Paste into Claude Code (project dir) after this file is in the folder. Phase 1.5 is **deployed and live**; this extends it.

---

You are extending the **deployed** Kombocode Lead Qualifier. This is **Phase 1.6**, addressing one root problem: pasted LinkedIn *person* profiles often lack the *company's* industry and size, so the qualifier wrongly disqualifies good leads. Two fixes: (A) correct the disqualification semantics, (B) add a tiered company-lookup step (Claude knowledge → web search).

## Read first — before editing

Read the live files and confirm:

- `./src/core/qualify.ts`, `extract.ts`, `rules.ts`, `classifier.ts`, `types.ts`
- `./src/adapters/telegram.ts`
- `./src/version.ts`
- `./SKILL.md`, `./rubric.yaml`

**This is Stop Point #1** — present your change plan, including the exact revised disqualifier logic and where the enrichment step slots into the pipeline. Wait for approval.

---

## Change 1 — Correctness: missing data must not wrongly disqualify

Current behavior wrongly returns ⛔️ DISQUALIFIED when company industry/size are absent. Fix the decision logic in `rules.ts` / `qualify.ts`:

- **Size:** Disqualify on size ONLY when size is *confidently known* AND outside [40, 1000]. If size is null/uncertain → **do NOT disqualify**; attach a `size_unverified` signal and continue. (This restores the original SKILL.md spec.)
- **Geography:** Disqualify ONLY when *confidently known* to be non-US. Unknown geography → soft flag, continue.
- **Industry — excluded:** Disqualify when *confidently known* to be in the rubric's `excluded` list (genuine non-fit).
- **Industry — unknown:** If industry cannot be determined even after enrichment (Change 2) → return the new **NEEDS_INFO** outcome, NOT DISQUALIFIED. These are semantically different: DISQUALIFIED = "not a fit, don't reach out"; NEEDS_INFO = "couldn't identify the company."

## Change 2 — Tiered company enrichment (knowledge → web search)

Add a new core step, e.g. `src/core/enrich.ts`, invoked from `qualify.ts` **only when** `industry` or `company_size` is missing after `extract`. This keeps cost/latency conditional.

### How it works (single Claude call, model lets the tiers happen naturally):

- Make ONE Claude call (Haiku 4.5) with the **web search tool enabled**. Verify the current web-search tool identifier from the installed `@anthropic-ai/sdk` rather than hardcoding a version string.
- Instruct the model: given the company name + any context from the paste, determine (1) the company's industry/sector — map toward the rubric's industry families when applicable, (2) approximate US employee count, (3) whether US-based — and a confidence (`high|medium|low`) for each. **Use your own knowledge first; only search the web if you don't recognize the company.** If the company genuinely cannot be identified, return `identified: false`.
- Return structured: `{ identified, industry, industry_confidence, size, size_confidence, geography, source: 'knowledge'|'web'|'unknown' }`.
- **Merge rule:** only fill fields that were null from the paste — never overwrite data the paste already provided.

### Pipeline order in `qualify.ts`:

```
extract → (if industry||size missing) enrich → applyRules → (if not disqualified/needs_info) classify
```

### Cost firewall (must preserve):

Enrichment + web search must be reachable ONLY after the access-gate auth passes. An unauthorized user must trigger zero LLM calls and zero searches.

## Change 3 — Size guardrail

Never let a *guessed, searched, or low-confidence* size hard-disqualify — web/knowledge employee counts are often stale. Only `size_confidence: high` AND clearly out-of-band fails on size. Otherwise attach `size_unverified` and let the lead through to classification (it can still be WARM/REVIEW; it just can't earn the `size_sweet_spot` HOT signal).

## Change 4 — Output schema + types

- Add `NEEDS_INFO` to the `qualified` union (now `PASS | REVIEW | FAIL | NEEDS_INFO`).
- Add to `ProfileData`/result as needed: `industry`, `industry_source` (`paste|knowledge|web|unknown`), `size_source`, `size_confidence`.
- Add signals where relevant: `size_unverified`, `industry_via_web`, `company_unidentified`.
- `NEEDS_INFO` results carry `tier: null`, `segment: null`, and a `decision_rationale` naming what's missing.

## Change 5 — Telegram cards

- **NEEDS_INFO card** (use ❓): e.g.
  ```
  ❓ NEED MORE INFO — [Name]

  Couldn't identify [Company]'s industry, even after a web lookup. Reply with the company's industry + rough headcount (or paste its About section) and re-send, and I'll finish qualifying.
  ```
- **size_unverified:** on a normal card, mark the company line, e.g. `CTO @ ZenPayer Health (size unverified)`.
- **Interim feedback:** when enrichment runs a web search (which adds latency), send a brief interim message or chat action (e.g. "🔍 Looking up [Company]…") so the bot doesn't feel hung. Remove/ignore it once the card is sent.
- Keep the existing 👍/👎 feedback buttons on PASS/REVIEW/FAIL cards. NEEDS_INFO cards do not need vote buttons.

## Change 6 — Version

Bump `VERSION` to `"1.6.0"`. Update startup log and `/version`.

---

## Stop points

1. After reading live files — present change plan + revised disqualifier logic + pipeline placement. Wait.
2. After Changes 1-4 built — run the core test cases below and show results. Wait.
3. After Telegram cards + version done and full local validation passes — summarize. Wait. (Deploy handled separately.)

## Core test cases (run at Stop Point #2)

1. Known company, no size in paste (e.g. a CTO "at athenahealth", no size) → enrichment via **knowledge** → PASS with correct segment, NOT disqualified.
2. Obscure small company not in training data → enrichment triggers **web search** → industry filled, size flagged `size_unverified` → REVIEW/WARM, NOT ⛔️.
3. Genuinely unidentifiable company (stealth, no web presence) → **NEEDS_INFO**, NOT DISQUALIFIED.
4. Clearly out-of-ICP industry (e.g. a consumer retail company) → still **DISQUALIFIED** (genuine non-fit).
5. The earlier pharmacogenomics / precision-medicine lead → still **PASS** (pharma co-primary intact).
6. A payer profile → still gets a payer segment and can still receive `trace_any_denial` / `cms_0057_scorecard`.
7. Null size alone (industry known, in-band unknown) → never disqualifies on size.

## Out of scope for 1.6 — do NOT do

- Clay / Proxycurl integration (web search only this phase)
- Interactive "pending company-context" re-run state machine (the NEEDS_INFO card just asks the user to re-paste with company details)
- Scraping, bulk CSV, Slack adapter, HubSpot sync

## Validation checklist — done when ALL pass

- [ ] `npm run build` clean, no `any` in `src/core/`
- [ ] Null/uncertain size never causes DISQUALIFIED
- [ ] "Can't identify company" returns NEEDS_INFO, never DISQUALIFIED
- [ ] Genuine out-of-ICP industry still returns DISQUALIFIED
- [ ] Enrichment runs ONLY when industry/size missing, and ONLY post-auth (no LLM/search for unauthorized users — verify in logs)
- [ ] Web search fires only when Claude doesn't recognize the company (verify a known company does NOT trigger a search)
- [ ] All 7 core test cases pass
- [ ] NEEDS_INFO card renders; size_unverified marked; interim "looking up" feedback shows during a search
- [ ] `/version` returns `1.6.0`

## Deploy note (after local sign-off)

No new Fly secrets needed — web search uses the existing `ANTHROPIC_API_KEY`. Deploy is just `fly deploy` from the project dir once local tests pass. (There is a small per-search cost; it only fires when a company isn't recognized.)

## Begin

Read the live files, then present the change plan + the exact revised disqualifier decision table + where `enrich` slots into `qualify.ts`. Wait for approval. (Stop Point #1.)
