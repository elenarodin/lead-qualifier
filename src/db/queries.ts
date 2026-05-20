import type Database from "better-sqlite3";
import type { ProfileData, QualificationResult } from "../core/types.js";

export interface InsertLeadInput {
  raw_text: string;
  linkedin_url: string | null;
  profile: ProfileData;
  result: QualificationResult;
  source: string;
  source_user_id: string;
}

export interface LeadSummary {
  id: number;
  name: string | null;
  title: string | null;
  company: string | null;
  // Null when the lead is a NEEDS_INFO outcome (1.6) — we couldn't place a tier.
  tier: string | null;
  segment: string | null;
  segment_label: string | null;
  qualified_at: string;
}

export interface LeadFull extends LeadSummary {
  raw_text: string;
  linkedin_url: string | null;
  company_size: number | null;
  result: QualificationResult;
}

interface LeadRow {
  id: number;
  raw_text: string;
  linkedin_url: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  company_size: number | null;
  qualified_at: string;
  result_json: string;
  source: string;
  source_user_id: string;
}

function rowToFull(row: LeadRow): LeadFull {
  const result = JSON.parse(row.result_json) as QualificationResult;
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    company: row.company,
    company_size: row.company_size,
    tier: result.tier,
    segment: result.segment,
    segment_label: result.segment_label,
    qualified_at: row.qualified_at,
    raw_text: row.raw_text,
    linkedin_url: row.linkedin_url,
    result,
  };
}

export function insertLead(
  db: Database.Database,
  input: InsertLeadInput,
): number {
  const stmt = db.prepare(`
    INSERT INTO leads (
      raw_text, linkedin_url, name, title, company, company_size,
      qualified_at, result_json, source, source_user_id
    ) VALUES (
      @raw_text, @linkedin_url, @name, @title, @company, @company_size,
      @qualified_at, @result_json, @source, @source_user_id
    )
  `);
  const info = stmt.run({
    raw_text: input.raw_text,
    linkedin_url: input.linkedin_url,
    name: input.profile.name,
    title: input.profile.title,
    company: input.profile.company,
    company_size: input.profile.company_size,
    qualified_at: new Date().toISOString(),
    result_json: JSON.stringify(input.result),
    source: input.source,
    source_user_id: input.source_user_id,
  });
  return Number(info.lastInsertRowid);
}

export function recentLeads(
  db: Database.Database,
  limit: number,
): LeadSummary[] {
  const rows = db
    .prepare(
      `SELECT id, name, title, company, company_size, qualified_at, result_json,
              raw_text, linkedin_url, source, source_user_id
       FROM leads
       ORDER BY qualified_at DESC
       LIMIT ?`,
    )
    .all(limit) as LeadRow[];
  return rows.map(rowToFull).map((f) => ({
    id: f.id,
    name: f.name,
    title: f.title,
    company: f.company,
    tier: f.tier,
    segment: f.segment,
    segment_label: f.segment_label,
    qualified_at: f.qualified_at,
  }));
}

export function getLeadById(
  db: Database.Database,
  id: number,
): LeadFull | null {
  const row = db
    .prepare(
      `SELECT id, name, title, company, company_size, qualified_at, result_json,
              raw_text, linkedin_url, source, source_user_id
       FROM leads WHERE id = ?`,
    )
    .get(id) as LeadRow | undefined;
  if (!row) return null;
  return rowToFull(row);
}

// ---------------------------------------------------------------------------
// Authorization (1.5)
// ---------------------------------------------------------------------------

export function isAuthorized(
  db: Database.Database,
  telegramUserId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM authorized_users WHERE telegram_user_id = ? LIMIT 1`,
    )
    .get(telegramUserId);
  return row !== undefined;
}

export function registerUser(
  db: Database.Database,
  telegramUserId: string,
  displayName: string | null,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO authorized_users (telegram_user_id, display_name, registered_at)
     VALUES (?, ?, ?)`,
  ).run(telegramUserId, displayName, new Date().toISOString());
}

interface AuthorizedUserRow {
  telegram_user_id: string;
  display_name: string | null;
}

export function getDisplayName(
  db: Database.Database,
  telegramUserId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT telegram_user_id, display_name FROM authorized_users WHERE telegram_user_id = ?`,
    )
    .get(telegramUserId) as AuthorizedUserRow | undefined;
  return row?.display_name ?? null;
}

// ---------------------------------------------------------------------------
// Feedback (1.5)
// ---------------------------------------------------------------------------

export type Vote = "up" | "down";

// UPSERT: keep one row per (lead_id, user_id). Changing the vote also clears
// any previous note — a flip 👍→👎 needs a fresh reason; 👎→👍 invalidates the
// old reason. /feedback only surfaces rows where vote='down', so flipped-up
// rows are excluded automatically.
export function upsertFeedback(
  db: Database.Database,
  leadId: number,
  userId: string,
  vote: Vote,
): void {
  db.prepare(
    `INSERT INTO feedback (lead_id, user_id, vote, note, created_at)
     VALUES (@leadId, @userId, @vote, NULL, @createdAt)
     ON CONFLICT(lead_id, user_id) DO UPDATE SET
       vote = excluded.vote,
       note = NULL,
       created_at = excluded.created_at`,
  ).run({
    leadId,
    userId,
    vote,
    createdAt: new Date().toISOString(),
  });
}

// Attaches a note to the current down-vote for (lead_id, user_id). Silent
// no-op if the row is missing or no longer a down-vote.
export function setDownvoteNote(
  db: Database.Database,
  leadId: number,
  userId: string,
  note: string,
): boolean {
  const info = db
    .prepare(
      `UPDATE feedback SET note = ?
       WHERE lead_id = ? AND user_id = ? AND vote = 'down'`,
    )
    .run(note, leadId, userId);
  return info.changes > 0;
}

export function getFeedbackVote(
  db: Database.Database,
  leadId: number,
  userId: string,
): Vote | null {
  const row = db
    .prepare(
      `SELECT vote FROM feedback WHERE lead_id = ? AND user_id = ?`,
    )
    .get(leadId, userId) as { vote: Vote } | undefined;
  return row?.vote ?? null;
}

export interface DownvoteEntry {
  lead_id: number;
  voter_user_id: string;
  voter_display_name: string | null;
  note: string | null;
  created_at: string;
  lead_name: string | null;
  lead_title: string | null;
  lead_company: string | null;
  result: QualificationResult;
}

interface DownvoteRow {
  lead_id: number;
  user_id: string;
  display_name: string | null;
  note: string | null;
  created_at: string;
  name: string | null;
  title: string | null;
  company: string | null;
  result_json: string;
}

export function recentDownvotes(
  db: Database.Database,
  limit: number,
): DownvoteEntry[] {
  const rows = db
    .prepare(
      `SELECT f.lead_id          AS lead_id,
              f.user_id           AS user_id,
              u.display_name      AS display_name,
              f.note              AS note,
              f.created_at        AS created_at,
              l.name              AS name,
              l.title             AS title,
              l.company           AS company,
              l.result_json       AS result_json
       FROM feedback f
       JOIN leads l ON l.id = f.lead_id
       LEFT JOIN authorized_users u ON u.telegram_user_id = f.user_id
       WHERE f.vote = 'down'
       ORDER BY f.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as DownvoteRow[];
  return rows.map((r) => ({
    lead_id: r.lead_id,
    voter_user_id: r.user_id,
    voter_display_name: r.display_name,
    note: r.note,
    created_at: r.created_at,
    lead_name: r.name,
    lead_title: r.title,
    lead_company: r.company,
    result: JSON.parse(r.result_json) as QualificationResult,
  }));
}
