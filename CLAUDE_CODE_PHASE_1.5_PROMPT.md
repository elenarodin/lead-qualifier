# Build Prompt: Kombocode Lead Qualifier — Phase 1.5

Paste into the existing Claude Code session (or start a new one in the project directory) after this file is in the project folder.

---

You are extending the **already-built** Kombocode Lead Qualifier (Phase 1 is complete and working). This is **Phase 1.5**: four changes to prepare for a multi-user deployment where the founder (Lena) and a teammate (Ross) both use the bot, with Ross giving feedback.

## Read first — before editing anything

Work against the **live files in this project directory**, not from memory. Read these now:

- `./rubric.yaml` — current ICP (may have been modified since first draft)
- `./SKILL.md` — current workflow spec
- `./src/adapters/telegram.ts` — current bot
- `./src/config.ts` — current env parsing
- `./src/db/schema.ts` and `./src/db/queries.ts` — current persistence

Confirm you've read them before proposing changes. **This is Stop Point #1** — present your change plan and wait for approval before editing.

---

## Change 1 — Pharma/biotech becomes a co-primary industry family

Currently pharma/biotech is in an `existing_only` bucket and auto-disqualified. **Reverse this.** Pharma/biotech is now a full co-primary family alongside payer/managed care, with equal outbound status.

### In `rubric.yaml`:

1. **Restructure `industries`:** `core` now contains BOTH families — the existing payer/managed-care industries AND the pharma/biotech industries. Move `pharma_regulatory_tech` (and any pharma industry) from `existing_only` into `core`.
2. **Delete the `existing_only` industry category entirely.**
3. **Add these pharma/biotech segments** to `segments` (mirror the structure of the existing payer segments):

   - `pharma_tech_cto` — "Pharma/Biotech Tech CTO" — CTO/VP Eng/Head of Platform at pharma or biotech companies (digital, IT, R&D tech). Angles: `[production_stabilization, architect_and_build]`
   - `clinical_trial_tech` — "Clinical Trial Tech" — CTO/VP Eng at clinical trial platforms, eClinical, trial-operations tech. Angles: `[production_stabilization, architect_and_build]`
   - `pharma_ai_data` — "Pharma AI/Data Leader" — Head of AI/Data/ML, Chief Data Officer at pharma/biotech. Angles: `[architect_and_build, production_stabilization]`
   - `clinical_ai_precision_medicine` — "Clinical AI / Precision Medicine" — pharmacogenomics, AI-assisted prescribing, precision medicine, AI diagnostics product companies. Angles: `[production_stabilization, architect_and_build, eugene_partnership]`
   - `pharma_regulatory_tech` — "Pharma Regulatory/Quality Tech" — regulatory, compliance, quality, GxP tech for pharma (Veeva/Medidata type). Angles: `[architect_and_build, production_stabilization]`

4. **Delete the `industry_existing_only` disqualifier** from the `disqualifiers` list.
5. **Add 2-3 pharma-relevant HOT signals** to the `tiers.HOT.strong_signals` list, e.g.: recent post on clinical-trial AI / drug-discovery ML / GxP validation / FDA submission tooling; hiring AI or platform leadership in a pharma/biotech context.
6. **Leave unchanged:** company size (40-1000), geography (US), titles, `excluded` industries, `excluded_contacts`, the payer segments, the payer-specific angles (`trace_any_denial`, `cms_0057_scorecard`).

### In `SKILL.md`:

1. Remove the Stage 1 special-case that auto-disqualifies pharma/biotech as `existing_only`.
2. Remove `existing_only` language from the segment list and examples.
3. Update or remove Example 2 (the BioGenix `existing_only` example) — replace it with a pharma example that now PASSES (e.g., a clinical-trial-tech CTO landing WARM/HOT with `production_stabilization` or `architect_and_build`).

### Important boundary to preserve:

The payer-specific diagnostics (`trace_any_denial`, `cms_0057_scorecard`) must still **only** be selectable for payer/managed-care segments. Pharma segments get `production_stabilization` and `architect_and_build`. Both families are co-primary; the diagnostics are simply payer-specific tools.

### Verify:

Re-run the qualifier on a pharmacogenomics / AI-prescribing profile (the kind that previously hit `existing_only`). It must now return PASS (WARM or HOT) with a pharma segment and a build/stabilization angle — NOT disqualified.

---

## Change 2 — Replace single-user whitelist with an access-code gate

Currently the bot whitelists one hardcoded `AUTHORIZED_TELEGRAM_USER_ID`. Replace with self-registration via a shared access code.

### Behavior:

- New env var: `ACCESS_CODE` (a shared secret string). Remove the old `AUTHORIZED_TELEGRAM_USER_ID`.
- New DB table:
  ```sql
  CREATE TABLE IF NOT EXISTS authorized_users (
    telegram_user_id  TEXT PRIMARY KEY,
    display_name      TEXT,
    registered_at     TEXT NOT NULL
  );
  ```
- On every incoming message, check if `from.id` exists in `authorized_users`:
  - **Authorized** → proceed normally.
  - **Not authorized:**
    - If the message text **exactly equals** `ACCESS_CODE` → insert them into `authorized_users` (capture their Telegram first name / username as `display_name`), reply with a friendly "You're in!" + the paste instructions.
    - Otherwise → reply: *"This bot is private. Send the access code to get started."* and **make NO Anthropic API call** (cost protection — unauthorized users must never trigger an LLM call).

### Notes:

- Registration is permanent (row persists). A user_id can be removed by deleting its row manually — no admin command needed in this phase.
- This is a small trusted team; do not build role hierarchies.

---

## Change 3 — Feedback capture (tappable buttons)

Every qualification card gets an inline keyboard with two buttons: 👍 and 👎.

### Behavior:

- Attach an inline keyboard (Telegraf `Markup.inlineKeyboard`) to each qualification card with callback buttons `👍` and `👎`, carrying the lead id (e.g., callback data `fb:up:<leadId>` / `fb:down:<leadId>`).
- New DB table:
  ```sql
  CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL,
    user_id     TEXT NOT NULL,
    vote        TEXT NOT NULL,        -- 'up' | 'down'
    note        TEXT,
    created_at  TEXT NOT NULL
  );
  ```
- On 👍 / 👎 tap: record the vote (lead_id, the tapping user's id, vote), answer the callback with a small toast ("Thanks — noted 👍"), and edit the card's buttons to show the recorded vote so it's clear it registered.
- On 👎 specifically: after recording, send a follow-up message *"Want to add a reason? Reply to this message with it."* If the user replies, store it as the `note` on the most recent down-vote for that lead by that user.
- New command `/feedback [n=10]` → lists the most recent down-voted qualifications: lead name, who voted it down, the note (if any), and the original tier/segment/angle. This is the tuning queue.

### Why:

This is the loop: Ross qualifies leads, thumbs-down the ones that feel wrong, optionally notes why; `/feedback` shows the founder exactly what to tune in `rubric.yaml`.

---

## Change 4 — Version string

- Add a `VERSION` constant (start at `"1.5.0"`) in a single place (e.g., `src/version.ts`).
- Log it on startup: `[info] Kombocode Qualifier v1.5.0 starting…`
- Show it in the footer of the `/start` message.
- Add `/version` command that returns the running version.

This lets the team know which build is live as we ship frequently.

---

## Change 5 — Config, env, README

- `src/config.ts`: add `ACCESS_CODE` (required), remove `AUTHORIZED_TELEGRAM_USER_ID`. Fail fast at startup if `ACCESS_CODE` is missing.
- `.env.example`: document the new var set — `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `ACCESS_CODE`, `DB_PATH`, `LOG_LEVEL`.
- `README.md`: add a short "Access code" section explaining how a new user self-registers, and a "Versioning" note (bump `VERSION` on each meaningful change before deploy).

---

## Stop points — pause for approval

1. **After reading the live files** — present the change plan, wait for approval.
2. **After Change 1 (pharma) is applied and the pharma test profile flips to PASS** — show the before/after qualification, wait for approval before continuing.
3. **After all changes built and the validation checklist passes locally** — summarize, wait. (Deployment is handled separately, not in this session.)

---

## Out of scope for Phase 1.5 — do NOT do

- Fly deployment (handled in a separate guided sequence)
- Webhooks (still polling)
- Bulk CSV, Slack adapter, scraping
- Admin roles / per-user permission tiers beyond the access gate
- HubSpot sync

---

## Validation checklist — Phase 1.5 done when ALL pass

- [ ] `npm run build` clean, no TS errors, no `any` in `src/core/`
- [ ] Pharma/precision-medicine test profile returns PASS (not disqualified) with a pharma segment + build/stabilization angle
- [ ] A payer profile still returns a payer segment and can still receive `trace_any_denial` / `cms_0057_scorecard`
- [ ] An unauthorized user sending random text gets the "send the access code" reply and triggers NO Anthropic call (verify in logs)
- [ ] Sending the correct `ACCESS_CODE` registers the user and unlocks qualification
- [ ] A qualification card shows 👍 / 👎 buttons; tapping records a row in `feedback` and updates the card
- [ ] 👎 prompts for a reason; replying stores the note
- [ ] `/feedback` lists recent down-votes with notes
- [ ] `/version` returns `1.5.0`; startup log shows the version
- [ ] `.env.example` and README reflect the new `ACCESS_CODE` var

## Begin

Read the live files, then present (1) a concise change plan and (2) the specific edits you'll make to `rubric.yaml` and `SKILL.md` for the pharma restructure. Wait for approval. (Stop Point #1.)
