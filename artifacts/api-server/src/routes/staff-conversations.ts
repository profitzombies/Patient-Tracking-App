/**
 * Staff inbox over the persisted patient chat.
 *
 * Office staff (provider owner, team members) work their own office's coach
 * and support threads; HQ roles reach an office through ?office= and the
 * clinical/support permission split (coach threads need
 * conversation_clinical, support threads conversation_support). Every route
 * resolves scope through resolveOfficeScope, then loads the conversation
 * through the inbox RPC which is itself office-scoped, so a cross-office id
 * is indistinguishable from a missing one (neutral 404).
 *
 * Workflow state (status, awaiting stretch, response accumulators) is owned
 * by the database trigger on patient_chat_messages; this router only writes
 * the explicit staff intents (assign, status, reply row, note, escalation)
 * and re-reads the summary afterwards so the client always sees the
 * trigger's verdict, never an optimistic guess.
 *
 * Every staff action lands in the admin audit ledger (metadata only: thread,
 * ids, department; never message or note text).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { resolveOfficeScope, respondOfficeScopeDenied, type OfficeScope } from "../auth/office-scope";
import { hasHqPermission, verifyStaffToken, type HqPermission, type StaffIdentity } from "../lib/staff-auth";
import { supabaseAdmin } from "../lib/supabase-admin";
import { recordAdminAuditEvent } from "../lib/admin-audit";
import { supabaseNotificationStore, type NotificationStore } from "../notifications/store";
import { loadOrgPolicy } from "../lib/org-policy";
import {
  buildProductSuggestion,
  ProductSuggestionError,
  productSuggestionInputSchema,
  suggestionFromCard,
  suggestionPushBody,
} from "../billing/product-suggestions";

const enc = encodeURIComponent;
type Row = Record<string, unknown>;
type Thread = "coach" | "support" | "care_team";
type Department = "clinical" | "support";
const THREADS: Thread[] = ["coach", "support", "care_team"];
const THREAD_PERMISSION: Record<Thread, HqPermission> = {
  coach: "conversation_clinical",
  support: "conversation_support",
  care_team: "conversation_clinical",
};
const DEPARTMENT_PERMISSION: Record<Department, HqPermission> = {
  clinical: "conversation_clinical",
  support: "conversation_support",
};

export const CARE_TEAM_REPLY_KIND = "care_team_reply";
export const CARE_TEAM_REPLY_TITLE = "A message from your care team";
export const CARE_TEAM_REPLY_ROUTE: Record<Thread, string> = {
  coach: "/coach-chat",
  support: "/support-chat",
  care_team: "/care-team-chat",
};
const CARE_TEAM_REPLY_BODY_MAX = 140;
const NOT_FOUND = "Conversation not found.";
const HQ_FORBIDDEN = "Your HQ role does not have permission to do this.";

const officeParam = z.string().trim().min(1).max(240).optional();
const listQuery = z.object({
  office: officeParam,
  channel: z.enum(["all", "care_team", "ai"]).default("all"),
  patientId: z.string().uuid().optional(),
  thread: z.enum(["coach", "support", "care_team"]).optional(),
  status: z.enum(["open", "waiting_patient", "closed"]).optional(),
  assignee: z.string().trim().min(1).max(80).optional(),
  unread: z.enum(["true", "false"]).optional(),
  q: z.string().trim().max(120).optional(),
  sort: z.enum(["newest", "oldest", "waiting_longest", "unread_first"]).default("newest"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const officeQuery = z.object({ office: officeParam });
const eventQuery = z.object({
  office: officeParam,
  before: z.coerce.number().int().positive().optional(),
  after: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(value => !(value.before && value.after));
const assignBody = z.object({ assigneeUserId: z.string().trim().min(1).max(80).nullable() }).strict();
const statusBody = z.object({ status: z.enum(["open", "waiting_patient", "closed"]) }).strict();
const replyBody = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).optional(),
  text: z.string().min(1).max(4000),
  suggestion: productSuggestionInputSchema.nullable().optional(),
}).strict();
const startBody = z.object({ patientId: z.string().uuid() }).strict();
const readBody = z.object({ throughSeq: z.number().int().positive() }).strict();
const noteBody = z.object({ body: z.string().min(1).max(4000) }).strict();
const escalationBody = z
  .object({ department: z.enum(["clinical", "support"]), reason: z.string().min(1).max(2000) })
  .strict();
const hqEscalationQuery = z.object({
  department: z.enum(["clinical", "support"]).optional(),
  status: z.enum(["open", "resolved"]).default("open"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const hqConversationQuery = listQuery.extend({ office: z.string().trim().min(1).max(240).optional() });
const resolveBody = z.object({ note: z.string().max(2000).nullable().optional() }).strict();
const uuid = z.string().uuid();

// ── Scope helpers ───────────────────────────────────────────────────────────

function bearer(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function scoped(req: Request, thread: Thread) {
  return resolveOfficeScope({
    authorization: req.headers.authorization,
    explicitOfficeId: typeof req.query.office === "string" ? req.query.office : null,
    hqPermission: THREAD_PERMISSION[thread],
    requireUnlocked: true,
  });
}

/**
 * Establishes office scope for a request that may touch either thread: the
 * coach attempt first, then support for support-only HQ roles. Returns the
 * scope plus the threads this actor may see (office staff: both; HQ: by
 * permission).
 */
async function scopeForInbox(req: Request, res: Response): Promise<{ scope: OfficeScope; threads: Thread[] } | null> {
  let resolved = await scoped(req, "coach");
  if (resolved.kind !== "ok") resolved = await scoped(req, "support");
  if (resolved.kind !== "ok") {
    respondOfficeScopeDenied(req, res, resolved);
    return null;
  }
  let threads: Thread[] = [...THREADS];
  if (resolved.scope.actorKind === "hq") {
    const token = bearer(req);
    const staff = token ? await verifyStaffToken(token) : null;
    threads = THREADS.filter(thread => staff && hasHqPermission(staff, THREAD_PERMISSION[thread]));
  }
  return { scope: resolved.scope, threads };
}

function patientName(row: Record<string, unknown>): string {
  const split = [row.first_name, row.last_name].filter(value => typeof value === "string" && value.trim()).join(" ");
  return split || String(row.name ?? "Patient");
}

// ── Actor labels ────────────────────────────────────────────────────────────

const HQ_LABEL = "THINNR HQ";

/** The display name stamped on replies, notes, and assignments for this actor. */
export async function actorLabel(scope: OfficeScope): Promise<string> {
  try {
    if (scope.actorKind === "provider") {
      const res = await supabaseAdmin(
        "GET",
        `/rest/v1/providers?auth_user_id=eq.${enc(scope.actorUserId)}&select=provider_name,office_name&limit=1`,
      );
      const row = Array.isArray(res.json) ? (res.json[0] as Record<string, unknown> | undefined) : undefined;
      const name = row && typeof row.provider_name === "string" && row.provider_name.trim() ? row.provider_name.trim() : "";
      return name || scope.providerName || scope.officeName;
    }
    if (scope.actorKind === "team_member") {
      const res = await supabaseAdmin(
        "GET",
        `/rest/v1/team_members?auth_user_id=eq.${enc(scope.actorUserId)}&provider_id=eq.${enc(scope.providerId)}&select=name&limit=1`,
      );
      const row = Array.isArray(res.json) ? (res.json[0] as Record<string, unknown> | undefined) : undefined;
      const name = row && typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
      return name || `${scope.officeName} care team`;
    }
    const res = await supabaseAdmin(
      "GET",
      `/rest/v1/hq_memberships?auth_user_id=eq.${enc(scope.actorUserId)}&status=eq.active&select=display_name&limit=1`,
    );
    const row = Array.isArray(res.json) ? (res.json[0] as Record<string, unknown> | undefined) : undefined;
    const name = row && typeof row.display_name === "string" && row.display_name.trim() ? row.display_name.trim() : "";
    return name ? `${name} (${HQ_LABEL})` : HQ_LABEL;
  } catch {
    return scope.actorKind === "hq" ? HQ_LABEL : `${scope.officeName} care team`;
  }
}

interface StaffMember {
  userId: string;
  label: string;
  kind: "provider" | "team_member";
}

/** Assignable people in an office: the owner account plus linked team members. */
async function officeStaff(providerId: string): Promise<StaffMember[]> {
  const [owner, team] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/providers?provider_id=eq.${enc(providerId)}&select=auth_user_id,provider_name,office_name&limit=1`),
    supabaseAdmin(
      "GET",
      `/rest/v1/team_members?provider_id=eq.${enc(providerId)}&auth_user_id=not.is.null&activation_status=neq.disabled&select=auth_user_id,name&order=name.asc&limit=200`,
    ),
  ]);
  if (owner.status >= 300 || team.status >= 300) throw new Error(`office staff lookup failed (${owner.status}/${team.status})`);
  const staff: StaffMember[] = [];
  const ownerRow = Array.isArray(owner.json) ? (owner.json[0] as Record<string, unknown> | undefined) : undefined;
  if (ownerRow && typeof ownerRow.auth_user_id === "string") {
    staff.push({
      userId: ownerRow.auth_user_id,
      label: String(ownerRow.provider_name || ownerRow.office_name || "Office owner"),
      kind: "provider",
    });
  }
  for (const row of (Array.isArray(team.json) ? team.json : []) as Record<string, unknown>[]) {
    if (typeof row.auth_user_id !== "string" || staff.some(s => s.userId === row.auth_user_id)) continue;
    staff.push({ userId: row.auth_user_id, label: String(row.name || "Team member"), kind: "team_member" });
  }
  return staff;
}

// ── Auto-close policy ───────────────────────────────────────────────────────
//
// HQ settings carry a conversation auto-close window. The persisted workflow
// status stays untouched; the inbox RPCs receive the cutoff instant and report
// threads idle past it as closed (with auto_closed = true), so changing the
// window in HQ settings reclassifies the inbox immediately and a new patient
// message simply makes the thread open again.

/** The instant before which an idle thread counts as closed. */
export function autoCloseCutoff(now: Date, autoCloseDays: number): string {
  return new Date(now.getTime() - autoCloseDays * 86_400_000).toISOString();
}

/** Pure form of the RPC rule, kept for callers that only have timestamps. */
export function conversationStatus(
  lastMessageAt: string | null,
  now: Date,
  autoCloseDays: number,
): "open" | "closed" {
  if (!lastMessageAt) return "open";
  const last = Date.parse(lastMessageAt);
  if (!Number.isFinite(last)) return "open";
  return now.getTime() - last >= autoCloseDays * 86_400_000 ? "closed" : "open";
}

async function autoClosePolicy(): Promise<{ autoCloseDays: number; cutoff: string }> {
  const autoCloseDays = (await loadOrgPolicy()).conversationAutoCloseDays;
  return { autoCloseDays, cutoff: autoCloseCutoff(new Date(), autoCloseDays) };
}

// ── Summaries ───────────────────────────────────────────────────────────────

interface InboxRow {
  id: string;
  patient_id: string;
  patient_name: string;
  thread: Thread;
  status: string;
  auto_closed?: boolean;
  assignee_user_id: string | null;
  assignee_label: string | null;
  message_count: number | string;
  last_message_at: string | null;
  last_patient_message_at: string | null;
  last_staff_reply_at: string | null;
  preview: string | null;
  unread: boolean;
  note_count: number | string;
  open_escalation_id: string | null;
  open_escalation_department: string | null;
  created_at: string;
  total: number | string;
  provider_id?: string;
  office_name?: string;
  title?: string | null;
  archived_at?: string | null;
}

function summary(row: InboxRow) {
  return {
    id: String(row.id),
    patientId: String(row.patient_id),
    patientName: String(row.patient_name || "Patient"),
    thread: row.thread,
    channel: row.thread === "care_team" ? "care_team" : "ai",
    providerId: String(row.provider_id ?? ""),
    officeName: String(row.office_name ?? ""),
    status: row.status,
    autoClosed: row.auto_closed === true,
    assignee: row.assignee_user_id ? { userId: String(row.assignee_user_id), label: String(row.assignee_label ?? "Staff") } : null,
    unread: row.unread === true,
    messageCount: Number(row.message_count ?? 0),
    lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
    lastPatientMessageAt: row.last_patient_message_at ? String(row.last_patient_message_at) : null,
    lastStaffReplyAt: row.last_staff_reply_at ? String(row.last_staff_reply_at) : null,
    preview: String(row.preview ?? ""),
    noteCount: Number(row.note_count ?? 0),
    openEscalation: row.open_escalation_id
      ? { id: String(row.open_escalation_id), department: String(row.open_escalation_department) }
      : null,
    createdAt: String(row.created_at),
    // Coach now has multiple conversations.  Human and support summaries keep
    // their established thread identity and intentionally have no title.
    title: row.thread === "coach" ? String(row.title || "New conversation") : null,
    archivedAt: row.thread === "coach" && typeof row.archived_at === "string" ? row.archived_at : null,
  };
}
type ConversationSummary = ReturnType<typeof summary>;

interface InboxListArgs {
  threads: Thread[];
  status?: string;
  assignee?: string;
  unreadOnly?: boolean;
  q?: string;
  sort?: string;
  limit?: number;
  offset?: number;
  conversationId?: string;
  patientId?: string;
}

/** Inbox RPC stays focused on workflow; fetch only safe Coach list metadata. */
async function withCoachMetadata(rows: InboxRow[]): Promise<InboxRow[]> {
  const ids = rows.filter(row => row.thread === "coach").map(row => row.id);
  if (ids.length === 0) return rows;
  const result = await supabaseAdmin(
    "GET",
    `/rest/v1/patient_chat_conversations?id=in.(${ids.map(enc).join(",")})&select=id,title,archived_at`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`coach inbox metadata failed (${result.status})`);
  }
  const metadata = new Map((result.json as Row[]).map(row => [
    String(row.id),
    { title: typeof row.title === "string" ? row.title : null, archived_at: typeof row.archived_at === "string" ? row.archived_at : null },
  ]));
  return rows.map(row => ({ ...row, ...metadata.get(row.id) }));
}

async function inboxList(scope: OfficeScope, args: InboxListArgs): Promise<{ rows: InboxRow[]; total: number; autoCloseDays: number }> {
  const policy = await autoClosePolicy();
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_chat_inbox_list_guarded", {
    p_provider_id: scope.providerId,
    p_staff_user_id: scope.actorUserId,
    p_threads: args.threads,
    p_status: args.status ?? null,
    p_assignee: args.assignee ?? null,
    p_unread_only: args.unreadOnly === true,
    p_q: args.q ?? null,
    p_sort: args.sort ?? "newest",
    p_limit: args.limit ?? 50,
    p_offset: args.offset ?? 0,
    p_conversation_id: args.conversationId ?? null,
    p_auto_close_before: policy.cutoff,
    p_patient_id: args.patientId ?? null,
  });
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`inbox list failed (${result.status})`);
  const rows = await withCoachMetadata((result.json as InboxRow[]).map(row => ({
    ...row, provider_id: scope.providerId, office_name: scope.officeName,
  })));
  return { rows, total: rows.length ? Number(rows[0].total ?? rows.length) : 0, autoCloseDays: policy.autoCloseDays };
}

/** One conversation in this office (and within the actor's threads), or null. */
async function loadConversation(scope: OfficeScope, threads: Thread[], id: string): Promise<ConversationSummary | null> {
  if (threads.length === 0) return null;
  const { rows } = await inboxList(scope, { threads, conversationId: id, limit: 1 });
  return rows[0] ? summary(rows[0]) : null;
}

function audit(req: Request, scope: OfficeScope, action: string, targetKind: string, targetId: string, metadata: Record<string, string | number | boolean | null>) {
  return recordAdminAuditEvent({
    action,
    actorUserId: scope.actorUserId,
    actorKind: scope.actorKind,
    providerId: scope.providerId,
    targetKind,
    targetId,
    requestId: req.headers["x-request-id"]?.toString() ?? null,
    metadata,
  }).catch(error => req.log?.error({ err: error, action }, "conversation audit failed"));
}

function metricsFromRow(row: Record<string, unknown> | undefined) {
  return {
    openThreads: Number(row?.open_threads ?? 0),
    waitingOnPatient: Number(row?.waiting_threads ?? 0),
    closedThreads: Number(row?.closed_threads ?? 0),
    unanswered: Number(row?.unanswered_threads ?? 0),
    avgResponseMinutes:
      row?.avg_response_minutes === null || row?.avg_response_minutes === undefined
        ? null
        : Number(row.avg_response_minutes),
    openEscalations: Number(row?.open_escalations ?? 0),
  };
}

/** Inbox metrics for one office, or the whole fleet when providerId is null. */
export async function inboxMetrics(providerId: string | null, threads: Thread[] = THREADS) {
  const policy = await autoClosePolicy();
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_chat_inbox_metrics", {
    p_provider_id: providerId,
    p_auto_close_before: policy.cutoff,
    p_threads: threads,
  });
  if (result.status >= 300) throw new Error(`inbox metrics failed (${result.status})`);
  const row = Array.isArray(result.json) ? (result.json[0] as Record<string, unknown> | undefined) : (result.json as Record<string, unknown>);
  return metricsFromRow(row);
}

function eventFromRow(row: Record<string, unknown>) {
  return {
    seq: Number(row.seq),
    clientId: typeof row.client_id === "string" ? row.client_id : null,
    role: String(row.role),
    text: String(row.text ?? ""),
    stopped: row.stopped === true,
    senderLabel: typeof row.sender_label === "string" ? row.sender_label : null,
    senderUserId: typeof row.sender_user_id === "string" ? row.sender_user_id : null,
    createdAt: String(row.created_at),
    suggestion: suggestionFromCard(row.card),
  };
}

function escalationFromRow(row: Record<string, unknown>) {
  const conversation = (row.patient_chat_conversations ?? {}) as Record<string, unknown>;
  const patient = (conversation.patients ?? {}) as Record<string, unknown>;
  const provider = (row.providers ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    providerId: String(row.provider_id),
    officeName: String(provider.office_name || provider.provider_name || row.provider_id),
    patientName: patientName(patient),
    thread: String(conversation.thread ?? "coach"),
    department: String(row.department),
    reason: String(row.reason ?? ""),
    status: String(row.status),
    createdByLabel: String(row.created_by_label ?? "Staff"),
    createdAt: String(row.created_at),
    resolvedByLabel: typeof row.resolved_by_label === "string" ? row.resolved_by_label : null,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
    resolutionNote: typeof row.resolution_note === "string" ? row.resolution_note : null,
  };
}
const ESCALATION_SELECT =
  "id,conversation_id,provider_id,department,reason,status,created_by_label,created_at,resolved_by_label,resolved_at,resolution_note,patient_chat_conversations!inner(thread,patient_id,patients(first_name,last_name,name)),providers(office_name,provider_name)";

function noteFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    authorUserId: String(row.author_user_id),
    authorLabel: String(row.author_label ?? "Staff"),
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
  };
}

/** Push body: first line of the reply, trimmed to a notification-sized preview. */
export function replyPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= CARE_TEAM_REPLY_BODY_MAX ? flat : `${flat.slice(0, CARE_TEAM_REPLY_BODY_MAX - 1).trimEnd()}…`;
}

// ── Router ──────────────────────────────────────────────────────────────────

export function createStaffConversationsRouter(store: NotificationStore = supabaseNotificationStore): IRouter {
  // Kept as an injectable compatibility seam for existing callers; care-team
  // pushes now enqueue in the same database transaction as the message RPC.
  void store;
  const router: IRouter = Router();

  /**
   * Loads scope + the conversation for a `:conversationId` route. Writes the
   * error response itself and returns null when the caller should stop.
   */
  async function conversationRoute(req: Request, res: Response) {
    const id = uuid.safeParse(req.params.conversationId);
    if (!id.success) {
      res.status(400).json({ error: "Check the conversation request." });
      return null;
    }
    const inbox = await scopeForInbox(req, res);
    if (!inbox) return null;
    const conversation = await loadConversation(inbox.scope, inbox.threads, id.data);
    if (!conversation) {
      res.status(404).json({ error: NOT_FOUND });
      return null;
    }
    return { ...inbox, conversation };
  }

  function officeMutationOnly(found: { scope: OfficeScope; conversation: ConversationSummary }, res: Response): boolean {
    if (found.scope.actorKind !== "hq" || found.conversation.thread !== "care_team") return true;
    res.status(403).json({ error: "HQ care-team access is read-only." });
    return false;
  }

  async function mutateWorkflow(found: { scope: OfficeScope; conversation: ConversationSummary },
    action: string, payload: Record<string, unknown>) {
    return supabaseAdmin("POST", "/rest/v1/rpc/patient_chat_workflow_mutate", {
      p_conversation_id: found.conversation.id, p_provider_id: found.scope.providerId,
      p_actor_user_id: found.scope.actorUserId, p_actor_kind: found.scope.actorKind,
      p_action: action, p_payload: payload,
    });
  }

  router.get("/office/conversations", async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Check conversation filters." });
      return;
    }
    try {
      const inbox = await scopeForInbox(req, res);
      if (!inbox) return;
      const q = parsed.data;
      if (q.thread && !inbox.threads.includes(q.thread)) {
        res.status(403).json({ error: HQ_FORBIDDEN });
        return;
      }
      const requested = q.channel === "care_team"
        ? ["care_team" as Thread]
        : q.channel === "ai"
          ? ["coach" as Thread, "support" as Thread]
          : inbox.threads;
      const threads = q.thread ? [q.thread] : requested.filter(thread => inbox.threads.includes(thread));
      if (threads.length === 0) {
        res.json({ conversations: [], total: 0, autoCloseDays: (await autoClosePolicy()).autoCloseDays });
        return;
      }
      const assignee = q.assignee === "me" ? inbox.scope.actorUserId : q.assignee;
      if (assignee && assignee !== "unassigned" && !uuid.safeParse(assignee).success) {
        res.status(400).json({ error: "Check conversation filters." });
        return;
      }
      const { rows, total, autoCloseDays } = await inboxList(inbox.scope, {
        threads,
        status: q.status,
        assignee,
        unreadOnly: q.unread === "true",
        q: q.q || undefined,
        sort: q.sort,
        limit: q.limit,
        offset: q.offset,
        patientId: q.patientId,
      });
      const summaries = rows.map(summary);
      res.json({ conversations: summaries, total, autoCloseDays });
    } catch (error) {
      req.log?.error({ err: error }, "conversation list failed");
      res.status(502).json({ error: "Could not load conversations right now." });
    }
  });

  router.get("/office/conversations/summary", async (req, res) => {
    if (!officeQuery.safeParse(req.query).success) {
      res.status(400).json({ error: "Check the office." });
      return;
    }
    try {
      const inbox = await scopeForInbox(req, res);
      if (!inbox) return;
      const metrics = await inboxMetrics(inbox.scope.providerId, inbox.threads);
      res.json({
        scope: { providerId: inbox.scope.providerId, officeName: inbox.scope.officeName },
        asOf: new Date().toISOString(),
        metrics,
      });
    } catch (error) {
      req.log?.error({ err: error }, "inbox summary failed");
      res.status(502).json({ error: "Could not load inbox metrics right now." });
    }
  });

  router.get("/office/conversations/staff", async (req, res) => {
    if (!officeQuery.safeParse(req.query).success) {
      res.status(400).json({ error: "Check the office." });
      return;
    }
    try {
      const inbox = await scopeForInbox(req, res);
      if (!inbox) return;
      res.json({ staff: await officeStaff(inbox.scope.providerId) });
    } catch (error) {
      req.log?.error({ err: error }, "office staff list failed");
      res.status(502).json({ error: "Could not load office staff right now." });
    }
  });

  router.post("/office/conversations/start", async (req, res) => {
    const body = startBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Check the patient." }); return; }
    try {
      const resolved = await scoped(req, "care_team");
      if (resolved.kind !== "ok") { respondOfficeScopeDenied(req, res, resolved); return; }
      if (resolved.scope.actorKind === "hq") {
        res.status(403).json({ error: "HQ care-team access is read-only." }); return;
      }
      const patient = await supabaseAdmin("GET",
        `/rest/v1/patients?id=eq.${enc(body.data.patientId)}&provider_id=eq.${enc(resolved.scope.providerId)}&archived_at=is.null&deletion_requested_at=is.null&select=id&limit=1`);
      if (patient.status >= 300) throw new Error(`patient lookup failed (${patient.status})`);
      if (!Array.isArray(patient.json) || !patient.json[0]) {
        res.status(404).json({ error: "Patient not found." }); return;
      }
      const started = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_start", {
        p_patient_id: body.data.patientId, p_provider_id: resolved.scope.providerId,
      });
      if (started.status >= 300) throw new Error(`care team start failed (${started.status})`);
      const payload = started.json as { conversationId?: unknown; created?: unknown };
      const id = typeof payload.conversationId === "string" ? payload.conversationId : "";
      const conversation = id ? await loadConversation(resolved.scope, ["care_team"], id) : null;
      if (!conversation) throw new Error("care team start returned no conversation");
      void audit(req, resolved.scope, "care_team_conversation_started", "patient_chat_conversation", id, {
        patientId: body.data.patientId, created: payload.created === true,
      });
      res.json({ conversation, created: payload.created === true });
    } catch (error) {
      req.log?.error({ err: error }, "office care team start failed");
      res.status(502).json({ error: "Could not start the conversation right now." });
    }
  });

  router.get("/office/conversations/:conversationId/events", async (req, res) => {
    const parsed = eventQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Check the conversation request." });
      return;
    }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      const { conversation } = found;
      const filters = [
        `conversation_id=eq.${enc(conversation.id)}`,
        "select=seq,client_id,role,text,stopped,sender_user_id,sender_label,created_at,card",
        "order=seq.desc",
        `limit=${parsed.data.limit + 1}`,
      ];
       if (parsed.data.before) filters.push(`seq=lt.${parsed.data.before}`);
       if (parsed.data.after) {
         filters.splice(filters.indexOf("order=seq.desc"), 1, "order=seq.asc");
         filters.push(`seq=gt.${parsed.data.after}`);
       }
      const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_messages?${filters.join("&")}`);
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`transcript read failed (${result.status})`);
      const page = result.json as Record<string, unknown>[];
      const hasMore = page.length > parsed.data.limit;
      const kept = page.slice(0, parsed.data.limit);
      const nextBefore = hasMore ? Number(kept[kept.length - 1]?.seq) : null;
      const ordered = parsed.data.after ? kept : kept.reverse();
      res.json({
        conversation, events: ordered.map(eventFromRow),
        nextBefore: parsed.data.after ? null : nextBefore,
        nextAfter: parsed.data.after && hasMore ? Number(ordered[ordered.length - 1]?.seq) : null,
      });
    } catch (error) {
      req.log?.error({ err: error }, "conversation transcript failed");
      res.status(502).json({ error: "Could not load this conversation right now." });
    }
  });

  router.post("/office/conversations/:conversationId/read", async (req, res) => {
    const body = readBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Check the read marker." }); return; }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_staff_read", {
        p_conversation_id: found.conversation.id,
        p_staff_user_id: found.scope.actorUserId,
        p_through_seq: body.data.throughSeq,
      });
      if (result.status >= 300) throw new Error(`staff read failed (${result.status})`);
      const payload = result.json as { changed?: unknown };
      if (payload.changed === true) void audit(req, found.scope, "conversation_transcript_read",
        "patient_chat_conversation", found.conversation.id,
        { thread: found.conversation.thread, throughSeq: body.data.throughSeq });
      res.json(result.json);
    } catch (error) {
      req.log?.error({ err: error }, "conversation read marker failed");
      res.status(502).json({ error: "Could not update the read position right now." });
    }
  });

  router.post("/office/conversations/:conversationId/assign", async (req, res) => {
    const body = assignBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Check the assignee." });
      return;
    }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      if (!officeMutationOnly(found, res)) return;
      const { scope, conversation } = found;
      let assignee: { userId: string; label: string } | null = null;
      if (body.data.assigneeUserId === "me") {
        assignee = { userId: scope.actorUserId, label: await actorLabel(scope) };
      } else if (body.data.assigneeUserId !== null) {
        const wanted = body.data.assigneeUserId;
        const match =
          wanted === scope.actorUserId
            ? { userId: scope.actorUserId, label: await actorLabel(scope) }
            : (await officeStaff(scope.providerId)).find(member => member.userId === wanted);
        if (!match) {
          res.status(400).json({ error: "That person is not on this office's team." });
          return;
        }
        assignee = { userId: match.userId, label: match.label };
      }
      const patch = await mutateWorkflow(found, "assign", {
        assigneeUserId: assignee?.userId ?? "", assigneeLabel: assignee?.label ?? "",
      });
      if (patch.status >= 300) throw new Error(`assignment write failed (${patch.status})`);
      void audit(req, scope, "conversation_assigned", "patient_chat_conversation", conversation.id, {
        thread: conversation.thread,
        assigneeUserId: assignee?.userId ?? null,
        previousAssigneeUserId: conversation.assignee?.userId ?? null,
        self: assignee?.userId === scope.actorUserId,
      });
      const updated = await loadConversation(scope, found.threads, conversation.id);
      res.json({ conversation: updated ?? { ...conversation, assignee } });
    } catch (error) {
      req.log?.error({ err: error }, "conversation assign failed");
      res.status(502).json({ error: "Could not update the assignment right now." });
    }
  });

  router.post("/office/conversations/:conversationId/status", async (req, res) => {
    const body = statusBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Check the status." });
      return;
    }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      if (!officeMutationOnly(found, res)) return;
      const { scope, conversation } = found;
      const patch = await mutateWorkflow(found, "status", { status: body.data.status });
      if (patch.status >= 300) throw new Error(`status write failed (${patch.status})`);
      void audit(req, scope, "conversation_status_changed", "patient_chat_conversation", conversation.id, {
        thread: conversation.thread,
        from: conversation.status,
        to: body.data.status,
      });
      const updated = await loadConversation(scope, found.threads, conversation.id);
      res.json({ conversation: updated ?? { ...conversation, status: body.data.status, autoClosed: false } });
    } catch (error) {
      req.log?.error({ err: error }, "conversation status failed");
      res.status(502).json({ error: "Could not update the status right now." });
    }
  });

  router.post("/office/conversations/:conversationId/reply", async (req, res) => {
    const body = replyBody.safeParse(req.body);
    if (!body.success) {
      const suggestionIssue = body.error.issues.find(issue => issue.path[0] === "suggestion");
      const quantityIssue = body.error.issues.find(issue => issue.path.at(-1) === "quantity");
      res.status(400).json({
        error: quantityIssue
          ? "Each suggested product quantity must be between 1 and 20."
          : suggestionIssue
            ? "Check the product suggestion."
            : "Write a reply first.",
        ...(suggestionIssue ? { field: suggestionIssue.path.join(".") } : {}),
      });
      return;
    }
    if (!body.data.text.trim()) {
      res.status(400).json({ error: "Write a reply first." });
      return;
    }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      if (found.scope.actorKind === "hq") {
        res.status(403).json({ error: "HQ staff cannot send patient messages." });
        return;
      }
      if (!officeMutationOnly(found, res)) return;
      const { scope, conversation } = found;
      const text = body.data.text.trim();
      if (conversation.thread !== "care_team") {
        const started = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_start", {
          p_patient_id: conversation.patientId, p_provider_id: scope.providerId,
        });
        if (started.status >= 300) throw new Error(`care team redirect failed (${started.status})`);
        const payload = started.json as { conversationId?: unknown };
        res.status(409).json({
          error: "Staff replies belong in the Care Team conversation.",
          careTeamConversationId: payload.conversationId,
        });
        return;
      }
      if (!body.data.clientId) {
        res.status(400).json({ error: "A stable message clientId is required." });
        return;
      }
      const senderLabel = await actorLabel(scope);
      const clientId = body.data.clientId;
      let suggestion = null;
      if (body.data.suggestion) {
        try {
          suggestion = await buildProductSuggestion(scope.providerId, body.data.suggestion);
        } catch (error) {
          if (error instanceof ProductSuggestionError) {
            res.status(400).json({ error: error.message, field: error.field });
            return;
          }
          throw error;
        }
      }
      const card = suggestion ? { kind: "product_suggestion", payload: suggestion } : null;
      const inserted = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_send", {
        p_conversation_id: conversation.id,
        p_patient_id: conversation.patientId,
        p_provider_id: scope.providerId,
        p_client_id: clientId,
        p_text: text,
        p_role: "staff",
        p_sender_user_id: scope.actorUserId,
        p_sender_label: senderLabel,
        p_enqueue_push: true,
        p_card: card,
        p_push_body: suggestion ? suggestionPushBody(suggestion) : null,
      });
      if (inserted.status === 409 || (inserted.status >= 300 && JSON.stringify(inserted.json).includes("payload conflict"))) {
        res.status(409).json({ error: "That message id was already used for different content." }); return;
      }
      if (inserted.status >= 300) throw new Error(`reply write failed (${inserted.status})`);
      const payload = inserted.json as Record<string, unknown>;
      const row = {
        seq: payload.seq, client_id: clientId, role: payload.role, text: payload.text, stopped: false,
        sender_user_id: scope.actorUserId, sender_label: senderLabel, created_at: payload.createdAt, card,
      };
      void audit(req, scope, "conversation_replied", "patient_chat_conversation", conversation.id, {
        thread: conversation.thread,
        messageClientId: clientId,
        length: text.length,
      });
      const updated = await loadConversation(scope, found.threads, conversation.id);
      res.json({ conversation: updated ?? { ...conversation, status: "waiting_patient" }, event: eventFromRow(row) });
    } catch (error) {
      req.log?.error({ err: error }, "conversation reply failed");
      res.status(502).json({ error: "Could not send the reply right now." });
    }
  });

  router.get("/office/conversations/:conversationId/notes", async (req, res) => {
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      const result = await supabaseAdmin(
        "GET",
        `/rest/v1/patient_chat_notes?conversation_id=eq.${enc(found.conversation.id)}&select=id,author_user_id,author_label,body,created_at&order=created_at.asc&limit=500`,
      );
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`notes read failed (${result.status})`);
      res.json({ notes: (result.json as Record<string, unknown>[]).map(noteFromRow) });
    } catch (error) {
      req.log?.error({ err: error }, "conversation notes failed");
      res.status(502).json({ error: "Could not load notes right now." });
    }
  });

  router.post("/office/conversations/:conversationId/notes", async (req, res) => {
    const body = noteBody.safeParse(req.body);
    if (!body.success || !body.data.body.trim()) {
      res.status(400).json({ error: "Write a note first." });
      return;
    }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      if (!officeMutationOnly(found, res)) return;
      const { scope, conversation } = found;
      const label = await actorLabel(scope);
      const inserted = await mutateWorkflow(found, "note", { authorLabel: label, body: body.data.body.trim() });
      const noteId = (inserted.json as { id?: unknown } | null)?.id;
      if (inserted.status >= 300 || typeof noteId !== "string") throw new Error(`note write failed (${inserted.status})`);
      const loaded = await supabaseAdmin("GET",
        `/rest/v1/patient_chat_notes?id=eq.${enc(noteId)}&select=id,author_user_id,author_label,body,created_at&limit=1`);
      const row = Array.isArray(loaded.json) ? loaded.json[0] as Record<string, unknown> | undefined : undefined;
      if (loaded.status >= 300 || !row) throw new Error(`note readback failed (${loaded.status})`);
      void audit(req, scope, "conversation_note_added", "patient_chat_conversation", conversation.id, {
        thread: conversation.thread,
        noteId,
      });
      res.json({ note: noteFromRow(row) });
    } catch (error) {
      req.log?.error({ err: error }, "conversation note failed");
      res.status(502).json({ error: "Could not save the note right now." });
    }
  });

  router.post("/office/conversations/:conversationId/escalations", async (req, res) => {
    const body = escalationBody.safeParse(req.body);
    if (!body.success || !body.data.reason.trim()) {
      res.status(400).json({ error: "Give HQ a reason." });
      return;
    }
    try {
      const found = await conversationRoute(req, res);
      if (!found) return;
      if (!officeMutationOnly(found, res)) return;
      const { scope, conversation } = found;
      if (conversation.thread === "care_team") {
        res.status(409).json({ error: "Care Team conversations cannot be escalated to HQ." }); return;
      }
      const inserted = await mutateWorkflow(found, "escalate", {
        department: body.data.department, reason: body.data.reason.trim(), authorLabel: await actorLabel(scope),
      });
      if (inserted.status === 409) {
        res.status(409).json({ error: "This conversation already has an open escalation." });
        return;
      }
      const escalationId = (inserted.json as { id?: unknown } | null)?.id;
      if (inserted.status >= 300 || typeof escalationId !== "string") throw new Error(`escalation write failed (${inserted.status})`);
      const loaded = await supabaseAdmin("GET",
        `/rest/v1/patient_chat_escalations?id=eq.${enc(escalationId)}&select=${enc(ESCALATION_SELECT)}&limit=1`);
      const row = Array.isArray(loaded.json) ? loaded.json[0] as Record<string, unknown> | undefined : undefined;
      if (loaded.status >= 300 || !row) throw new Error(`escalation readback failed (${loaded.status})`);
      void audit(req, scope, "conversation_escalated", "patient_chat_conversation", conversation.id, {
        thread: conversation.thread,
        department: body.data.department,
        escalationId: String(row.id),
      });
      res.json({ escalation: escalationFromRow(row) });
    } catch (error) {
      req.log?.error({ err: error }, "conversation escalation failed");
      res.status(502).json({ error: "Could not escalate right now." });
    }
  });

  // ── HQ escalation queue ───────────────────────────────────────────────────

  async function hqDepartments(req: Request, res: Response): Promise<{ staff: StaffIdentity; departments: Department[] } | null> {
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: "Sign in to continue." });
      return null;
    }
    const staff = await verifyStaffToken(token);
    if (!staff) {
      res.status(401).json({ error: "Your session has expired. Sign in again." });
      return null;
    }
    const departments = (Object.keys(DEPARTMENT_PERMISSION) as Department[]).filter(department =>
      hasHqPermission(staff, DEPARTMENT_PERMISSION[department]),
    );
    if (departments.length === 0) {
      res.status(403).json({ error: HQ_FORBIDDEN });
      return null;
    }
    return { staff, departments };
  }

  async function hqConversationIdentity(req: Request, res: Response) {
    const token = bearer(req);
    if (!token) { res.status(401).json({ error: "Sign in to continue." }); return null; }
    const staff = await verifyStaffToken(token);
    if (!staff) { res.status(401).json({ error: "Sign in with an active HQ account to continue." }); return null; }
    const clinical = hasHqPermission(staff, "conversation_clinical");
    const support = hasHqPermission(staff, "conversation_support");
    if (!clinical && !support) { res.status(403).json({ error: HQ_FORBIDDEN }); return null; }
    return { staff, clinical, support };
  }

  router.get("/hq/conversations", async (req, res) => {
    const parsed = hqConversationQuery.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: "Check conversation filters." }); return; }
    try {
      const hq = await hqConversationIdentity(req, res);
      if (!hq) return;
      const q = parsed.data;
      if ((q.channel === "care_team" || q.thread === "care_team" || q.thread === "coach") && !hq.clinical) {
        res.status(403).json({ error: HQ_FORBIDDEN }); return;
      }
      if (q.thread === "support" && !hq.support) { res.status(403).json({ error: HQ_FORBIDDEN }); return; }
      let threads: Thread[] = q.thread ? [q.thread] :
        q.channel === "care_team" ? ["care_team"] :
        q.channel === "ai" ? ["coach", "support"] : [...THREADS];
      threads = threads.filter(thread => thread === "support" ? hq.support : hq.clinical);
      const policy = await autoClosePolicy();
      const assignee = q.assignee === "me" ? hq.staff.userId : q.assignee;
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_chat_inbox_list", {
        p_provider_id: q.office ? q.office.replace(/^acct-/, "") : null,
        p_staff_user_id: hq.staff.userId, p_threads: threads, p_status: q.status ?? null,
        p_assignee: assignee ?? null, p_unread_only: q.unread === "true",
        p_q: q.q || null, p_sort: q.sort, p_limit: q.limit, p_offset: q.offset,
        p_conversation_id: null, p_auto_close_before: policy.cutoff,
        p_patient_id: q.patientId ?? null,
      });
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`HQ conversations failed (${result.status})`);
      const rows = result.json as InboxRow[];
      const ids = rows.map(row => row.id);
      const owners = ids.length ? await supabaseAdmin("GET",
        `/rest/v1/patient_chat_conversations?id=in.(${ids.map(enc).join(",")})&select=id,provider_id,providers(provider_name,office_name)`) :
        { status: 200, json: [] };
      if (owners.status >= 300 || !Array.isArray(owners.json)) throw new Error(`HQ office metadata failed (${owners.status})`);
      const metadata = new Map((owners.json as Row[]).map(row => {
        const provider = (row.providers ?? {}) as Row;
        return [String(row.id), {
          providerId: String(row.provider_id),
          officeName: String(provider.office_name || provider.provider_name || ""),
        }];
      }));
      const conversations = (await withCoachMetadata(rows)).map(row => summary({ ...row,
        provider_id: metadata.get(row.id)?.providerId,
        office_name: metadata.get(row.id)?.officeName,
      }));
      const total = rows.length ? Number(rows[0].total ?? rows.length) : 0;
      res.json({ conversations, total, autoCloseDays: policy.autoCloseDays });
    } catch (error) {
      req.log?.error({ err: error }, "HQ conversation list failed");
      res.status(502).json({ error: "Could not load conversations right now." });
    }
  });

  async function hqConversation(req: Request, res: Response) {
    const hq = await hqConversationIdentity(req, res);
    if (!hq) return null;
    const id = uuid.safeParse(req.params.conversationId);
    if (!id.success) { res.status(400).json({ error: "Check the conversation request." }); return null; }
    const result = await supabaseAdmin("GET",
      `/rest/v1/patient_chat_conversations?id=eq.${enc(id.data)}&select=id,patient_id,provider_id,thread&limit=1`);
    if (result.status >= 300) throw new Error(`HQ conversation lookup failed (${result.status})`);
    const row = Array.isArray(result.json) ? result.json[0] as Row | undefined : undefined;
    if (!row) { res.status(404).json({ error: NOT_FOUND }); return null; }
    const allowed = row.thread === "support" ? hq.support : hq.clinical;
    if (!allowed) { res.status(404).json({ error: NOT_FOUND }); return null; }
    return { hq, row };
  }

  router.get("/hq/conversations/:conversationId/events", async (req, res) => {
    const page = eventQuery.safeParse(req.query);
    if (!page.success) { res.status(400).json({ error: "Check the conversation request." }); return; }
    try {
      const found = await hqConversation(req, res); if (!found) return;
      const q = page.data;
      const filters = [`conversation_id=eq.${enc(String(found.row.id))}`,
        "select=seq,client_id,role,text,stopped,sender_user_id,sender_label,created_at,card", `limit=${q.limit + 1}`,
        q.after ? "order=seq.asc" : "order=seq.desc"];
      if (q.before) filters.push(`seq=lt.${q.before}`);
      if (q.after) filters.push(`seq=gt.${q.after}`);
      const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_messages?${filters.join("&")}`);
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`HQ transcript failed (${result.status})`);
      const more = result.json.length > q.limit;
      let rows = (result.json as Row[]).slice(0, q.limit);
      if (!q.after) rows = rows.reverse();
      res.json({ events: rows.map(eventFromRow),
        nextBefore: !q.after && more ? Number(rows[0]?.seq) : null,
        nextAfter: q.after && more ? Number(rows[rows.length - 1]?.seq) : null });
    } catch (error) {
      req.log?.error({ err: error }, "HQ transcript failed");
      res.status(502).json({ error: "Could not load this conversation right now." });
    }
  });

  router.get("/hq/conversations/:conversationId/notes", async (req, res) => {
    try {
      const found = await hqConversation(req, res); if (!found) return;
      const result = await supabaseAdmin("GET",
        `/rest/v1/patient_chat_notes?conversation_id=eq.${enc(String(found.row.id))}&select=id,author_user_id,author_label,body,created_at&order=created_at.asc&limit=500`);
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`HQ notes failed (${result.status})`);
      res.json({ notes: (result.json as Row[]).map(noteFromRow) });
    } catch (error) {
      req.log?.error({ err: error }, "HQ notes failed");
      res.status(502).json({ error: "Could not load notes right now." });
    }
  });

  router.post("/hq/conversations/:conversationId/read", async (req, res) => {
    const body = readBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Check the read marker." }); return; }
    try {
      const found = await hqConversation(req, res); if (!found) return;
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/care_team_staff_read", {
        p_conversation_id: String(found.row.id), p_staff_user_id: found.hq.staff.userId,
        p_through_seq: body.data.throughSeq,
      });
      if (result.status >= 300) throw new Error(`HQ read failed (${result.status})`);
      const payload = result.json as { changed?: unknown };
      if (payload.changed === true) void recordAdminAuditEvent({
        action: "conversation_transcript_read", actorUserId: found.hq.staff.userId,
        actorKind: "hq", providerId: String(found.row.provider_id),
        targetKind: "patient_chat_conversation", targetId: String(found.row.id),
        requestId: req.headers["x-request-id"]?.toString() ?? null,
        metadata: { thread: String(found.row.thread), throughSeq: body.data.throughSeq },
      });
      res.json(result.json);
    } catch (error) {
      req.log?.error({ err: error }, "HQ read marker failed");
      res.status(502).json({ error: "Could not update the read position right now." });
    }
  });

  router.get("/hq/escalations", async (req, res) => {
    const parsed = hqEscalationQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Check the escalation filters." });
      return;
    }
    try {
      const hq = await hqDepartments(req, res);
      if (!hq) return;
      if (parsed.data.department && !hq.departments.includes(parsed.data.department)) {
        res.status(403).json({ error: HQ_FORBIDDEN });
        return;
      }
      const departments = parsed.data.department ? [parsed.data.department] : hq.departments;
      const filters = [
        `select=${enc(ESCALATION_SELECT)}`,
        `status=eq.${parsed.data.status}`,
        `department=in.(${departments.join(",")})`,
        "patient_chat_conversations.thread=neq.care_team",
        "order=created_at.desc",
        `limit=${parsed.data.limit}`,
        `offset=${parsed.data.offset}`,
      ];
      const result = await supabaseAdmin("GET", `/rest/v1/patient_chat_escalations?${filters.join("&")}`, undefined, "count=exact");
      if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`escalation queue failed (${result.status})`);
      const rows = (result.json as Record<string, unknown>[]).map(escalationFromRow);
      const total = Number(result.contentRange?.match(/\/(\d+)$/)?.[1] ?? rows.length);
      res.json({ escalations: rows, total, departments: hq.departments });
    } catch (error) {
      req.log?.error({ err: error }, "escalation queue failed");
      res.status(502).json({ error: "Could not load escalations right now." });
    }
  });

  router.post("/hq/escalations/:escalationId/resolve", async (req, res) => {
    const id = uuid.safeParse(req.params.escalationId);
    const body = resolveBody.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: "Check the escalation request." });
      return;
    }
    try {
      const hq = await hqDepartments(req, res);
      if (!hq) return;
      const existing = await supabaseAdmin(
        "GET",
        `/rest/v1/patient_chat_escalations?id=eq.${enc(id.data)}&department=in.(${hq.departments.join(",")})&patient_chat_conversations.thread=neq.care_team&select=id,status,department,provider_id,conversation_id,patient_chat_conversations!inner(thread)&limit=1`,
      );
      const current = Array.isArray(existing.json) ? (existing.json[0] as Record<string, unknown> | undefined) : undefined;
      if (existing.status >= 300) throw new Error(`escalation lookup failed (${existing.status})`);
      if (!current) {
        res.status(404).json({ error: "Escalation not found." });
        return;
      }
      if (current.status === "resolved") {
        res.status(409).json({ error: "This escalation is already resolved." });
        return;
      }
      const label = await actorLabel({
        providerId: String(current.provider_id),
        officeName: "",
        providerName: "",
        onboardingCode: null,
        actorUserId: hq.staff.userId,
        actorKind: "hq",
        officeRole: "owner",
        teamMemberId: null,
      });
      const note = body.data.note?.trim() || null;
      const patched = await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_chat_escalations?id=eq.${enc(id.data)}&status=eq.open&select=${enc(ESCALATION_SELECT)}`,
        {
          status: "resolved",
          resolved_by: hq.staff.userId,
          resolved_by_label: label,
          resolved_at: new Date().toISOString(),
          resolution_note: note,
        },
        "return=representation",
      );
      const row = Array.isArray(patched.json) ? (patched.json[0] as Record<string, unknown> | undefined) : undefined;
      if (patched.status >= 300) throw new Error(`escalation resolve failed (${patched.status})`);
      if (!row) {
        res.status(409).json({ error: "This escalation is already resolved." });
        return;
      }
      void recordAdminAuditEvent({
        action: "conversation_escalation_resolved",
        actorUserId: hq.staff.userId,
        actorKind: "hq",
        providerId: String(current.provider_id),
        targetKind: "patient_chat_conversation",
        targetId: String(current.conversation_id),
        requestId: req.headers["x-request-id"]?.toString() ?? null,
        metadata: { escalationId: id.data, department: String(current.department), hasNote: note !== null },
      }).catch(error => req.log?.error({ err: error }, "escalation resolve audit failed"));
      res.json({ escalation: escalationFromRow(row) });
    } catch (error) {
      req.log?.error({ err: error }, "escalation resolve failed");
      res.status(502).json({ error: "Could not resolve this escalation right now." });
    }
  });

  return router;
}

export default createStaffConversationsRouter();
