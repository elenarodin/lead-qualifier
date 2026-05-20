import Database from "better-sqlite3";
import { dirname } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
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

export function openDatabase(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
