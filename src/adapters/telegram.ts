import type Database from "better-sqlite3";
import { Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { InlineKeyboardMarkup } from "telegraf/types";
import type { AppConfig } from "../config.js";
import { MAX_BATCH, screenCompanies } from "../core/company.js";
import { qualifyLead, TooShortError } from "../core/qualify.js";
import type {
  CompanyScreenResult,
  CompanyStatus,
  ProfileData,
  QualificationResult,
  Tier,
} from "../core/types.js";
import {
  getFeedbackVote,
  getLeadById,
  insertLead,
  isAuthorized,
  recentDownvotes,
  recentLeads,
  registerUser,
  setDownvoteNote,
  upsertFeedback,
  type DownvoteEntry,
  type LeadSummary,
  type Vote,
} from "../db/queries.js";
import { VERSION } from "../version.js";

const TIER_EMOJI: Record<Tier, string> = {
  HOT: "🔥",
  WARM: "🌤",
  COLD: "❄️",
  DISQUALIFIED: "⛔️",
};

const COMPANY_STATUS_EMOJI: Record<CompanyStatus, string> = {
  TARGET: "✅",
  NOT: "⛔",
  NEEDS_INFO: "❓",
};

const LINKEDIN_URL_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/\S+/i;
const MD_V2_ESCAPE_RE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
const FEEDBACK_CALLBACK_RE = /^fb:(up|down):(\d+)$/;

// After a 👎 we set a 10-minute pending-note state for that user. Their next
// message:
//   - starts with "/"     → command; pending is cleared (handled by middleware)
//   - < 200 chars         → stored as the down-vote note
//   - ≥ 200 chars         → treated as a new profile paste; pending cleared,
//                           message not swallowed
// 200 chars is well below a real LinkedIn paste and well above a casual chat
// message — it's a profile-vs-conversation discriminator, not the qualifier's
// hard floor (that lives in src/core/qualify.ts as MIN_PROFILE_LENGTH).
// State is in-memory; restart loses pending prompts, which is fine.
const PENDING_NOTE_TTL_MS = 10 * 60 * 1000;
const PROFILE_MIN_CHARS = 200;

interface PendingNotePrompt {
  leadId: number;
  expiresAt: number;
}

function escapeMd(s: string): string {
  return s.replace(MD_V2_ESCAPE_RE, (m) => `\\${m}`);
}

function startMessage(): string {
  return `👋 Kombocode lead qualifier\\.

Paste a LinkedIn profile and I'll classify it against the Kombocode ICP\\. *One profile per message* — I treat each paste independently and don't merge multiple roles\\.

Commands:
/company \\(or /co\\) — screen 1\\-10 companies for ICP fit, one name per line
/recent \\[n\\] — last n qualifications
/why \\<id\\> — full rationale for that lead
/feedback \\[n\\] — recent down\\-votes \\(tuning queue\\)
/version — current build
/help — this menu

_v${escapeMd(VERSION)}_`;
}

const HELP_MESSAGE = `Commands:
/start — intro
/company \\(or /co\\) — screen 1\\-10 companies for ICP fit \\(one name per line\\)
/recent \\[n\\] — last n qualifications \\(default 5\\)
/why \\<id\\> — decision rationale \\+ signals
/feedback \\[n\\] — recent down\\-votes with notes
/version — current build
/help — this menu

Paste *one profile per message* \\(\\~200\\+ chars\\) and I'll qualify it as a person\\. Each card has 👍 / 👎 buttons — tap to record feedback\\.
Use /company to screen companies first \\(no people needed\\) and qualify a person at the targets afterward\\.`;

const WELCOME_MESSAGE = `✅ You're in\\.

${startMessage()}`;

const PRIVATE_REPLY =
  "This bot is private. Send the access code to get started.";
const TOO_SHORT_REPLY =
  "I need more profile content — paste a fuller profile excerpt (about/experience/role lines).";
const PROCESSING_REPLY = "Qualifying — one moment…";
const ERROR_REPLY = "Something went wrong. Check the server logs.";
const DOWNVOTE_REASON_PROMPT =
  "Noted 👎 — add a short reason if you like, or just paste your next profile to keep going.";
const NOTE_SAVED_REPLY = "Reason saved 👍";

// ---------------------------------------------------------------------------
// Card + button rendering
// ---------------------------------------------------------------------------

function feedbackButtons(
  leadId: number,
  currentVote: Vote | null,
): ReturnType<typeof Markup.inlineKeyboard> {
  const up = currentVote === "up" ? "✅ 👍" : "👍";
  const down = currentVote === "down" ? "✅ 👎" : "👎";
  return Markup.inlineKeyboard([
    Markup.button.callback(up, `fb:up:${leadId}`),
    Markup.button.callback(down, `fb:down:${leadId}`),
  ]);
}

// 1.6: per-card company line. Renders "Jane Doe — CTO @ Acme (180 employees)",
// with "(size unverified)" when the qualifier's signals include size_unverified.
// Returns null if there's nothing meaningful to show (no name AND no title).
function formatHeaderLine(
  profile: ProfileData,
  result: QualificationResult,
): string | null {
  const hasName = !!profile.name;
  const hasTitle = !!profile.title;
  const hasCompany = !!profile.company;
  if (!hasName && !hasTitle && !hasCompany) return null;

  const sizeUnverified = result.signals.includes("size_unverified");
  const sizeKnown = profile.company_size !== null;

  let sizeAnnotation = "";
  if (sizeKnown && sizeUnverified) {
    sizeAnnotation = ` \\(${profile.company_size} employees, size unverified\\)`;
  } else if (sizeKnown) {
    sizeAnnotation = ` \\(${profile.company_size} employees\\)`;
  } else if (sizeUnverified) {
    sizeAnnotation = ` \\(size unverified\\)`;
  }

  const nameBit = hasName ? `*${escapeMd(profile.name as string)}*` : "";
  const roleBit =
    hasTitle && hasCompany
      ? `${escapeMd(profile.title as string)} @ ${escapeMd(profile.company as string)}`
      : hasTitle
        ? escapeMd(profile.title as string)
        : hasCompany
          ? `@ ${escapeMd(profile.company as string)}`
          : "";

  const sep = nameBit && roleBit ? " — " : "";
  return `${nameBit}${sep}${roleBit}${sizeAnnotation}`;
}

function formatNeedsInfoCard(
  id: number,
  profile: ProfileData,
  result: QualificationResult,
): string {
  const lines: string[] = [];
  const who = profile.name ? ` — ${escapeMd(profile.name)}` : "";
  lines.push(`❓ *NEED MORE INFO*${who}`);
  lines.push("");

  if (profile.company || profile.title) {
    const header = formatHeaderLine(profile, result);
    if (header) {
      lines.push(header);
      lines.push("");
    }
  }

  if (result.notes) {
    lines.push(`_${escapeMd(result.notes)}_`);
    lines.push("");
  }

  lines.push(`ID: ${id} — reply /why ${id} for reasoning`);
  return lines.join("\n");
}

function formatCard(
  id: number,
  profile: ProfileData,
  result: QualificationResult,
): string {
  if (result.qualified === "NEEDS_INFO") {
    return formatNeedsInfoCard(id, profile, result);
  }

  const lines: string[] = [];
  const tier = result.tier ?? "DISQUALIFIED";
  const emoji = TIER_EMOJI[tier];
  const segLabel = result.segment_label ?? "Unsegmented";

  lines.push(`${emoji} *${escapeMd(tier)}* — ${escapeMd(segLabel)}`);
  lines.push("");

  const header = formatHeaderLine(profile, result);
  if (header) {
    lines.push(header);
    lines.push("");
  }

  if (result.opening_angle_label) {
    lines.push(`→ Angle: ${escapeMd(result.opening_angle_label)}`);
    lines.push("");
  }

  if (result.disqualifier) {
    lines.push(`_${escapeMd(result.disqualifier)}_`);
    lines.push("");
  }

  if (result.notes) {
    lines.push(`_${escapeMd(result.notes)}_`);
    lines.push("");
  }

  if (result.signals.length > 0) {
    lines.push(`Signals: ${result.signals.map(escapeMd).join(", ")}`);
    lines.push("");
  }

  lines.push(`ID: ${id} — reply /why ${id} for reasoning`);

  return lines.join("\n");
}

function formatRecent(rows: LeadSummary[]): string {
  if (rows.length === 0) return "No qualifications yet\\.";
  const formatted = rows.map((r) => {
    if (r.type === "company") {
      const emoji = COMPANY_STATUS_EMOJI[r.status];
      const co = r.company ?? "Unknown company";
      const family = r.industry_family ?? "—";
      return `\`${r.id}\` ${emoji} ${escapeMd(co)} \\(${escapeMd(family)}\\)`;
    }
    const emoji = r.tier ? (TIER_EMOJI[r.tier] ?? "•") : "❓";
    const who = r.name ?? "Unknown";
    const where = r.company ? ` @ ${r.company}` : "";
    const seg = r.segment_label ?? r.segment ?? "—";
    return `\`${r.id}\` ${emoji} ${escapeMd(`${who}${where}`)} \\(${escapeMd(seg)}\\)`;
  });
  return formatted.join("\n");
}

function formatWhyPerson(id: number, result: QualificationResult): string {
  const lines: string[] = [];
  if (result.qualified === "NEEDS_INFO") {
    lines.push(`❓ *NEED MORE INFO* — ID ${id}`);
  } else {
    const tier = result.tier ?? "DISQUALIFIED";
    lines.push(`${TIER_EMOJI[tier]} *${escapeMd(tier)}* — ID ${id}`);
  }
  lines.push("");
  lines.push(`*Decision rationale:*`);
  lines.push(`_${escapeMd(result.decision_rationale)}_`);
  lines.push("");
  if (result.signals.length > 0) {
    lines.push(`*Signals:*`);
    lines.push(result.signals.map((s) => `• ${escapeMd(s)}`).join("\n"));
  } else {
    lines.push(`_No signals recorded\\._`);
  }
  return lines.join("\n");
}

function formatWhyCompany(id: number, result: CompanyScreenResult): string {
  const lines: string[] = [];
  const emoji = COMPANY_STATUS_EMOJI[result.status];
  lines.push(
    `${emoji} *${escapeMd(result.status)}* — ${escapeMd(result.company)} \\(ID ${id}\\)`,
  );
  lines.push("");
  if (result.industry || result.industry_family) {
    const label = result.industry_family ?? result.industry ?? "—";
    const enrichSrc = result.signals.includes("industry_via_web")
      ? " \\(via web\\)"
      : "";
    lines.push(`*Industry:* ${escapeMd(label)}${enrichSrc}`);
  }
  if (result.size !== null || result.size_confidence) {
    const sizeText = result.size !== null ? `~${result.size} emp` : "unknown";
    const conf = result.size_confidence
      ? ` \\(${escapeMd(result.size_confidence)} conf\\)`
      : "";
    lines.push(`*Size:* ${escapeMd(sizeText)}${conf}`);
  }
  if (result.geography) {
    lines.push(`*Geography:* ${escapeMd(result.geography)}`);
  }
  if (result.angle_label) {
    lines.push(`*Suggested angle:* ${escapeMd(result.angle_label)}`);
  }
  lines.push("");
  lines.push(`*Reason:*`);
  lines.push(`_${escapeMd(result.reason)}_`);
  if (result.signals.length > 0) {
    lines.push("");
    lines.push(`*Signals:*`);
    lines.push(result.signals.map((s) => `• ${escapeMd(s)}`).join("\n"));
  }
  return lines.join("\n");
}

// One-line per-company row in the /company batch summary. Mirrors the prompt's
// example layout: "1. ✅ Company · Family · ~180 emp → Angle   (id 20)".
function formatCompanyLine(
  index: number,
  id: number,
  result: CompanyScreenResult,
): string {
  const emoji = COMPANY_STATUS_EMOJI[result.status];
  const co = escapeMd(result.company);
  const idTag = ` \\(id ${id}\\)`;

  if (result.status === "NOT") {
    const why = escapeMd(result.reason);
    return `${index}\\. ${emoji} *${co}* — ${why}${idTag}`;
  }
  if (result.status === "NEEDS_INFO") {
    return `${index}\\. ${emoji} *${co}* — couldn't identify${idTag}`;
  }
  // TARGET
  const family = result.industry_family
    ? ` · ${escapeMd(result.industry_family)}`
    : "";
  let sizeBit = "";
  if (result.size !== null) {
    const verifyTag = result.size_confidence !== "high" ? " ⚠️ verify" : "";
    sizeBit = ` · ~${result.size} emp${verifyTag}`;
  } else if (result.signals.includes("size_unverified")) {
    sizeBit = " · size unverified";
  }
  const angle = result.angle_label
    ? ` → ${escapeMd(result.angle_label)}`
    : "";
  return `${index}\\. ${emoji} *${co}*${family}${sizeBit}${angle}${idTag}`;
}

function formatCompanySummary(
  inserted: { id: number; result: CompanyScreenResult }[],
  skipped: string[],
): string {
  const counts: Record<CompanyStatus, number> = {
    TARGET: 0,
    NOT: 0,
    NEEDS_INFO: 0,
  };
  for (const { result } of inserted) counts[result.status]++;

  const header = `Screened ${inserted.length} ${inserted.length === 1 ? "company" : "companies"} — ${counts.TARGET} ✅ target${counts.TARGET === 1 ? "" : "s"}, ${counts.NOT} ⛔ out, ${counts.NEEDS_INFO} ❓ unknown`;

  const lines = inserted.map((entry, i) =>
    formatCompanyLine(i + 1, entry.id, entry.result),
  );

  const out: string[] = [];
  out.push(header); // pure ASCII + emoji + em dashes — no MD-V2 specials
  out.push("");
  out.push(...lines);
  if (skipped.length > 0) {
    out.push("");
    out.push(
      `_Skipped \\(${skipped.length} over the ${MAX_BATCH}\\-cap\\):_ ${skipped.map(escapeMd).join(", ")}`,
    );
  }
  out.push("");
  out.push(`/why \\<id\\> to expand · /feedback to flag`);
  return out.join("\n");
}

function formatFeedbackQueue(rows: DownvoteEntry[]): string {
  if (rows.length === 0) return "No down\\-votes yet\\.";
  return rows
    .map((r) => {
      const voter = r.voter_display_name ?? r.voter_user_id;
      const noteLine = r.note
        ? `_"${escapeMd(r.note)}"_`
        : `_\\(no reason given\\)_`;
      if (r.lead_type === "company") {
        const result = r.result as CompanyScreenResult;
        const co = r.lead_company ?? result.company ?? "Unknown";
        const family = result.industry_family ?? "—";
        const angle = result.angle_label ?? "—";
        return [
          `\`${r.lead_id}\` 👎 *${escapeMd(co)}* — company`,
          `${escapeMd(result.status)} \\· ${escapeMd(family)} \\· ${escapeMd(angle)}`,
          `by ${escapeMd(voter)}: ${noteLine}`,
        ].join("\n");
      }
      const result = r.result as QualificationResult;
      const who = r.lead_name ?? "Unknown";
      const title = r.lead_title ?? "—";
      const company = r.lead_company ?? "—";
      const tier = result.tier ?? "—";
      const seg = result.segment_label ?? result.segment ?? "—";
      const angle = result.opening_angle_label ?? "—";
      return [
        `\`${r.lead_id}\` 👎 *${escapeMd(who)}* — ${escapeMd(`${title} @ ${company}`)}`,
        `${escapeMd(tier)} \\· ${escapeMd(seg)} \\· ${escapeMd(angle)}`,
        `by ${escapeMd(voter)}: ${noteLine}`,
      ].join("\n");
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------

export function buildBot(config: AppConfig, db: Database.Database): Telegraf {
  const bot = new Telegraf(config.telegramBotToken);

  // Per-user pending down-vote-note prompts. In-memory; ephemeral.
  const pendingNotes = new Map<string, PendingNotePrompt>();

  // ---- Auth gate -------------------------------------------------------
  // Runs first. Authorized users → next(). Unauthorized → either register
  // (if text matches ACCESS_CODE) or short-circuit with the private reply.
  // No Anthropic call can run before this middleware passes.
  bot.use(async (ctx, next) => {
    const userIdNum = ctx.from?.id;
    if (userIdNum === undefined) return; // no user context
    const userId = String(userIdNum);

    if (isAuthorized(db, userId)) {
      return next();
    }

    // Unauthorized: only text messages can submit the access code.
    if (ctx.has(message("text"))) {
      const text = ctx.message.text;
      if (text === config.accessCode) {
        const displayName =
          ctx.from?.first_name?.trim() ||
          ctx.from?.username?.trim() ||
          null;
        registerUser(db, userId, displayName);
        await ctx.reply(WELCOME_MESSAGE, { parse_mode: "MarkdownV2" });
        return;
      }
      await ctx.reply(PRIVATE_REPLY);
      return;
    }

    // Callback query (button tap) from an unauthorized user — answer the
    // popup so it doesn't hang in their UI. No LLM/db work.
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery(PRIVATE_REPLY);
      return;
    }
    // Anything else from an unauthorized user is silently dropped.
  });

  // ---- Command-clears-pending ------------------------------------------
  // Any incoming "/..." text clears that user's pending-note state before the
  // command handler fires. This way /recent, /version, /feedback etc. cleanly
  // exit the "waiting for a down-vote reason" mode.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== undefined && ctx.has(message("text"))) {
      if (ctx.message.text.startsWith("/")) {
        pendingNotes.delete(String(ctx.from.id));
      }
    }
    return next();
  });

  // ---- Commands --------------------------------------------------------

  bot.start(async (ctx) => {
    await ctx.reply(startMessage(), { parse_mode: "MarkdownV2" });
  });

  bot.help(async (ctx) => {
    await ctx.reply(HELP_MESSAGE, { parse_mode: "MarkdownV2" });
  });

  bot.command("version", async (ctx) => {
    await ctx.reply(`Kombocode Qualifier v${VERSION}`);
  });

  bot.command("recent", async (ctx) => {
    const argText = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const parsed = Number.parseInt(argText, 10);
    const n =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 50 ? parsed : 5;
    const rows = recentLeads(db, n);
    await ctx.reply(formatRecent(rows), { parse_mode: "MarkdownV2" });
  });

  bot.command("why", async (ctx) => {
    const argText = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const id = Number.parseInt(argText, 10);
    if (!Number.isFinite(id) || id <= 0) {
      await ctx.reply("Usage: /why <id>");
      return;
    }
    const lead = getLeadById(db, id);
    if (!lead) {
      await ctx.reply(`No lead with id ${id}\\.`, {
        parse_mode: "MarkdownV2",
      });
      return;
    }
    const text =
      lead.type === "company"
        ? formatWhyCompany(id, lead.result)
        : formatWhyPerson(id, lead.result);
    // Company /why cards carry feedback buttons too — same flow as person cards.
    const userId = String(ctx.from.id);
    const currentVote = getFeedbackVote(db, id, userId);
    const keyboard = feedbackButtons(id, currentVote);
    await ctx.reply(text, {
      parse_mode: "MarkdownV2",
      reply_markup: keyboard.reply_markup as InlineKeyboardMarkup,
    });
  });

  bot.command(["company", "co"], async (ctx) => {
    const userId = String(ctx.from.id);
    // Strip the leading command (and optional @botname suffix) plus the first
    // separator. Whatever remains is the (possibly multi-line) name list.
    const stripped = ctx.message.text.replace(
      /^\/(?:company|co)(?:@\w+)?\s*/i,
      "",
    );
    const names = stripped
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (names.length === 0) {
      await ctx.reply(
        "Usage: /company (or /co)\n<one company name per line, up to 10>",
      );
      return;
    }

    const toScreen = names.slice(0, MAX_BATCH);
    const overflow = names.slice(MAX_BATCH);
    const ack = await ctx.reply(
      `🔍 Screening ${toScreen.length} compan${toScreen.length === 1 ? "y" : "ies"}…`,
    );

    let screenOutput: Awaited<ReturnType<typeof screenCompanies>>;
    try {
      screenOutput = await screenCompanies(toScreen);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[/company] error:", err);
      await ctx.telegram.editMessageText(
        ack.chat.id,
        ack.message_id,
        undefined,
        ERROR_REPLY,
      );
      return;
    }

    // Insert one lead row per result, capture the assigned IDs.
    const inserted = screenOutput.results.map((result) => {
      const id = insertLead(db, {
        type: "company",
        raw_text: result.company,
        linkedin_url: null,
        name: null,
        title: null,
        company: result.company,
        company_size: result.size,
        result,
        source: "telegram",
        source_user_id: userId,
      });
      return { id, result };
    });

    const summary = formatCompanySummary(inserted, overflow);
    await ctx.telegram.editMessageText(
      ack.chat.id,
      ack.message_id,
      undefined,
      summary,
      { parse_mode: "MarkdownV2" },
    );
  });

  bot.command("feedback", async (ctx) => {
    const argText = ctx.message.text.split(/\s+/).slice(1).join(" ").trim();
    const parsed = Number.parseInt(argText, 10);
    const n =
      Number.isFinite(parsed) && parsed > 0 && parsed <= 50 ? parsed : 10;
    const rows = recentDownvotes(db, n);
    await ctx.reply(formatFeedbackQueue(rows), { parse_mode: "MarkdownV2" });
  });

  // ---- Callback: feedback button taps ---------------------------------

  bot.on("callback_query", async (ctx) => {
    const cb = ctx.callbackQuery;
    if (!("data" in cb) || typeof cb.data !== "string") {
      await ctx.answerCbQuery();
      return;
    }
    const match = cb.data.match(FEEDBACK_CALLBACK_RE);
    if (!match) {
      await ctx.answerCbQuery();
      return;
    }
    const vote = match[1] as Vote;
    const leadId = Number.parseInt(match[2], 10);
    const userId = String(ctx.from.id);

    upsertFeedback(db, leadId, userId, vote);

    // Update the card's buttons to reflect the current vote.
    try {
      await ctx.editMessageReplyMarkup(
        feedbackButtons(leadId, vote).reply_markup,
      );
    } catch {
      // Message may be too old to edit (>48h) — ignore.
    }

    await ctx.answerCbQuery(`Noted ${vote === "up" ? "👍" : "👎"}`);

    if (vote === "down") {
      await ctx.reply(DOWNVOTE_REASON_PROMPT);
      pendingNotes.set(userId, {
        leadId,
        expiresAt: Date.now() + PENDING_NOTE_TTL_MS,
      });
    } else {
      // Up-vote (or flip from down→up) — clear any pending reason prompt.
      pendingNotes.delete(userId);
    }
  });

  // ---- Text DM: profile paste OR down-vote-reason reply ---------------

  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return; // unknown command — ignore

    const userId = String(ctx.from.id);

    // Down-vote reason capture (lenient + length guard). If a pending prompt
    // exists for this user and hasn't expired:
    //   - text < 50 chars → store as the note, ack, return.
    //   - text ≥ 50 chars → looks like a new profile paste; clear pending and
    //     fall through to normal qualification (do not swallow it).
    // Commands starting with "/" never reach here — middleware above clears
    // pending and the command handler returns first.
    const pending = pendingNotes.get(userId);
    if (pending) {
      if (pending.expiresAt < Date.now()) {
        pendingNotes.delete(userId);
      } else if (text.trim().length < PROFILE_MIN_CHARS) {
        setDownvoteNote(db, pending.leadId, userId, text.trim());
        pendingNotes.delete(userId);
        await ctx.reply(NOTE_SAVED_REPLY);
        return;
      } else {
        // Long message — treat as a new profile paste. Drop the pending
        // prompt so a future profile isn't accidentally annotated.
        pendingNotes.delete(userId);
      }
    }

    // Pull out a LinkedIn URL if present; store separately, qualify the rest.
    const urlMatch = text.match(LINKEDIN_URL_RE);
    const linkedin_url = urlMatch ? urlMatch[0] : null;
    const profileText = linkedin_url
      ? text.replace(linkedin_url, "").trim()
      : text;

    if (profileText.trim().length < 50) {
      await ctx.reply(TOO_SHORT_REPLY);
      return;
    }

    const ack = await ctx.reply(PROCESSING_REPLY);

    try {
      const { profile, result } = await qualifyLead(profileText, {
        // 1.6: when enrichment kicks in (industry or size missing), swap the
        // ack to a "looking up" indicator so the user sees progress.
        onEnrichStart: async (company) => {
          const target = company ? escapeMd(company) : "the company";
          try {
            await ctx.telegram.editMessageText(
              ack.chat.id,
              ack.message_id,
              undefined,
              `🔍 Looking up ${target}…`,
              { parse_mode: "MarkdownV2" },
            );
          } catch {
            // Best-effort UX hint; ignore edit races.
          }
        },
      });

      const id = insertLead(db, {
        type: "person",
        raw_text: text,
        linkedin_url,
        name: profile.name,
        title: profile.title,
        company: profile.company,
        company_size: profile.company_size,
        result,
        source: "telegram",
        source_user_id: userId,
      });

      // NEEDS_INFO cards don't carry vote buttons (no tier to validate).
      const wantsButtons = result.qualified !== "NEEDS_INFO";
      const currentVote = wantsButtons ? getFeedbackVote(db, id, userId) : null;
      const replyMarkup = wantsButtons
        ? (feedbackButtons(id, currentVote).reply_markup as InlineKeyboardMarkup)
        : undefined;

      await ctx.telegram.editMessageText(
        ack.chat.id,
        ack.message_id,
        undefined,
        formatCard(id, profile, result),
        {
          parse_mode: "MarkdownV2",
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        },
      );
    } catch (err) {
      if (err instanceof TooShortError) {
        await ctx.telegram.editMessageText(
          ack.chat.id,
          ack.message_id,
          undefined,
          TOO_SHORT_REPLY,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.error("[qualify] error:", err);
      await ctx.telegram.editMessageText(
        ack.chat.id,
        ack.message_id,
        undefined,
        ERROR_REPLY,
      );
    }
  });

  return bot;
}

// Starts polling. Note: bot.launch() returns a Promise that only resolves on
// shutdown — we intentionally do not await it. The caller wires SIGINT/SIGTERM
// to bot.stop().
export function startBot(config: AppConfig, db: Database.Database): Telegraf {
  const bot = buildBot(config, db);
  bot.launch().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[telegram] launch error:", err);
    process.exit(1);
  });
  return bot;
}
