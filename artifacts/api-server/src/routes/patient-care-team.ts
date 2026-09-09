import { Router, type IRouter } from "express";
import { z } from "zod";
import { resolvePatient } from "../lib/patient-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent, requestIdOf } from "../lib/admin-audit";

const router: IRouter = Router();
const enc = encodeURIComponent;
const uuid = z.string().uuid();
const clientId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const messageBody = z.object({ clientId, text: z.string().min(1).max(4000) }).strict();
const readBody = z.object({ throughSeq: z.number().int().positive() }).strict();
const pageQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(value => !(value.before && value.after));

type Row = Record<string, unknown>;

function businessName(row: Row): string {
  const provider = (row.providers ?? {}) as Row;
  return String(row.office_name || provider.office_name || provider.provider_name || "Care Team");
}

function conversationDto(row: Row, currentProvider: string) {
  const lastSeq = Number(row.last_seq ?? 0);
  const readSeq = Number(row.last_read_seq ?? 0);
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    businessName: businessName(row),
    current: row.provider_id === currentProvider,
    canSend: row.provider_id === currentProvider && row.office_available !== false,
    status: String(row.status ?? "open"),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessageSeq: lastSeq,
    lastReadSeq: readSeq,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function patientMessage(row: Row) {
  return {
    seq: Number(row.seq),
    clientId: String(row.client_id),
    sender: row.role === "user" ? "patient" : "care_team",
    text: String(row.text ?? ""),
    createdAt: String(row.created_at),
  };
}

async function patientRecord(patientId: string): Promise<Row | null> {
  const result = await supabaseAdmin("GET",
    `/rest/v1/patients?id=eq.${enc(patientId)}&archived_at=is.null&deletion_requested_at=is.null&select=id,provider_id,activation_status&limit=1`);
  if (result.status >= 300) throw new Error(`patient state lookup failed (${result.status})`);
  return Array.isArray(result.json) ? (result.json[0] as Row | undefined) ?? null : null;
}

const CONVERSATION_SELECT = "id,patient_id,provider_id,status,created_at,updated_at,providers(provider_name,office_name)";

async function patientConversation(patientId: string, id: string): Promise<Row | null> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_patient_bootstrap",
    { p_patient_id: patientId });
  if (result.status >= 300) throw new Error(`care team lookup failed (${result.status})`);
  return Array.isArray(result.json)
    ? (result.json as Row[]).find(row => row.id === id) ?? null : null;
}

async function authenticated(req: Parameters<typeof resolvePatient>[0], res: {
  status(code: number): { json(value: unknown): unknown };
}) {
  const auth = await resolvePatient(req);
  if (!auth.ok) {
    res.status(auth.status).json({ error: auth.error, ...auth.details });
    return null;
  }
  const patient = await patientRecord(auth.patientId);
  if (!patient || patient.activation_status === "disabled") {
    res.status(403).json({ error: "Messaging is unavailable for this account." });
    return null;
  }
  return { auth, patient, providerId: String(patient.provider_id) };
}

router.get("/patient-care-team", async (req, res) => {
  try {
    const found = await authenticated(req, res);
    if (!found) return;
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_patient_bootstrap",
      { p_patient_id: found.auth.patientId });
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`care team bootstrap failed (${result.status})`);
    const rows = result.json as Row[];
    const dtos = rows.map(row => conversationDto(row, found.providerId));
    res.json({ current: dtos.find(row => row.current) ?? null, retained: dtos.filter(row => !row.current) });
  } catch (error) {
    req.log?.error({ err: error }, "patient care team bootstrap failed");
    res.status(502).json({ error: "Couldn't load your care team conversation right now." });
  }
});

router.post("/patient-care-team/start", async (req, res) => {
  if (req.body && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)) {
    res.status(400).json({ error: "Check the request." }); return;
  }
  try {
    const found = await authenticated(req, res);
    if (!found) return;
    const started = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_start",
      { p_patient_id: found.auth.patientId, p_provider_id: found.providerId });
    if (started.status >= 300) throw new Error(`care team start failed (${started.status})`);
    const payload = started.json as { conversationId?: unknown; created?: unknown };
    const row = typeof payload?.conversationId === "string"
      ? await patientConversation(found.auth.patientId, payload.conversationId) : null;
    if (!row) throw new Error("care team start returned no conversation");
    res.json({ conversation: conversationDto(row, found.providerId), created: payload.created === true });
  } catch (error) {
    req.log?.error({ err: error }, "patient care team start failed");
    res.status(502).json({ error: "Couldn't start your care team conversation right now." });
  }
});

router.get("/patient-care-team/:conversationId/messages", async (req, res) => {
  const id = uuid.safeParse(req.params.conversationId);
  const page = pageQuery.safeParse(req.query);
  if (!id.success || !page.success) { res.status(400).json({ error: "Check the message request." }); return; }
  try {
    const found = await authenticated(req, res);
    if (!found) return;
    const conversation = await patientConversation(found.auth.patientId, id.data);
    if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
    const q = page.data;
    const filters = [`conversation_id=eq.${enc(id.data)}`,
      "select=seq,client_id,role,text,created_at", `limit=${q.limit + 1}`];
    if (q.after) filters.push(`seq=gt.${q.after}`, "order=seq.asc");
    else filters.push(q.before ? `seq=lt.${q.before}` : "seq=gt.0", "order=seq.desc");
    const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_messages?${filters.join("&")}`);
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`care team messages failed (${result.status})`);
    const hasMore = result.json.length > q.limit;
    let rows = (result.json as Row[]).slice(0, q.limit);
    if (!q.after) rows = rows.reverse();
    res.json({
      conversation: conversationDto(conversation, found.providerId),
      messages: rows.map(patientMessage),
      nextBefore: !q.after && hasMore && rows.length ? Number(rows[0].seq) : null,
      nextAfter: q.after && hasMore && rows.length ? Number(rows[rows.length - 1].seq) : null,
    });
  } catch (error) {
    req.log?.error({ err: error }, "patient care team messages failed");
    res.status(502).json({ error: "Couldn't load messages right now." });
  }
});

router.post("/patient-care-team/:conversationId/messages", async (req, res) => {
  const id = uuid.safeParse(req.params.conversationId);
  const body = messageBody.safeParse(req.body);
  if (!id.success || !body.success || !body.data.text.trim()) {
    res.status(400).json({ error: "Check your message." }); return;
  }
  try {
    const found = await authenticated(req, res);
    if (!found) return;
    const conversation = await patientConversation(found.auth.patientId, id.data);
    if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
    if (conversation.provider_id !== found.providerId) {
      res.status(409).json({ error: "This retained conversation is read-only." }); return;
    }
    if (conversation.office_available === false) {
      res.status(403).json({ error: "Messaging is unavailable while your care team's office is locked." }); return;
    }
    const sent = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_send", {
      p_conversation_id: id.data, p_patient_id: found.auth.patientId, p_provider_id: found.providerId,
      p_client_id: body.data.clientId, p_text: body.data.text.trim(), p_role: "user",
      p_sender_user_id: null, p_sender_label: null, p_enqueue_push: false,
    });
    if (sent.status === 409 || (sent.status >= 300 && JSON.stringify(sent.json).includes("payload conflict"))) {
      res.status(409).json({ error: "That message id was already used for different content." }); return;
    }
    if (sent.status >= 300) throw new Error(`care team send failed (${sent.status})`);
    const payload = sent.json as Row;
    res.json({ message: patientMessage({
      seq: payload.seq, client_id: payload.clientId, role: payload.role,
      text: payload.text, created_at: payload.createdAt,
    }), created: payload.created === true });
  } catch (error) {
    req.log?.error({ err: error }, "patient care team send failed");
    res.status(502).json({ error: "Couldn't send your message right now." });
  }
});

router.post("/patient-care-team/:conversationId/read", async (req, res) => {
  const id = uuid.safeParse(req.params.conversationId);
  const body = readBody.safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: "Check the read marker." }); return; }
  try {
    const found = await authenticated(req, res);
    if (!found) return;
    if (!await patientConversation(found.auth.patientId, id.data)) {
      res.status(404).json({ error: "Conversation not found." }); return;
    }
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_patient_read", {
      p_conversation_id: id.data, p_patient_id: found.auth.patientId, p_through_seq: body.data.throughSeq,
    });
    if (result.status >= 300) throw new Error(`care team read failed (${result.status})`);
    const payload = result.json as { changed?: unknown };
    if (payload.changed === true) {
      void recordAdminAuditEvent({
        action: "patient_care_team_read", actorUserId: found.auth.authUserId,
        actorKind: "patient", providerId: String((await patientConversation(found.auth.patientId, id.data))?.provider_id ?? ""),
        targetKind: "patient_chat_conversation", targetId: id.data,
        requestId: requestIdOf(req), metadata: { throughSeq: body.data.throughSeq },
      }).catch(error => req.log?.error({ err: error }, "patient care-team read audit failed"));
    }
    res.json(result.json);
  } catch (error) {
    req.log?.error({ err: error }, "patient care team read failed");
    res.status(502).json({ error: "Couldn't update your read position right now." });
  }
});

export default router;