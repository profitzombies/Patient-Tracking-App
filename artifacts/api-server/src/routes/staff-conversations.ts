import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { resolveOfficeScope } from "../auth/office-scope";
import { hasHqPermission, verifyStaffToken } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";

const router: IRouter = Router();
const enc = encodeURIComponent;
const listQuery = z.object({
  office: z.string().trim().min(1).max(240).optional(),
  thread: z.enum(["coach", "support"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const eventQuery = z.object({
  office: z.string().trim().min(1).max(240).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const uuid = z.string().uuid();

async function scoped(req: Request, thread: "coach" | "support") {
  return resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: thread === "coach" ? "conversation_clinical" : "conversation_support",
    requireUnlocked: false,
  });
}

function patientName(patient: Record<string, unknown>): string {
  const split = [patient.first_name, patient.last_name].filter(value => typeof value === "string" && value.trim()).join(" ");
  return split || String(patient.name ?? "Patient");
}

function summary(row: Record<string, unknown>) {
  const patient = (row.patients ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    patientId: String(row.patient_id),
    patientName: patientName(patient),
    thread: String(row.thread),
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
    createdAt: String(row.created_at),
  };
}

async function findConversation(id: string, providerId: string) {
  const select = "id,patient_id,thread,created_at,patients!inner(provider_id,first_name,last_name,name)";
  const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_conversations?id=eq.${enc(id)}&patients.provider_id=eq.${enc(providerId)}&select=${enc(select)}&limit=1`);
  if (result.status >= 300) throw new Error(`conversation lookup failed (${result.status})`);
  return Array.isArray(result.json) ? result.json[0] as Record<string, unknown> | undefined : undefined;
}

router.get("/office/conversations", async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Check conversation filters." });
    return;
  }
  try {
    let resolved = await scoped(req, parsed.data.thread ?? "coach");
    if (resolved.kind !== "ok" && !parsed.data.thread) resolved = await scoped(req, "support");
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const q = parsed.data;
    let allowedThreads: Array<"coach" | "support"> = q.thread ? [q.thread] : ["coach", "support"];
    if (resolved.scope.actorKind === "hq") {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const staff = token ? await verifyStaffToken(token) : null;
      allowedThreads = [
        ...(staff && hasHqPermission(staff, "conversation_clinical") ? ["coach" as const] : []),
        ...(staff && hasHqPermission(staff, "conversation_support") ? ["support" as const] : []),
      ];
      if (q.thread && !allowedThreads.includes(q.thread)) {
        res.status(403).json({ error: "Your HQ role does not have permission to do this." });
        return;
      }
    }
    const select = "id,patient_id,thread,created_at,updated_at,patients!inner(provider_id,first_name,last_name,name),patient_chat_messages(count)";
    const filters = [
      `patients.provider_id=eq.${enc(resolved.scope.providerId)}`,
      `select=${enc(select)}`,
      "order=updated_at.desc,id.desc",
      `limit=${q.limit}`,
      `offset=${q.offset}`,
    ];
    if (q.thread) filters.push(`thread=eq.${q.thread}`);
    else if (allowedThreads.length === 1) filters.push(`thread=eq.${allowedThreads[0]}`);
    const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_conversations?${filters.join("&")}`, undefined, "count=exact");
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`conversation list failed (${result.status})`);
    const rows = (result.json as Record<string, unknown>[]).map(row => {
      const aggregate = Array.isArray(row.patient_chat_messages) ? row.patient_chat_messages[0] as Record<string, unknown> : {};
      return summary({ ...row, message_count: aggregate?.count ?? 0, last_message_at: row.updated_at });
    });
    const total = Number(result.contentRange?.match(/\/(\d+)$/)?.[1] ?? rows.length);
    res.json({ conversations: rows, total });
  } catch (error) {
    req.log?.error({ err: error }, "conversation list failed");
    res.status(502).json({ error: "Could not load conversations right now." });
  }
});

router.get("/office/conversations/:conversationId/events", async (req, res) => {
  const parsed = eventQuery.safeParse(req.query);
  const id = uuid.safeParse(req.params.conversationId);
  if (!parsed.success || !id.success) {
    res.status(400).json({ error: "Check the conversation request." });
    return;
  }
  try {
    // Resolve coach first to establish office scope. Support-only HQ callers
    // get a second neutral attempt after the thread is known.
    let resolved = await scoped(req, "coach");
    if (resolved.kind !== "ok") resolved = await scoped(req, "support");
    if (resolved.kind !== "ok") {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }
    const conversation = await findConversation(id.data, resolved.scope.providerId);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    // Re-check the exact HQ permission for the persisted thread.
    const exact = await scoped(req, conversation.thread === "support" ? "support" : "coach");
    if (exact.kind !== "ok") {
      res.status(404).json({ error: "Conversation not found." });
      return;
    }
    const filters = [
      `conversation_id=eq.${enc(id.data)}`,
      "select=seq,role,text,stopped,created_at",
      "order=seq.desc",
      `limit=${parsed.data.limit + 1}`,
    ];
    if (parsed.data.before) filters.push(`seq=lt.${parsed.data.before}`);
    const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_messages?${filters.join("&")}`);
    if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`transcript read failed (${result.status})`);
    const page = result.json as Record<string, unknown>[];
    const hasMore = page.length > parsed.data.limit;
    const kept = page.slice(0, parsed.data.limit);
    const nextBefore = hasMore ? Number(kept[kept.length - 1]?.seq) : null;
    await recordAdminAuditEvent({
      action: "conversation_transcript_read",
      actorUserId: exact.scope.actorUserId,
      actorKind: exact.scope.actorKind,
      providerId: exact.scope.providerId,
      targetKind: "patient_chat_conversation",
      targetId: id.data,
      requestId: req.headers["x-request-id"]?.toString() ?? null,
      metadata: { thread: String(conversation.thread) },
    }).catch(error => req.log?.error({ err: error }, "conversation read audit failed"));
    res.json({
      conversation: summary({ ...conversation, message_count: 0, last_message_at: null }),
      events: kept.reverse().map(row => ({
        seq: Number(row.seq), role: String(row.role), text: String(row.text ?? ""),
        stopped: row.stopped === true, createdAt: String(row.created_at),
      })),
      nextBefore,
    });
  } catch (error) {
    req.log?.error({ err: error }, "conversation transcript failed");
    res.status(502).json({ error: "Could not load this conversation right now." });
  }
});

export default router;