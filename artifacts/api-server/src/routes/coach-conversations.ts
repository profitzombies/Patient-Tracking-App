/**
 * Authenticated, separately addressable patient Coach conversations.
 * Transcript bodies stay on the service-only patient_chat_* rail; all ids in
 * this router are scoped in SQL to the bearer-derived patient or office.
 */
import { Router, type IRouter, type Response } from "express";
import { COACH_TITLE_MAX_CHARS, shapeCoachTitle } from "../coach/title";
import { z } from "zod";
import { resolveOfficeScope, respondOfficeScopeDenied } from "../auth/office-scope";
import { supabaseAdmin } from "../lib/supabase-admin";
import { resolvePatient } from "../lib/patient-auth";
import { dayKeyInTimeZone, maxPlausibleDayKey } from "../lib/local-day";
import { objectStorage } from "../lib/objectStorage";
import { fetchPatientProfile, firstNameOf, isDateKey, programDayFor } from "../coach/real-patient";
import {
  parsePatientChatWireMessage,
  rowToPatientChatMessage,
  type ChatWireRow,
} from "./patient-chat";
import { isOwnPatientMediaPath } from "./patient-media";

const router: IRouter = Router();
const enc = encodeURIComponent;
const STAFF_PHOTO_TTL_SEC = 15 * 60;
const uuid = z.string().uuid();
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const detailPage = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  today: z.string().max(20).optional(),
});
const createBody = z.object({ clientKey: z.string().trim().min(1).max(128) }).strict();
// One PATCH, two intents: archive/restore, or rename. Never both at once.
const updateBody = z.union([
  z.object({ archived: z.boolean(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ title: z.string().min(1).max(200), expectedVersion: z.number().int().positive() }).strict(),
]);

interface ConversationRow {
  id: unknown;
  title: unknown;
  title_state: unknown;
  archived_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  version: unknown;
  processing_state: unknown;
  total?: unknown;
}

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

/** The only public conversation DTO; never leak client_key or compatibility state. */
export function coachConversationDto(row: ConversationRow) {
  return {
    id: String(row.id),
    title: typeof row.title === "string" && row.title.trim() ? row.title : "New conversation",
    titleState: row.title_state === "ready" || row.title_state === "failed" ? row.title_state : "pending",
    archivedAt: typeof row.archived_at === "string" ? row.archived_at : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    version: Number(row.version),
    processingState:
      row.processing_state === "ready" || row.processing_state === "failed"
        ? row.processing_state
        : "pending",
  };
}

export function coachMessageDto(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...rowToPatientChatMessage(row),
    seq: Number(row.seq),
    createdAt: String(row.created_at),
  };
}

async function rpc(name: string, body: Record<string, unknown>) {
  return supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
}

async function loadConversation(patientId: string, conversationId: string): Promise<ConversationRow | null> {
  const result = await rpc("coach_conversation_get", {
    p_patient_id: patientId,
    p_conversation_id: conversationId,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`coach conversation lookup failed (${result.status})`);
  }
  return (result.json[0] as ConversationRow | undefined) ?? null;
}

async function messagesPage(conversationId: string, before: number | undefined, limit: number) {
  const filters = [
    `conversation_id=eq.${enc(conversationId)}`,
    "select=client_id,role,text,stopped,hidden,card,quick_replies,reply_to_client_id,photo,seq,created_at",
    "order=seq.desc",
    `limit=${limit + 1}`,
  ];
  if (before) filters.push(`seq=lt.${before}`);
  const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_messages?${filters.join("&")}`);
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`coach transcript read failed (${result.status})`);
  }
  const newestFirst = result.json as Record<string, unknown>[];
  const hasMore = newestFirst.length > limit;
  const kept = newestFirst.slice(0, limit);
  // The REST result is descending. Preserve its oldest returned sequence as
  // the exclusive cursor before reversing for the chronological API response.
  const nextBefore = hasMore ? Number(kept[kept.length - 1]?.seq) : null;
  return {
    messages: kept.reverse().map(coachMessageDto),
    nextBefore,
  };
}

/**
 * A staff transcript is authorized at the conversation route before this runs.
 * A stored object path remains an internal reference: it becomes a short-lived
 * URL only after its exact patient_media ledger ownership is verified.
 */
async function secureProviderMessagePhoto(patientId: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const photo = message.photo;
  if (typeof photo !== "object" || photo === null || Array.isArray(photo)) return message;
  const raw = photo as Record<string, unknown>;
  const path = raw.path;
  if (typeof path !== "string" || !isOwnPatientMediaPath(path, patientId)) {
    delete message.photo;
    return message;
  }
  const ledger = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_media?patient_id=eq.${enc(patientId)}&object_path=eq.${enc(path)}&select=object_path&limit=1`,
  );
  if (ledger.status >= 300 || !Array.isArray(ledger.json)) {
    throw new Error(`staff coach photo ownership lookup failed (${ledger.status})`);
  }
  if (!ledger.json.some(entry => (
    typeof entry === "object" && entry !== null
    && (entry as Record<string, unknown>).object_path === path
  ))) {
    delete message.photo;
    return message;
  }
  const safePhoto: Record<string, unknown> = {
    secureUrl: await objectStorage.signedDownloadURL(path, STAFF_PHOTO_TTL_SEC),
  };
  if (typeof raw.width === "number") safePhoto.width = raw.width;
  if (typeof raw.height === "number") safePhoto.height = raw.height;
  if (typeof raw.kind === "string") safePhoto.kind = raw.kind;
  if (typeof raw.mealSlot === "string") safePhoto.mealSlot = raw.mealSlot;
  message.photo = safePhoto;
  return message;
}

async function providerMessagesPage(patientId: string, conversationId: string, before: number | undefined, limit: number) {
  const result = await messagesPage(conversationId, before, limit);
  return {
    ...result,
    messages: await Promise.all(result.messages.map(message => secureProviderMessagePhoto(patientId, message))),
  };
}

async function greeting(patientId: string, today?: string) {
  const profile = await fetchPatientProfile(patientId);
  const todayKey = today && isDateKey(today) && today <= maxPlausibleDayKey()
    ? today
    : dayKeyInTimeZone(profile.timezone);
  return { firstName: firstNameOf(profile.name), programDay: programDayFor(profile, todayKey) };
}

async function officeConversation(
  patientId: string,
  conversationId: string | null,
): Promise<ConversationRow | null> {
  const select = "id,title,title_state,archived_at,created_at,updated_at,version,processing_state";
  const filters = [
    `patient_id=eq.${enc(patientId)}`,
    "thread=eq.coach",
    `select=${enc(select)}`,
    "limit=1",
  ];
  if (conversationId) filters.unshift(`id=eq.${enc(conversationId)}`);
  const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_conversations?${filters.join("&")}`);
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office coach conversation lookup failed (${result.status})`);
  }
  return (result.json[0] as ConversationRow | undefined) ?? null;
}

/** Exact current-office check used even when a patient has no conversations. */
async function officePatientExists(patientId: string, providerId: string): Promise<boolean> {
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&provider_id=eq.${enc(providerId)}&archived_at=is.null&deletion_requested_at=is.null&select=id&limit=1`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`office coach patient lookup failed (${result.status})`);
  }
  return result.json.length === 1;
}

router.get("/patient-coach/conversations", async (req, res) => {
  privateResponse(res);
  const parsed = page.safeParse(req.query);
  if (!parsed.success || (req.query.archived !== undefined && req.query.archived !== "true" && req.query.archived !== "false")) {
    res.status(400).json({ error: "Check conversation paging." });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const archived = req.query.archived === "true";
    const result = await rpc("coach_conversation_list", {
      p_patient_id: auth.patientId, p_archived: archived, p_limit: parsed.data.limit, p_offset: parsed.data.offset,
    });
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`coach list failed (${result.status})`);
    const rows = result.json as ConversationRow[];
    const conversations = rows.map(coachConversationDto);
    const total = Number(rows[0]?.total ?? 0);
    res.json({ conversations, total, nextOffset: parsed.data.offset + conversations.length < total ? parsed.data.offset + conversations.length : null });
  } catch (error) {
    req.log?.error({ err: error }, "patient coach conversation list failed");
    res.status(502).json({ error: "Couldn't load your conversations right now. Please try again." });
  }
});

router.post("/patient-coach/conversations", async (req, res) => {
  privateResponse(res);
  const body = createBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Invalid client key." }); return; }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const result = await rpc("coach_conversation_create", { p_patient_id: auth.patientId, p_client_key: body.data.clientKey });
    if (result.status >= 300 || !Array.isArray(result.json) || !result.json[0]) {
      throw new Error(`coach create failed (${result.status})`);
    }
    res.json({ conversation: coachConversationDto(result.json[0] as ConversationRow) });
  } catch (error) {
    req.log?.error({ err: error }, "patient coach conversation create failed");
    res.status(502).json({ error: "Couldn't start a conversation right now. Please try again." });
  }
});

router.get("/patient-coach/conversations/:conversationId", async (req, res) => {
  privateResponse(res);
  const id = uuid.safeParse(req.params.conversationId);
  const parsed = detailPage.safeParse(req.query);
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Check the conversation request." }); return; }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const conversation = await loadConversation(auth.patientId, id.data);
    if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
    const [pageResult, patient] = await Promise.all([
      messagesPage(id.data, parsed.data.before, parsed.data.limit),
      greeting(auth.patientId, parsed.data.today),
    ]);
    res.json({ conversation: coachConversationDto(conversation), ...pageResult, patient });
  } catch (error) {
    req.log?.error({ err: error }, "patient coach conversation read failed");
    res.status(502).json({ error: "Couldn't load this conversation right now. Please try again." });
  }
});

router.post("/patient-coach/conversations/:conversationId/messages", async (req, res) => {
  privateResponse(res);
  const id = uuid.safeParse(req.params.conversationId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!id.success || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 20) {
    res.status(400).json({ error: "Invalid message batch." });
    return;
  }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const rows: ChatWireRow[] = [];
    for (const message of body.messages) {
      const parsed = parsePatientChatWireMessage(message, auth.patientId);
      if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
      rows.push(parsed.row);
    }
    const result = await rpc("coach_conversation_append", {
      p_patient_id: auth.patientId, p_conversation_id: id.data, p_messages: rows,
    });
    if (result.status >= 300) throw new Error(`coach append failed (${result.status})`);
    if (result.json === "missing") { res.status(404).json({ error: "Conversation not found." }); return; }
    if (result.json === "archived") { res.status(403).json({ error: "Restore this conversation before continuing." }); return; }
    if (result.json !== "ok") throw new Error("unexpected coach append result");
    res.json({ ok: true });
  } catch (error) {
    req.log?.error({ err: error }, "patient coach conversation append failed");
    res.status(502).json({ error: "Couldn't save your conversation right now. Please try again." });
  }
});

router.patch("/patient-coach/conversations/:conversationId", async (req, res) => {
  privateResponse(res);
  const id = uuid.safeParse(req.params.conversationId);
  const body = updateBody.safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: "Invalid conversation update." }); return; }
  try {
    const auth = await resolvePatient(req);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error, ...auth.details }); return; }
    const result = "title" in body.data
      ? await rpc("coach_conversation_rename", {
        p_patient_id: auth.patientId, p_conversation_id: id.data,
        p_title: shapeCoachTitle(body.data.title), p_expected_version: body.data.expectedVersion,
      })
      : await rpc("coach_conversation_archive", {
        p_patient_id: auth.patientId, p_conversation_id: id.data,
        p_archived: body.data.archived, p_expected_version: body.data.expectedVersion,
      });
    if (result.status >= 300) throw new Error(`coach conversation update failed (${result.status})`);
    if (result.json === "invalid") { res.status(400).json({ error: `Give the conversation a name of 1 to ${COACH_TITLE_MAX_CHARS} characters.` }); return; }
    if (result.json === "missing") { res.status(404).json({ error: "Conversation not found." }); return; }
    if (result.json === "conflict") { res.status(409).json({ error: "This conversation changed. Refresh and try again." }); return; }
    const conversation = await loadConversation(auth.patientId, id.data);
    if (!conversation) throw new Error("updated conversation disappeared");
    res.json({ conversation: coachConversationDto(conversation) });
  } catch (error) {
    req.log?.error({ err: error }, "patient coach conversation update failed");
    res.status(502).json({ error: "Couldn't update this conversation right now. Please try again." });
  }
});

router.get("/office/patients/:patientId/coach-conversations", async (req, res) => {
  privateResponse(res);
  const parsed = page.safeParse(req.query);
  const patientId = uuid.safeParse(req.params.patientId);
  if (!parsed.success || !patientId.success) { res.status(400).json({ error: "Check the conversation request." }); return; }
  try {
    const scoped = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "conversation_clinical",
      requireUnlocked: true,
    });
    if (scoped.kind !== "ok") { respondOfficeScopeDenied(req, res, scoped); return; }
    if (!await officePatientExists(patientId.data, scoped.scope.providerId)) {
      res.status(404).json({ error: "Patient record not found." });
      return;
    }
    const select = "id,title,title_state,archived_at,created_at,updated_at,version,processing_state";
    const result = await supabaseAdmin("GET",
      `/rest/v1/patient_chat_conversations?patient_id=eq.${enc(patientId.data)}&thread=eq.coach&select=${enc(select)}&order=updated_at.desc,id.desc&limit=${parsed.data.limit}&offset=${parsed.data.offset}`,
      undefined, "count=exact");
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`office coach list failed (${result.status})`);
    const conversations = (result.json as ConversationRow[]).map(coachConversationDto);
    const total = Number(result.contentRange?.match(/\/(\d+)$/)?.[1] ?? conversations.length);
    res.json({ conversations, total, nextOffset: parsed.data.offset + conversations.length < total ? parsed.data.offset + conversations.length : null });
  } catch (error) {
    req.log?.error({ err: error }, "office coach conversation list failed");
    res.status(502).json({ error: "Couldn't load coach conversations right now. Please try again." });
  }
});

router.get("/office/patients/:patientId/coach-conversations/:conversationId", async (req, res) => {
  privateResponse(res);
  const patientId = uuid.safeParse(req.params.patientId);
  const conversationId = uuid.safeParse(req.params.conversationId);
  const parsed = detailPage.omit({ today: true }).safeParse(req.query);
  if (!patientId.success || !conversationId.success || !parsed.success) {
    res.status(400).json({ error: "Check the conversation request." }); return;
  }
  try {
    const scoped = await resolveOfficeScope({
      authorization: req.headers.authorization,
      request: req,
      explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
      hqPermission: "conversation_clinical",
      requireUnlocked: true,
    });
    if (scoped.kind !== "ok") { respondOfficeScopeDenied(req, res, scoped); return; }
    if (!await officePatientExists(patientId.data, scoped.scope.providerId)) {
      res.status(404).json({ error: "Patient record not found." });
      return;
    }
    const conversation = await officeConversation(patientId.data, conversationId.data);
    if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
    const [pageResult, patient] = await Promise.all([
      providerMessagesPage(patientId.data, conversationId.data, parsed.data.before, parsed.data.limit),
      greeting(patientId.data),
    ]);
    res.json({ conversation: coachConversationDto(conversation), ...pageResult, patient });
  } catch (error) {
    req.log?.error({ err: error }, "office coach conversation read failed");
    res.status(502).json({ error: "Couldn't load this coach conversation right now. Please try again." });
  }
});

export default router;