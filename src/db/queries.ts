import type Database from "better-sqlite3";
import type {
  CompanyScreenResult,
  CompanyStatus,
  QualificationResult,
  Tier,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export interface InsertLeadInput {
  type: "person" | "company";
  raw_text: string;
  linkedin_url: string | null;
  name: string | null;
  title: string | null;
  company: string | null;
  company_size: number | null;
  result: QualificationResult | CompanyScreenResult;
  source: string;
  source_user_id: string;
}

export function insertLead(
  db: Database.Database,
  input: InsertLeadInput,
): number {
  const stmt = db.prepare(`
    INSERT INTO leads (
      type, raw_text, linkedin_url, name, title, company, company_size,
      qualified_at, result_json, source, source_user_id
    ) VALUES (
      @type, @raw_text, @linkedin_url, @name, @title, @company, @company_size,
      @qualified_at, @result_json, @source, @source_user_id
    )
  `);
  const info = stmt.run({
    type: input.type,
    raw_text: input.raw_text,
    linkedin_url: input.linkedin_url,
    name: input.name,
    title: input.title,
    company: input.company,
    company_size: input.company_size,
    qualified_at: new Date().toISOString(),
    result_json: JSON.stringify(input.result),
    source: input.source,
    source_user_id: input.source_user_id,
  });
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Read shapes — discriminated on `type` so callers can dispatch UI by lead kind.
// ---------------------------------------------------------------------------

export interface BaseLeadSummary {
  id: number;
  qualified_at: string;
  company: string | null;
}

export interface PersonLeadSummary extends BaseLeadSummary {
  type: "person";
  name: string | null;
  title: string | null;
  tier: Tier | null;
  segment: string | null;
  segment_label: string | null;
}

export interface CompanyLeadSummary extends BaseLeadSummary {
  type: "company";
  status: CompanyStatus;
  industry_family: string | null;
  angle: string | null;
  angle_label: string | null;
}

export type LeadSummary = PersonLeadSummary | CompanyLeadSummary;

export interface PersonLeadFull extends PersonLeadSummary {
  raw_text: string;
  linkedin_url: string | null;
  company_size: number | null;
  result: QualificationResult;
}

export interface CompanyLeadFull extends CompanyLeadSummary {
  raw_text: string;
  company_size: number | null;
  result: CompanyScreenResult;
}

export type LeadFull = PersonLeadFull | CompanyLeadFull;

interface LeadRow {
  id: number;
  type: string | null; // null for any pre-1.7 row that somehow lacks the column (defensive)
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
  if (row.type === "company") {
    const result = JSON.parse(row.result_json) as CompanyScreenResult;
    return {
      type: "company",
      id: row.id,
      qualified_at: row.qualified_at,
      company: row.company,
      status: result.status,
      industry_family: result.industry_family,
      angle: result.angle,
      angle_label: result.angle_label,
      raw_text: row.raw_text,
      company_size: row.company_size,
      result,
    };
  }
  const result = JSON.parse(row.result_json) as QualificationResult;
  return {
    type: "person",
    id: row.id,
    qualified_at: row.qualified_at,
    company: row.company,
    name: row.name,
    title: row.title,
    tier: result.tier,
    segment: result.segment,
    segment_label: result.segment_label,
    raw_text: row.raw_text,
    linkedin_url: row.linkedin_url,
    company_size: row.company_size,
    result,
  };
}

function fullToSummary(f: LeadFull): LeadSummary {
  if (f.type === "company") {
    return {
      type: "company",
      id: f.id,
      qualified_at: f.qualified_at,
      company: f.company,
      status: f.status,
      industry_family: f.industry_family,
      angle: f.angle,
      angle_label: f.angle_label,
    };
  }
  return {
    type: "person",
    id: f.id,
    qualified_at: f.qualified_at,
    company: f.company,
    name: f.name,
    title: f.title,
    tier: f.tier,
    segment: f.segment,
    segment_label: f.segment_label,
  };
}

const LEAD_COLUMNS = `id, type, name, title, company, company_size,
              qualified_at, result_json, raw_text, linkedin_url, source, source_user_id`;

export function recentLeads(
  db: Database.Database,
  limit: number,
): LeadSummary[] {
  const rows = db
    .prepare(
      `SELECT ${LEAD_COLUMNS}
       FROM leads
       ORDER BY qualified_at DESC
       LIMIT ?`,
    )
    .all(limit) as LeadRow[];
  return rows.map(rowToFull).map(fullToSummary);
}

export function getLeadById(
  db: Database.Database,
  id: number,
): LeadFull | null {
  const row = db
    .prepare(
      `SELECT ${LEAD_COLUMNS}
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

// /feedback queue. As of 1.7 it surfaces person and company down-votes —
// `lead_type` plus the parsed `result` lets the renderer dispatch.
export interface DownvoteEntry {
  lead_id: number;
  lead_type: "person" | "company";
  voter_user_id: string;
  voter_display_name: string | null;
  note: string | null;
  created_at: string;
  lead_name: string | null;
  lead_title: string | null;
  lead_company: string | null;
  result: QualificationResult | CompanyScreenResult;
}

interface DownvoteRow {
  lead_id: number;
  lead_type: string | null;
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
              l.type              AS lead_type,
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
    lead_type: r.lead_type === "company" ? "company" : "person",
    voter_user_id: r.user_id,
    voter_display_name: r.display_name,
    note: r.note,
    created_at: r.created_at,
    lead_name: r.name,
    lead_title: r.title,
    lead_company: r.company,
    result:
      r.lead_type === "company"
        ? (JSON.parse(r.result_json) as CompanyScreenResult)
        : (JSON.parse(r.result_json) as QualificationResult),
  }));
}
