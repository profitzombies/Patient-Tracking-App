/**
 * Patient-chat routes — durable per-patient chat transcripts.
 *
 * The coach endpoint is stateless per request (the client replays a bounded
 * history window), and the DEMO persona's transcript deliberately lives only
 * in app memory. For SIGNED-IN patients these routes give each chat surface
 * a durable transcript on the account: the mobile app appends messages once
 * they are FINALIZED on screen (a user message at send, an assistant reply
 * when its paced reveal completes or the patient stops it) and hydrates the
 * stored thread on open, so closing or reinstalling the app resumes the
 * conversation exactly where it left off.
 *
 * Rows store the CLIENT's on-screen message shape — the revealed text
 * exactly as displayed, the stopped flag, the card payload, the curated
 * quick-reply labels, reply linkage, the hidden flag, and a patient-media
 * reference for chat photos — never the model wire shape. Replayed model
 * history still comes from the client per the existing contract (old photos
 * omitted).
 *
 * Contract with the app (context/CoachChatContext.tsx, app/support-chat.tsx):
 *  - GET  /patient-chat/:thread?today=YYYY-MM-DD → { messages, patient }:
 *    the stored transcript (oldest first, capped) plus the greeting facts
 *    (firstName, programDay at the app's own calendar date).
 *  - POST /patient-chat/:thread/messages → { ok }: upsert a batch of
 *    finalized messages by client id. Idempotent — outbox retries land
 *    once, and card-state updates (a food card marked added, a rename)
 *    re-send the same id with the new payload.
 *
 * Threads: "coach" (the patient coach chat) and "support" (the patient's AI
 * support thread). Same auth pattern as the diary rail: bearer session →
 * patients row via lib/patient-auth; the tables are service-role-only.
 */
import { Router, type IRouter } from "express";
import { supabaseAdmin } from "../lib/supabase-admin";
import { dayKeyInTimeZone, maxPlausibleDayKey } from "../lib/local-day";
import { resolvePatient } from "../lib/patient-auth";
import { recordPatientEvent } from "../lib/patient-events";
import { createLimiter, envLimit } from "../coach/limits";
import { clientIp } from "../auth/ledger";
import { inboxFeed } from "../lib/inbox-feed";
import { isOwnPatientMediaPath } from "./patient-media";
import {
  fetchPatientProfile,
  firstNameOf,
  isDateKey,
  programDayFor,
} from "../coach/real-patient";

const router: IRouter = Router();
const enc = encodeURIComponent;

// ── Per-IP limits (demo posture: open route, bounded abuse) ─────────────────

const WAIT_MESSAGE = "Too many requests from this connection. Please wait a moment and try again.";
const DAILY_MESSAGE = "Too many requests today. Please try again tomorrow.";
const BUSY_MESSAGE = "We're a little busy right now. Please try again in a moment.";

const acquireReadSlot = createLimiter({
  burst: envLimit("PATIENT_CHAT_READ_BURST", 30),
  refillPerMinute: 12,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_CHAT_READ_DAILY_BUDGET", 4000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

const acquireWriteSlot = createLimiter({
  burst: envLimit("PATIENT_CHAT_WRITE_BURST", 40),
  refillPerMinute: 20,
  maxConcurrent: 8,
  dailyBudget: envLimit("PATIENT_CHAT_WRITE_DAILY_BUDGET", 8000),
  dailyMessage: DAILY_MESSAGE,
  busyMessage: BUSY_MESSAGE,
  rapidMessage: WAIT_MESSAGE,
});

// ── Validation ───────────────────────────────────────────────────────────────

const THREADS = new Set(["coach", "support"]);
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ROLES = new Set(["user", "assistant"]);
const PHOTO_KINDS = new Set(["menu", "meal", "label"]);
const MEALS = new Set(["breakfast", "lunch", "dinner", "snacks"]);

/** One append batch — the client outbox flushes a handful at a time. */
const MAX_MESSAGES_PER_APPEND = 20;
/** On-screen text cap; support replies are long-form markdown. */
const MAX_TEXT_LENGTH = 40_000;
/** Serialized card payload cap (recipe cards are the largest). */
const MAX_CARD_BYTES = 24_000;
const MAX_QUICK_REPLIES = 4;
const MAX_QUICK_REPLY_LENGTH = 80;
/** Messages returned on hydration — far above the model replay window. */
const TRANSCRIPT_LIMIT = 200;

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export interface ChatWireRow {
  client_id: string;
  role: string;
  text: string;
  stopped: boolean;
  hidden: boolean;
  card: unknown;
  quick_replies: string[] | null;
  reply_to_client_id: string | null;
  photo: Record<string, unknown> | null;
}

/**
 * Insights source keys for the patient-authored rows of a batch — the same
 * `<conversation_id>:<client_id>` form the backfill uses, so a live event and
 * a backfilled one for the same message can never both exist.
 */
export function coachMessageKeys(conversationId: string, rows: ChatWireRow[]): string[] {
  return rows.filter((row) => row.role === "user").map((row) => `${conversationId}:${row.client_id}`);
}

/**
 * One finalized on-screen message from the app, checked field by field into
 * an RPC row. Text is stored verbatim (exactly what was revealed on screen);
 * the photo reference must point inside the calling patient's own
 * patient-media prefix, so a row can never reference someone else's photo.
 */
export function parsePatientChatWireMessage(
  raw: unknown,
  patientId: string,
): { row: ChatWireRow } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "Invalid message." };
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !CLIENT_ID_RE.test(m.id)) {
    return { error: "Invalid message id." };
  }
  if (typeof m.role !== "string" || !ROLES.has(m.role)) {
    return { error: "Invalid message role." };
  }
  if (typeof m.text !== "string" || m.text.length > MAX_TEXT_LENGTH) {
    return { error: "Invalid message text." };
  }
  if (m.stopped !== undefined && typeof m.stopped !== "boolean") {
    return { error: "Invalid message." };
  }
  if (m.hidden !== undefined && typeof m.hidden !== "boolean") {
    return { error: "Invalid message." };
  }

  let card: unknown = null;
  if (m.card !== undefined && m.card !== null) {
    if (typeof m.card !== "object" || Array.isArray(m.card)) return { error: "Invalid card." };
    const kind = (m.card as Record<string, unknown>).kind;
    if (typeof kind !== "string" || kind.length < 1 || kind.length > 40) {
      return { error: "Invalid card." };
    }
    let size = 0;
    try {
      size = JSON.stringify(m.card).length;
    } catch {
      return { error: "Invalid card." };
    }
    if (size > MAX_CARD_BYTES) return { error: "That card is too large to store." };
    card = m.card;
  }

  let quickReplies: string[] | null = null;
  if (m.quickReplies !== undefined && m.quickReplies !== null) {
    if (
      !Array.isArray(m.quickReplies) ||
      m.quickReplies.length < 1 ||
      m.quickReplies.length > MAX_QUICK_REPLIES
    ) {
      return { error: "Invalid quick replies." };
    }
    const labels: string[] = [];
    for (const label of m.quickReplies) {
      if (typeof label !== "string" || label.length < 1 || label.length > MAX_QUICK_REPLY_LENGTH) {
        return { error: "Invalid quick replies." };
      }
      labels.push(label);
    }
    quickReplies = labels;
  }

  let replyTo: string | null = null;
  if (m.replyToId !== undefined && m.replyToId !== null) {
    if (typeof m.replyToId !== "string" || !CLIENT_ID_RE.test(m.replyToId)) {
      return { error: "Invalid reply link." };
    }
    replyTo = m.replyToId;
  }

  let photo: Record<string, unknown> | null = null;
  if (m.photo !== undefined && m.photo !== null) {
    if (typeof m.photo !== "object" || Array.isArray(m.photo)) return { error: "Invalid photo." };
    const p = m.photo as Record<string, unknown>;
    if (typeof p.path !== "string" || !isOwnPatientMediaPath(p.path, patientId)) {
      return { error: "That photo isn't yours to reference." };
    }
    if (!numberIn(p.width, 1, 10_000) || !numberIn(p.height, 1, 10_000)) {
      return { error: "Invalid photo size." };
    }
    photo = { path: p.path, width: Math.round(p.width), height: Math.round(p.height) };
    if (p.kind !== undefined) {
      if (typeof p.kind !== "string" || !PHOTO_KINDS.has(p.kind)) {
        return { error: "Invalid photo kind." };
      }
      photo.kind = p.kind;
    }
    if (p.mealSlot !== undefined) {
      if (typeof p.mealSlot !== "string" || !MEALS.has(p.mealSlot)) {
        return { error: "Invalid photo meal slot." };
      }
      photo.mealSlot = p.mealSlot;
    }
    if (p.reused !== undefined) {
      if (typeof p.reused !== "boolean") return { error: "Invalid photo." };
      if (p.reused) photo.reused = true;
    }
  }

  return {
    row: {
      client_id: m.id,
      role: m.role,
      text: m.text,
      stopped: m.stopped === true,
      hidden: m.hidden === true,
      card,
      quick_replies: quickReplies,
      reply_to_client_id: replyTo,
      photo,
    },
  };
}

/** Stored row → the client's message shape (validated at write time). */
export function rowToPatientChatMessage(raw: unknown): Record<string, unknown> {
  const row = raw as Record<string, unknown>;
  const message: Record<string, unknown> = {
    id: row.client_id,
    role: row.role,
    text: typeof row.text === "string" ? row.text : "",
  };
  if (row.stopped === true) message.stopped = true;
  if (row.hidden === true) message.hidden = true;
  if (row.card !== null && row.card !== undefined) message.card = row.card;
  if (Array.isArray(row.quick_replies) && row.quick_replies.length > 0) {
    message.quickReplies = row.quick_replies;
  }
  if (typeof row.reply_to_client_id === "string" && row.reply_to_client_id.length > 0) {
    message.replyToId = row.reply_to_client_id;
  }
  if (row.photo !== null && row.photo !== undefined) message.photo = row.photo;
  // Care-team replies (written by the staff inbox) carry the sender's
  // display name so the app can label the bubble.
  if (row.role === "staff" && typeof row.sender_label === "string") message.senderLabel = row.sender_label;
  return message;
}

// ── Transcript read ──────────────────────────────────────────────────────────

router.get("/patient-chat/:thread", async (req, res) => {
  const slot = acquireReadSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const thread = req.params.thread;
    if (!THREADS.has(thread)) {
      res.status(404).json({ error: "No such chat thread." });
      return;
    }
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }

    // The app sends its own calendar date so the greeting's program day
    // matches the diary day it is showing. Absent or implausible (older
    // client, wrong device clock), the patient's stored timezone decides
    // below — never the server's UTC clock.
    const todayParam =
      isDateKey(req.query.today) && req.query.today <= maxPlausibleDayKey()
        ? req.query.today
        : null;

    const [profile, conversation] = await Promise.all([
      fetchPatientProfile(auth.patientId),
      supabaseAdmin(
        "GET",
          `/rest/v1/patient_chat_conversations?patient_id=eq.${enc(auth.patientId)}&thread=eq.${enc(thread)}${thread === "coach" ? "&legacy_compat=eq.true" : ""}&select=id`,
      ),
    ]);
    if (conversation.status >= 300 || !Array.isArray(conversation.json)) {
      throw new Error(`chat conversation lookup failed (${conversation.status})`);
    }
    const todayKey = todayParam ?? dayKeyInTimeZone(profile.timezone);
    const conversationRow = conversation.json[0] as { id?: unknown } | undefined;

    let messages: Record<string, unknown>[] = [];
    if (conversationRow && typeof conversationRow.id === "string") {
      // Newest N by seq, then reversed: the cap drops the OLDEST messages
      // when a thread outgrows it, never the latest exchange.
      const stored = await supabaseAdmin(
        "GET",
        `/rest/v1/patient_chat_messages?conversation_id=eq.${enc(conversationRow.id)}&select=client_id,role,text,stopped,hidden,card,quick_replies,reply_to_client_id,photo,sender_label&order=seq.desc&limit=${TRANSCRIPT_LIMIT}`,
      );
      if (stored.status >= 300 || !Array.isArray(stored.json)) {
        throw new Error(`chat transcript read failed (${stored.status})`);
      }
      messages = (stored.json as unknown[]).reverse().map(rowToPatientChatMessage);
    }

    res.json({
      messages,
      patient: {
        firstName: firstNameOf(profile.name),
        programDay: programDayFor(profile, todayKey),
      },
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient-chat read failed");
    res.status(502).json({ error: "Couldn't load your conversation right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

// ── Finalized-message append ─────────────────────────────────────────────────

router.post("/patient-chat/:thread/messages", async (req, res) => {
  const slot = acquireWriteSlot(clientIp(req));
  if (!slot.ok) {
    res.status(slot.status).json({ error: slot.message });
    return;
  }
  try {
    const thread = req.params.thread;
    if (!THREADS.has(thread)) {
      res.status(404).json({ error: "No such chat thread." });
      return;
    }
    const auth = await resolvePatient(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error, ...auth.details });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (
      !Array.isArray(body.messages) ||
      body.messages.length < 1 ||
      body.messages.length > MAX_MESSAGES_PER_APPEND
    ) {
      res.status(400).json({ error: "Invalid message batch." });
      return;
    }
    const rows: ChatWireRow[] = [];
    for (const raw of body.messages) {
      const parsed = parsePatientChatWireMessage(raw, auth.patientId);
      if ("error" in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      rows.push(parsed.row);
    }

    // Conversation upsert + message upserts land in ONE transaction via the
    // patient_chat_apply function, so a mid-write failure can never strand
    // half a batch. Merges preserve seq/created_at — updates never reorder
    // the transcript.
    const applied = await supabaseAdmin("POST", "/rest/v1/rpc/patient_chat_apply", {
      p_patient_id: auth.patientId,
      p_thread: thread,
      p_messages: rows,
    });
    if (applied.status >= 300) throw new Error(`chat apply failed (${applied.status})`);
    // Staff inbox streams hear about the new rows now, not at the next tick.
    inboxFeed.poke();
    // HQ Insights: patient-authored coach rows are coach_message events
    // (support thread messages are not tracked). The RPC returns the
    // conversation it wrote into; events are keyed on
    // <conversation_id>:<client_id> so a replayed transcript inserts nothing.
    if (thread === "coach") {
      // The transcript is saved either way; a missing id is an analytics
      // gap to log, never a failed save.
      const conversationId = typeof applied.json === "string" ? applied.json : null;
      if (conversationId) {
        recordPatientEvent(auth.patientId, "coach_message", { headers: req.headers, sourceKeys: coachMessageKeys(conversationId, rows) });
      } else {
        req.log?.warn({ patientId: auth.patientId }, "patient-chat apply returned no conversation id; coach_message events skipped");
      }
    }

    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient-chat write failed");
    res.status(502).json({ error: "Couldn't save your conversation right now. Please try again." });
  } finally {
    slot.ok && slot.release();
  }
});

export default router;
