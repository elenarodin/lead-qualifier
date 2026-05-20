# Kombocode Lead Qualifier

Telegram bot that qualifies LinkedIn leads against the Kombocode ICP. Hybrid pipeline: deterministic hard rules + Claude Haiku 4.5 for extraction and classification. Multi-user (small trusted team — gated by a shared access code, self-register on first DM).

`SKILL.md` is the workflow spec. `rubric.yaml` is the ICP source of truth — edit there when ICP changes, not in code.

## Stack

- TypeScript (strict), Node ≥ 20 (target 22 LTS), npm
- `telegraf` (polling), `@anthropic-ai/sdk`, `better-sqlite3`, `yaml`, `dotenv`
- Claude model: `claude-haiku-4-5-20251001`

## Local dev

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Edit .env — fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ACCESS_CODE

# 3. Run (polling mode, hot reload)
npm run dev

# 4. Production build
npm run build && npm start
```

## Getting a Telegram bot token

1. DM [@BotFather](https://t.me/BotFather) and run `/newbot`. Pick a name and a unique username (must end in `bot`).
2. BotFather replies with an HTTP API token. Paste into `.env` as `TELEGRAM_BOT_TOKEN`.
3. Optional: with BotFather, `/setdescription`, `/setabouttext`, `/setuserpic`.

## Access code

The bot is gated by a shared secret in `ACCESS_CODE`. Anyone with the code can register themselves; treat it like a team password.

- **New user**: DM the bot any text. They get *"This bot is private. Send the access code to get started."* Then they send the exact `ACCESS_CODE` value → the bot welcomes them and records their Telegram user ID in `authorized_users`. From that point on they can use the bot normally.
- **Revoke**: delete the row from `authorized_users` (`DELETE FROM authorized_users WHERE telegram_user_id = '...'`). They drop back to the private-bot reply.
- **Rotate**: change `ACCESS_CODE` in env, redeploy. Existing registered users still work (the gate is membership in `authorized_users`, not knowledge of the current code).
- **Cost safety**: unauthorized messages never reach Anthropic. The auth gate runs as the first Telegraf middleware and short-circuits before any LLM call.

## Bot usage

Send a DM. Anything ≥ 200 chars is treated as profile text to qualify (the cutoff is high enough that casual chat messages don't get swallowed as profiles). **One profile per message** — the bot processes each paste independently and does not merge multiple roles into a single card; send separate pastes for separate roles. Each qualification card shows 👍 / 👎 buttons — tap to record feedback. NEEDS_INFO (❓) cards do not carry vote buttons.

## Outcomes

| Outcome | When | Tier |
|---|---|---|
| **PASS** | HOT or WARM segment match | `HOT` / `WARM` |
| **REVIEW** | borderline (COLD) | `COLD` |
| **FAIL** | confidently disqualified — wrong geography, confidently out-of-band size, junior title, director-at-small-co, or off-ICP industry | `DISQUALIFIED` |
| **NEEDS_INFO** *(1.6)* | enrichment ran (Claude knowledge + web search) and we still can't identify the company. The card asks the user to re-paste with the company's industry / About section. | `null` |

If a profile is missing the company's industry or employee count, the bot runs an enrichment step (one Claude call with the `web_search` tool) before classifying. You'll see *"🔍 Looking up [Company]…"* in place of the *"Qualifying — one moment…"* message while that runs.

Size handling: an employee count is treated as a hard disqualifier only when the paste itself states it (high-confidence). Headcounts from model knowledge or web search are advisory — out-of-band values surface a `size_unverified` signal and a `(size unverified)` note on the card, but don't auto-fail the lead.

| Command | Behavior |
|---|---|
| `/start` | Paste instructions + version footer |
| `/help` | Command list |
| `/recent [n]` | Last `n` qualifications (default 5, max 50) |
| `/why <id>` | Decision rationale + signals for that lead |
| `/feedback [n]` | Recent down-votes with notes — the tuning queue (default 10, max 50) |
| `/version` | Current build |

### Feedback loop

- Tap 👍 or 👎 on any card. The vote is recorded against `(lead_id, your_user_id)`. Re-tapping flips your vote (UPSERT — one row per (lead, voter)).
- After a 👎 the bot replies: *"Noted 👎 — add a short reason if you like, or just paste your next profile to keep going."* Your **next message within 10 minutes** is interpreted by length:
  - `/`-prefixed → command (e.g. `/recent`); pending-note state is cleared.
  - **< 200 chars** → stored as the reason note for that down-vote.
  - **≥ 200 chars** → treated as a new profile paste (not swallowed as a note); pending-note state is cleared.
- Flipping back to 👍 invalidates any earlier note. Re-tapping 👎 re-prompts for a fresh reason.
- `/feedback` is Lena's tuning queue: lead name, voter, original tier/segment/angle, the reason note.

Pasting a LinkedIn URL alongside text → the URL is stored in `linkedin_url`; the rest of the text is qualified. Phase 1 does not fetch the URL.

## Versioning

`src/version.ts` exports a single `VERSION` constant. **Bump it on every meaningful change before deploy** so the team knows which build is live (`/version` returns it, `/start` shows it in the footer, startup logs `[info] Kombocode Qualifier v… starting…`). SemVer-ish: bump the patch for fixes, minor for new features, major for breaking schema or auth changes.

## Manual qualifier (no bot needed)

For debugging prompts or smoke-testing the pipeline:

```bash
npm run qualify -- --example         # built-in payer example
npm run qualify -- path/to/profile.txt
cat profile.txt | npm run qualify
```

Outputs the extracted `ProfileData` and the full `QualificationResult`.

## Data

SQLite at `./data/qualifier.db` locally, `/data/qualifier.db` on Fly. Schema in `src/db/schema.ts`. Three tables:

- `leads` — every qualification (`source` / `source_user_id` are pre-wired so a Slack adapter can land later without a migration).
- `authorized_users` — Telegram user IDs that have presented the access code.
- `feedback` — one row per `(lead_id, user_id)` (UPSERT semantics); `/feedback` surfaces rows where `vote = 'down'`.

## Deploy to Fly.io

`fly.toml` and `Dockerfile` are committed. No public HTTP — polling mode only.

```bash
# One-time
fly apps create kombocode-qualifier
fly volumes create kombocode_qualifier_data --region iad --size 1
fly secrets set \
  TELEGRAM_BOT_TOKEN=... \
  ANTHROPIC_API_KEY=... \
  ACCESS_CODE=...

# Deploy
fly deploy
fly logs    # tail
```

Persistent SQLite is on the Fly volume mounted at `/data`. **Run a single instance only** — concurrent pollers would conflict on Telegram's getUpdates.

## File map

```
src/
├── core/                # No I/O outside Claude + rubric file
│   ├── qualify.ts       # 3-stage orchestrator
│   ├── extract.ts       # Claude → ProfileData
│   ├── rules.ts         # Deterministic hard disqualifiers
│   ├── classifier.ts    # Claude → segment + tier + angle + notes
│   ├── rubric.ts        # Loads rubric.yaml (cached), typed lookups
│   ├── anthropic.ts     # Shared Anthropic client + JSON-mode helper
│   └── types.ts         # ProfileData, QualificationResult, Rubric
├── adapters/
│   └── telegram.ts      # Telegraf wiring, auth gate, cards, feedback buttons
├── db/
│   ├── schema.ts        # CREATE TABLE leads + authorized_users + feedback
│   └── queries.ts       # insertLead, recentLeads, getLeadById, auth + feedback helpers
├── config.ts            # Env parsing (validates required vars)
├── version.ts           # VERSION constant — bump before each deploy
└── index.ts             # App entry — wires config → db → bot
```

## Out of scope (still)

LinkedIn scraping, public webhook endpoint, bulk CSV processing, Slack adapter, web UI, role hierarchies / per-user permission tiers. Schema is forward-compatible; new adapters slot in without a migration.
