import Database from "better-sqlite3";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// Fresh-install schema. Existing 1.6 databases get the `type` column added by
// ensureLeadsTypeColumn() — see the migration block below.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL DEFAULT 'person',
  raw_text        TEXT    NOT NULL,
  linkedin_url    TEXT,
  name            TEXT,
  title           TEXT,
  company         TEXT,
  company_size    INTEGER,
  qualified_at    TEXT    NOT NULL,
  result_json     TEXT    NOT NULL,
  source          TEXT    NOT NULL DEFAULT 'telegram',
  source_user_id  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_qualified_at ON leads(qualified_at DESC);

CREATE TABLE IF NOT EXISTS authorized_users (
  telegram_user_id  TEXT PRIMARY KEY,
  display_name      TEXT,
  registered_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     INTEGER NOT NULL,
  user_id     TEXT    NOT NULL,
  vote        TEXT    NOT NULL,        -- 'up' | 'down'
  note        TEXT,
  created_at  TEXT    NOT NULL,
  UNIQUE(lead_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);
`;

interface PragmaColumn {
  name: string;
}

// SQLite "ALTER TABLE ADD COLUMN" doesn't support IF NOT EXISTS, so we
// introspect first. Idempotent — safe to run on every startup. Existing rows
// pick up the DEFAULT automatically; no row rewrites.
function ensureLeadsTypeColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(leads)").all() as PragmaColumn[];
  const has = cols.some((c) => c.name === "type");
  if (!has) {
    db.exec(
      `ALTER TABLE leads ADD COLUMN type TEXT NOT NULL DEFAULT 'person'`,
    );
  }
  // Index lives here (not in SCHEMA) so it always follows the column add — on
  // migration paths the column doesn't exist when SCHEMA runs.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_type ON leads(type)`);
}

export function openDatabase(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  ensureLeadsTypeColumn(db);
  return db;
}
