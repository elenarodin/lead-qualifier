# Build Prompt: Kombocode Lead Qualifier — Phase 1.8

Paste into Claude Code (project dir) after this file is in the folder. Phase 1.7 is **deployed and live**; this hardens company resolution and adds sub-industry transparency to both modes.

---

You are extending the **deployed** Kombocode Lead Qualifier. This is **Phase 1.8**, fixing a real reliability gap: bare company names are ambiguous (two different companies can share a name; "Quadax" vs "Quadax Inc"; same name across industries). The bot can currently resolve to the WRONG entity and report it confidently. Fix that with domain anchoring + transparency, and surface the detected sub-industry on every card.

## Read first — before editing

Read the live files and confirm:
- `./src/core/enrich.ts`, `qualify.ts`, `rules.ts`, `classifier.ts`, `types.ts`
- `./src/adapters/telegram.ts`
- `./src/db/schema.ts`, `./src/db/queries.ts`
- `./src/version.ts`, `./SKILL.md`

**Stop Point #1** — present the change plan, the revised enrichment/resolution logic, and the ambiguity decision rule. Wait for approval.

---

## Change 1 — Domain / URL as the resolution key

Company input (in `/company` mode, and the company field in person mode where present) may now include a **domain** or **LinkedIn company URL**. Parse each `/company` line for an optional identifier:

- `Quadax, quadax.com` → name + domain
- `quadax.com` → domain only
- `https://www.quadax.com` → domain only
- `linkedin.com/company/datavant` → LinkedIn company slug (`datavant`)
- `Welkin` → bare name (lower confidence path)

Extract a normalized domain when present (strip scheme/`www.`/paths). Treat a LinkedIn company URL's slug as a strong identifier too.

### Resolution logic in `enrich.ts`

Refactor enrichment to resolve against the strongest identifier available:

1. **Domain present** → anchor the lookup to that specific domain (scope web research to that domain — e.g. search the domain and read what that company itself says it does). This is unambiguous; confidence high. Do NOT let Claude's generic name-knowledge override what the domain resolves to.
2. **LinkedIn slug present** → use the slug as the entity anchor for the web lookup. (Do NOT scrape LinkedIn — use the slug to disambiguate the web search.)
3. **Bare name only** → resolve via knowledge + web search as today, BUT:
   - If multiple distinct companies plausibly match the name → return **AMBIGUOUS** (see Change 3). Do not silently pick one.
   - If a single confident match → resolve it, confidence medium, and **always echo the resolved identity** so the user can verify.

Add to the enrichment return: `resolved_domain` (string|null), `resolved_via` (`domain`|`linkedin`|`name`), `match_confidence` (`high`|`medium`|`low`), and `candidates` (array, populated only when ambiguous).

## Change 2 — Resolution echo (show the work)

Every company result must report **what entity it actually matched** — the resolved domain (if any) and a one-line description of what that company does — so the user can catch a mis-resolution. This applies to TARGET, NOT, and the person-mode company line.

## Change 3 — Ambiguity handling (new outcome)

When a bare name matches multiple distinct companies, return a new status **AMBIGUOUS** (treat as a NEEDS_INFO sibling — never DISQUALIFIED):

- Card lists up to 3 candidates with their domains + one-line descriptors, e.g.:
  ```
  ❓ Quadax — ambiguous, which one?
    a) quadax.com — healthcare revenue cycle / claims clearinghouse
    b) quadax.io — logistics software
  Reply: /company Quadax, quadax.com   (add the domain to screen the right one)
  ```
- No angle/segment assigned for AMBIGUOUS. Stored like NEEDS_INFO.

## Change 4 — Sub-industry on BOTH modes

Surface the **specific detected sub-industry** (the granular descriptor, distinct from the rubric family) on every card, both company screening and person qualification.

- Enrichment/classification returns `sub_industry` (string|null) — the precise descriptor, e.g. "PBM software", "RWD/RWE analytics for life sciences", "prior-auth automation for payers".
- The rubric **family** is the routing bucket; the **sub_industry** is the granular truth. Show both. When they seem to disagree, that's intentional signal for the user to flag.

### Card formats

Company summary line:
```
2. ✅ Quadax (quadax.com · healthcare revenue cycle / claims clearinghouse)
   · Payer Tech · ~600 emp ⚠️ verify → Trace-Any-Denial   (id 18)
```
Person card — add a sub-industry line under the company:
```
🔥 HOT — Payer Tech CTO
Jane Doe — CTO @ ZenPayer Health (~180 emp)
  ↳ prior-auth automation for regional payers   ← sub_industry
→ Angle: Trace-Any-Denial Diagnostic
...
```

## Change 5 — Types

- Extend the enrichment result and `CompanyScreenResult` with: `resolved_domain`, `resolved_via`, `match_confidence`, `sub_industry`, and `candidates` (for AMBIGUOUS).
- Add `AMBIGUOUS` to the company status union (`TARGET | NOT | NEEDS_INFO | AMBIGUOUS`).
- Add `sub_industry` to the person `QualificationResult` (and to its card rendering).

## Change 6 — Telegram

- Parse domains/URLs/slugs out of each `/company` line per Change 1.
- Render the resolution echo + sub-industry per the card formats above; escape MarkdownV2 specials (domains with `.` and `-`, slashes).
- AMBIGUOUS card lists candidates and shows the exact `/company Name, domain` retry hint.
- `/why <id>` for company records shows: resolved domain, resolved_via, match_confidence, sub_industry, family, size+confidence, geography, angle, reasoning. Keep 👍/👎.
- Update `/start` and `/help`: note that adding a domain (`/company Name, domain`) gives the most accurate result.
- **Cost firewall intact:** all resolution/search post-auth only.

## Change 7 — SKILL.md + version

- SKILL.md: document the resolution hierarchy (domain > linkedin slug > bare name), the echo requirement, the AMBIGUOUS outcome, and the family-vs-sub_industry distinction.
- Bump `VERSION` to `"1.8.0"`; update startup log and `/version`.

---

## Stop points

1. After reading live files — plan + resolution logic + ambiguity rule. Wait.
2. After core enrichment/resolution rebuilt — run the test cases below, show results. Wait.
3. After Telegram + version + full validation. Wait. (Deploy separately.)

## Test cases (Stop Point #2)

1. `Quadax, quadax.com` → resolves via **domain**, match_confidence high, correct sub-industry (claims/revenue-cycle), echoes domain.
2. Bare `Quadax` with two plausible distinct matches → **AMBIGUOUS** with candidate list, no silent pick.
3. `linkedin.com/company/datavant` → resolves via **linkedin** slug to Datavant, health-data family, sub-industry shown.
4. Known unambiguous bare name (e.g. `Cohere Health`) → resolves via **name**, medium confidence, echoes what it matched.
5. Domain that clearly maps to an excluded industry (e.g. a retail domain) → **⛔ NOT**, echo shows the resolved identity.
6. Person-mode paste → person card now shows the `sub_industry` line; family + sub-industry both present.
7. Payer target still suggests a diagnostic; pharma target still gets build/stabilization (fence intact).
8. AMBIGUOUS and NEEDS_INFO never render as DISQUALIFIED.

## Out of scope for 1.8 — do NOT do

- Clay / Proxycurl integration (still web-only; domain just scopes the web lookup)
- Actual LinkedIn scraping (slug is used only to disambiguate the web search)
- CSV upload, Slack adapter, HubSpot sync

## Validation checklist — done when ALL pass

- [ ] `npm run build` clean, no `any` in `src/core/`
- [ ] Domain/URL/slug parsed from `/company` lines; domain anchors resolution and overrides generic name-knowledge
- [ ] Every company result echoes the resolved identity (domain + one-line descriptor)
- [ ] Bare-name collisions return AMBIGUOUS with candidates, never a silent pick, never DISQUALIFIED
- [ ] `sub_industry` shows on BOTH company and person cards, distinct from the rubric family
- [ ] Uncertain size/geo still never hard-fail; payer-diagnostic fence intact
- [ ] `/why` shows resolution detail + sub-industry; 👍/👎 intact; cost firewall intact
- [ ] `/version` returns `1.8.0`; `/start` + `/help` mention the domain tip

## Begin

Read the live files, then present (1) the change plan, (2) the resolution hierarchy + ambiguity decision rule, (3) how `resolved_via`/`match_confidence`/`sub_industry` thread through enrich → rules → card. Wait for approval. (Stop Point #1.)
