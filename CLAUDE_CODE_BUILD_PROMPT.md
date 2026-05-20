# Build Prompt: Kombocode Lead Qualifier — Phase 1 (Telegram)

Paste this into Claude Code in an empty directory that contains `SKILL.md` and `rubric.yaml`.

---

You are scaffolding **Phase 1** of the Kombocode Lead Qualifier — a personal Telegram bot that qualifies LinkedIn leads against the Kombocode ICP using a hybrid pipeline (deterministic hard rules + Claude LLM classifier).

## Read first — before writing any code

Two canonical files in this directory:

- `./SKILL.md` — workflow spec (3-stage qualifier pipeline + output schema)
- `./rubric.yaml` — ICP source of truth (segments, disqualifiers, opening angles)

Load both into context before doing anything. If they're not present, stop and ask the user to provide them.

## Stack

- **Language:** TypeScript (strict mode, no `any` in `src/core/`)
- **Runtime:** Node 22 LTS
- **Package manager:** pnpm
- **Bot:** `telegraf`
- **LLM:** `@anthropic-ai/sdk`, model `claude-haiku-4-5-20251001` for both extraction and classification
- **DB:** `better-sqlite3` (file-based, lives at `./data/qualifier.db`)
- **YAML:** `yaml`
- **Config:** `dotenv`
- **Deploy target:** Fly.io (write `fly.toml` but do **not** deploy in this session)

## File structure

```
kombocode-qualifier/
├── src/
│   ├── core/
│   │   ├── qualify.ts       # qualifyLead() entry point — orchestrates the 3 stages
│   │   ├── extract.ts       # Profile text → structured ProfileData (Claude call)
│   │   ├── rules.ts         # Hard disqualifiers (deterministic, no LLM)
│   │   ├── classifier.ts    # Segment + tier + angle + notes (Claude call)
│   │   ├── rubric.ts        # Loads rubric.yaml as typed object, exposes lookups
│   │   └── types.ts         # ProfileData, QualificationResult, Rubric types
│   ├── adapters/
│   │   └── telegram.ts      # Telegraf bot setup + handlers
│   ├── db/
│   │   ├── schema.ts        # SQLite migration (runs on startup)
│   │   └── queries.ts       # CRUD helpers
│   └── index.ts             # App entry, wires everything
├── data/                     # gitignored, SQLite lives here
├── SKILL.md                  # canonical workflow
├── rubric.yaml               # canonical ICP
├── .env.example
├── .gitignore
├── fly.toml
├── tsconfig.json
├── package.json
└── README.md
```

## Behaviors

### Telegram bot

- Whitelisted to `AUTHORIZED_TELEGRAM_USER_ID` from env. Other Telegram users get a polite *"This bot is private."* reply.
- Handles these inputs:
  - **Any DM > 50 chars** → treat as profile text → run `qualifyLead` → reply with formatted card
  - **`/start`** → short hello + paste instructions
  - **`/recent [n=5]`** → last n qualifications (id, name, tier, segment)
  - **`/why <id>`** → full `decision_rationale` + `signals` for that qualification
  - **`/help`** → command list
- A DM containing a LinkedIn URL alongside profile text → store the URL in the `linkedin_url` column, but do not attempt to fetch it. URL is metadata only in Phase 1.

### Output card format (Telegram MarkdownV2)

```
🔥 HOT — Payer Tech CTO

*Jane Doe* — CTO @ ZenPayer Health (180 employees)

→ Angle: Trace-Any-Denial Diagnostic

_CTO at a 180-person payer tech building PA automation. Ex-Optum platform lead — speaks the language. Trace-Any-Denial is a direct fit; her product IS the denial workflow._

Signals: payer_tech_match, prior_auth_domain, ex_optum

ID: 47 — reply /why 47 for reasoning
```

Tier emojis: HOT 🔥, WARM 🌤, COLD ❄️, DISQUALIFIED ⛔️

Escape MarkdownV2 special characters in user-derived strings.

### Qualifier core

Implement the 3-stage pipeline from SKILL.md with **graceful degradation** on missing fields:

1. **`extract(profileText)`** → Claude call → `ProfileData { name, title, company, company_size?, geography?, about?, signals[] }`. Missing fields are `null` (or `undefined`), never fabricated.
2. **`applyRules(profile, rubric)`** → deterministic. Returns `{ pass: true }` or `{ pass: false, disqualifier: string }`. **Important:** if `company_size` is `null`, do NOT disqualify on size — fall through.
3. **`classify(profile, rubric)`** → Claude call. Returns `{ segment, segment_label, tier, opening_angle, opening_angle_label, notes, decision_rationale, signals }`.

Final `qualifyLead(profileText)` returns the full `QualificationResult` from SKILL.md.

Both Claude calls use **JSON mode** (response_format) for structured outputs. Validate the parsed JSON against the expected shape; on parse failure, retry once with a stricter instruction before throwing.

### Persistence (SQLite)

```sql
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text      TEXT    NOT NULL,
  linkedin_url  TEXT,
  name          TEXT,
  title         TEXT,
  company       TEXT,
  company_size  INTEGER,
  qualified_at  TEXT    NOT NULL,  -- ISO 8601
  result_json   TEXT    NOT NULL,  -- full QualificationResult
  source        TEXT    NOT NULL DEFAULT 'telegram',
  source_user_id TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_qualified_at ON leads(qualified_at DESC);
```

Schema is intentionally future-proof: `source` and `source_user_id` let the Slack adapter slot in without migrations.

### Env vars

`.env.example` documents:
- `TELEGRAM_BOT_TOKEN`
- `ANTHROPIC_API_KEY`
- `AUTHORIZED_TELEGRAM_USER_ID`
- `DB_PATH` (default `./data/qualifier.db`)
- `LOG_LEVEL` (default `info`)

## Stop points — ask the user before continuing

1. **After listing the planned file tree** — confirm structure before scaffolding
2. **After `src/core/` is built and unit-tested on a sample profile** — let the user paste a test profile, verify the qualification before wiring Telegram
3. **After bot connects to Telegram and round-trips one real qualification** — let the user confirm the UX before adding `/recent`, `/why`, deploy config
4. **Before writing `fly.toml`** — confirm region preference (default: `iad`, since user is in PA)

## Out of scope for Phase 1 — do NOT build

- LinkedIn scraping (manual paste only)
- Public webhook endpoint (use polling for local dev; webhook lands at deploy time)
- Bulk CSV processing
- Slack adapter
- Multi-user support beyond the single whitelisted user
- Web UI of any kind

## Validation checklist

Phase 1 is done when ALL of these pass:

- [ ] `pnpm install && pnpm build` runs clean (no TS errors, no warnings in core)
- [ ] `pnpm dev` starts the bot in polling mode without crashing
- [ ] Bot responds to `/start` with the paste instructions
- [ ] Pasting a real LinkedIn profile excerpt returns a qualification card within 5 seconds
- [ ] `/recent 5` returns the last 5 leads with tier + segment
- [ ] `/why <id>` returns `decision_rationale` and `signals`
- [ ] An unauthorized Telegram user gets the private-bot reply (does not trigger LLM calls)
- [ ] A malformed/short paste returns a graceful "I need more profile content" reply, not a crash
- [ ] `src/core/` has no `any` types
- [ ] README explains: how to run locally, how to get a bot token, how to deploy to Fly.io

## Begin

Output (1) a one-paragraph plan of attack, (2) the proposed file tree, (3) the first 3 commands you'll run. Then ask for permission to proceed.
