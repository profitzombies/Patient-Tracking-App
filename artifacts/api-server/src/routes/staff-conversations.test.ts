/**
 * Staff inbox routes: office scope, the HQ clinical/support split, every
 * mutation's write + audit, the care-team reply → patient thread + push
 * hand-off, note privacy, and the HQ escalation queue.
 *
 * The Supabase edge is a tiny fake PostgREST keyed by method + path so each
 * case asserts the exact rows the router writes; the workflow trigger itself
 * is proven on real PostgreSQL in staff-inbox.sql.test.ts.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryNotificationStore } from "../notifications/memory-store";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
  verify: vi.fn(),
  hasPermission: vi.fn(),
}));
vi.mock("../auth/office-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/office-scope")>()),
  resolveOfficeScope: mocks.scope,
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../lib/staff-auth", () => ({
  hasHqPermission: mocks.hasPermission,
  verifyStaffToken: mocks.verify,
}));
import { CARE_TEAM_REPLY_KIND, autoCloseCutoff, conversationStatus, createStaffConversationsRouter, replyPreview } from "./staff-conversations";
import { invalidateOrgPolicyCache } from "../lib/org-policy";

const CONV = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const ESC = "00000000-0000-4000-8000-000000000077";
const PATIENT = "00000000-0000-4000-8000-000000000011";
const TEAMMATE = "00000000-0000-4000-8000-000000000022";
const STAFF_USER = "00000000-0000-4000-8000-000000000099";

const store = new MemoryNotificationStore();
let server: http.Server;
let base = "";
type Call = { method: string; path: string; body: unknown; prefer?: string };
let calls: Call[] = [];

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV,
    patient_id: PATIENT,
    patient_name: "Anna O'Neil",
    thread: "coach",
    status: "open",
    assignee_user_id: null,
    assignee_label: null,
    message_count: 3,
    last_message_at: "2026-09-01T10:05:00+00:00",
    last_patient_message_at: "2026-09-01T10:05:00+00:00",
    last_staff_reply_at: null,
    preview: "Can I have pasta tonight?",
    unread: true,
    note_count: 0,
    open_escalation_id: null,
    open_escalation_department: null,
    created_at: "2026-09-01T10:00:00+00:00",
    total: 1,
    ...overrides,
  };
}

/** Per-test route table: the first matcher wins; unmatched calls 404. */
let routes: Array<{ match: (call: Call) => boolean; reply: (call: Call) => { status: number; json?: unknown; contentRange?: string | null } }> = [];
function on(method: string, pathPrefix: string, reply: (call: Call) => { status: number; json?: unknown; contentRange?: string | null }) {
  routes.push({ match: call => call.method === method && call.path.startsWith(pathPrefix), reply });
}

function officeScope(actorKind: "provider" | "team_member" | "hq" = "provider") {
  return {
    kind: "ok",
    scope: { providerId: "office-a", officeName: "Office A", providerName: "Dr. Ellis", onboardingCode: null, actorUserId: STAFF_USER, actorKind },
  };
}

// Route responses are asserted structurally with toMatchObject/toBe; the
// loose body type keeps the assertions readable without per-call casts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = any;
async function call(method: string, path: string, body?: unknown, token = "staff"): Promise<{ status: number; json: LooseJson }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: LooseJson = await response.json().catch(() => null);
  return { status: response.status, json };
}
const rpcCalls = (name: string) => calls.filter(c => c.path === `/rest/v1/rpc/${name}`);
const auditActions = () => mocks.audit.mock.calls.map(([input]) => (input as { action: string }).action);
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createStaffConversationsRouter(store));
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
const AUTO_CLOSE_DAYS = 14;
beforeEach(() => {
  store.reset();
  calls = [];
  routes = [];
  invalidateOrgPolicyCache();
  mocks.scope.mockReset().mockResolvedValue(officeScope());
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.verify.mockReset().mockResolvedValue({ userId: STAFF_USER, role: "hq_admin", departmentRole: "admin" });
  mocks.hasPermission.mockReset().mockReturnValue(true);
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: unknown, prefer?: string) => {
    const entry: Call = { method, path, body, prefer };
    calls.push(entry);
    const route = routes.find(r => r.match(entry));
    if (!route) return { status: 404, json: { message: `unmocked ${method} ${path}` }, contentRange: null };
    const reply = route.reply(entry);
    return { status: reply.status, json: reply.json ?? null, contentRange: reply.contentRange ?? null };
  });
  // Default: HQ policy closes idle threads after 14 days; the inbox RPC knows
  // one conversation; the actor labels resolve.
  on("GET", "/rest/v1/hq_organization_settings?", () => ({ status: 200, json: [{ conversation_auto_close_days: AUTO_CLOSE_DAYS, version: 1 }] }));
  on("POST", "/rest/v1/rpc/patient_chat_inbox_list_guarded", c => {
    const args = c.body as Record<string, unknown>;
    if (args.p_conversation_id && args.p_conversation_id !== CONV) return { status: 200, json: [] };
    if (!(args.p_threads as string[]).includes("coach")) return { status: 200, json: [] };
    return { status: 200, json: [inboxRow()] };
  });
  on("GET", "/rest/v1/providers?auth_user_id=", () => ({ status: 200, json: [{ provider_name: "Dr. Ellis", office_name: "Office A" }] }));
  on("GET", "/rest/v1/providers?provider_id=", () => ({ status: 200, json: [{ auth_user_id: STAFF_USER, provider_name: "Dr. Ellis", office_name: "Office A" }] }));
  on("GET", "/rest/v1/team_members?provider_id=", () => ({ status: 200, json: [{ auth_user_id: TEAMMATE, name: "Nurse Kim" }] }));
  on("GET", "/rest/v1/hq_memberships?", () => ({ status: 200, json: [{ display_name: "Pat Rivera" }] }));
  on("POST", "/rest/v1/rpc/patient_chat_workflow_mutate", c => {
    const input = c.body as { p_action: string };
    if (input.p_action === "note") return { status: 200, json: { id: "note-1" } };
    if (input.p_action === "escalate") return { status: 200, json: { id: ESC } };
    return { status: 200, json: { ok: true } };
  });
  on("GET", "/rest/v1/patient_chat_notes?id=eq.", () => ({
    status: 200, json: [{ id: "note-1", author_user_id: STAFF_USER, author_label: "Dr. Ellis", body: "Called the patient about the swap.", created_at: "2026-09-01T11:00:00Z" }],
  }));
  on("GET", "/rest/v1/patient_chat_escalations?id=eq.", () => ({ status: 200, json: [{
    id: ESC, conversation_id: CONV, provider_id: "office-a", department: "clinical",
    reason: "Reports dizziness", status: "open", created_by_label: "Dr. Ellis",
    created_at: "2026-09-01T12:00:00Z", resolved_by_label: null, resolved_at: null,
    resolution_note: null, patient_chat_conversations: {
      thread: "coach", patient_id: PATIENT, patients: { first_name: "Anna", last_name: "O'Neil" },
    }, providers: { office_name: "Office A", provider_name: "Dr. Ellis" },
  }] }));
});

describe("inbox list", () => {
  it("passes filters, search, sort, and paging to the office-scoped RPC and resolves assignee=me", async () => {
    const result = await call("GET", "/office/conversations?status=open&assignee=me&unread=true&q=pasta&sort=waiting_longest&limit=20&offset=40");
    expect(result.status).toBe(200);
    expect(result.json.total).toBe(1);
    expect(result.json.conversations[0]).toMatchObject({
      id: CONV, patientName: "Anna O'Neil", status: "open", unread: true, assignee: null, preview: "Can I have pasta tonight?", noteCount: 0, openEscalation: null,
    });
    const args = rpcCalls("patient_chat_inbox_list_guarded")[0].body as Record<string, unknown>;
    expect(args).toMatchObject({
      p_provider_id: "office-a", p_staff_user_id: STAFF_USER, p_threads: ["coach", "support", "care_team"], p_status: "open",
      p_assignee: STAFF_USER, p_unread_only: true, p_q: "pasta", p_sort: "waiting_longest", p_limit: 20, p_offset: 40, p_conversation_id: null,
    });
  });

  it("hands the organization's auto-close cutoff to the RPC and reports the window", async () => {
    const before = Date.now();
    const result = await call("GET", "/office/conversations");
    expect(result.status).toBe(200);
    expect(result.json.autoCloseDays).toBe(AUTO_CLOSE_DAYS);
    expect(result.json.conversations[0].autoClosed).toBe(false);
    const args = rpcCalls("patient_chat_inbox_list_guarded")[0].body as Record<string, unknown>;
    const cutoff = Date.parse(String(args.p_auto_close_before));
    expect(Math.abs(before - AUTO_CLOSE_DAYS * 86_400_000 - cutoff)).toBeLessThan(5_000);
  });

  it("surfaces threads the RPC filed as closed by the window", async () => {
    routes.unshift({
      match: c => c.method === "POST" && c.path === "/rest/v1/rpc/patient_chat_inbox_list_guarded",
      reply: () => ({ status: 200, json: [inboxRow({ status: "closed", auto_closed: true })] }),
    });
    const result = await call("GET", "/office/conversations?status=closed");
    expect(result.json.conversations[0]).toMatchObject({ status: "closed", autoClosed: true });
  });

  it("derives open/closed from the auto-close window (pure helper)", () => {
    const now = new Date("2026-09-07T12:00:00Z");
    expect(conversationStatus("2026-09-01T12:00:00Z", now, 14)).toBe("open");
    expect(conversationStatus("2026-08-24T12:00:00Z", now, 14)).toBe("closed");
    expect(conversationStatus("2026-08-24T12:00:01Z", now, 14)).toBe("open");
    expect(conversationStatus("2026-09-01T12:00:00Z", now, 3)).toBe("closed");
    expect(conversationStatus(null, now, 14)).toBe("open");
    expect(autoCloseCutoff(now, 3)).toBe("2026-09-04T12:00:00.000Z");
  });

  it("rejects malformed filters before touching the database", async () => {
    expect((await call("GET", "/office/conversations?status=nope")).status).toBe(400);
    expect((await call("GET", "/office/conversations?assignee=not-a-uuid")).status).toBe(400);
    expect((await call("GET", "/office/conversations?sort=random")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("restricts HQ callers to the threads their permission covers", async () => {
    mocks.scope.mockResolvedValue(officeScope("hq"));
    mocks.hasPermission.mockImplementation((_staff, permission) => permission === "conversation_support");
    const list = await call("GET", "/office/conversations?office=office-a");
    expect(list.status).toBe(200);
    expect((rpcCalls("patient_chat_inbox_list_guarded")[0].body as Record<string, unknown>).p_threads).toEqual(["support"]);
    const forbidden = await call("GET", "/office/conversations?office=office-a&thread=coach");
    expect(forbidden.status).toBe(403);
    const events = await call("GET", `/office/conversations/${CONV}/events?office=office-a`);
    expect(events.status).toBe(404);
    expect(auditActions()).toEqual([]);
  });

  it("surfaces scope denials verbatim", async () => {
    mocks.scope.mockResolvedValue({ kind: "denied", status: 403, message: "Your HQ role does not have permission to do this." });
    const result = await call("GET", "/office/conversations");
    expect(result.status).toBe(403);
    expect(result.json.error).toMatch(/permission/);
  });
});

describe("inbox metrics and staff", () => {
  it("returns header metrics for the resolved office", async () => {
    on("POST", "/rest/v1/rpc/patient_chat_inbox_metrics", () => ({
      status: 200,
      json: [{ open_threads: 4, waiting_threads: 2, closed_threads: 9, unanswered_threads: 3, avg_response_minutes: "18.5", open_escalations: 1 }],
    }));
    const result = await call("GET", "/office/conversations/summary");
    expect(result.status).toBe(200);
    expect(result.json.scope).toEqual({ providerId: "office-a", officeName: "Office A" });
    expect(result.json.metrics).toEqual({ openThreads: 4, waitingOnPatient: 2, closedThreads: 9, unanswered: 3, avgResponseMinutes: 18.5, openEscalations: 1 });
    const metricArgs = rpcCalls("patient_chat_inbox_metrics")[0].body as Record<string, unknown>;
    expect(metricArgs.p_provider_id).toBe("office-a");
    expect(typeof metricArgs.p_auto_close_before).toBe("string");
  });

  it("lists the office owner and linked team members as assignees", async () => {
    const result = await call("GET", "/office/conversations/staff");
    expect(result.status).toBe(200);
    expect(result.json.staff).toEqual([
      { userId: STAFF_USER, label: "Dr. Ellis", kind: "provider" },
      { userId: TEAMMATE, label: "Nurse Kim", kind: "team_member" },
    ]);
    expect(calls.find(c => c.path.startsWith("/rest/v1/team_members"))?.path).toContain("auth_user_id=not.is.null");
  });
});

describe("transcript read", () => {
  it("polls the newest page without advancing read state or auditing, and returns sender labels", async () => {
    on("GET", "/rest/v1/patient_chat_messages?", () => ({
      status: 200,
      json: [
        { seq: 3, role: "staff", text: "Skip the pasta tonight.", stopped: false, sender_label: "Dr. Ellis", created_at: "2026-09-01T10:15:00Z" },
        { seq: 2, role: "user", text: "Can I have pasta tonight?", stopped: false, sender_label: null, created_at: "2026-09-01T10:05:00Z" },
      ],
    }));
    const result = await call("GET", `/office/conversations/${CONV}/events`);
    expect(result.status).toBe(200);
    expect(result.json.events.map((e: { role: string }) => e.role)).toEqual(["user", "staff"]);
    expect(result.json.events[1].senderLabel).toBe("Dr. Ellis");
    expect(result.json.events[0].senderLabel).toBeNull();
    expect(result.json.conversation.unread).toBe(true);
    const marker = calls.find(c => c.path.startsWith("/rest/v1/patient_chat_read_markers"));
    expect(marker).toBeUndefined();
    await settle();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("does not move the marker when paging back through older messages", async () => {
    on("GET", "/rest/v1/patient_chat_messages?", () => ({ status: 200, json: [{ seq: 1, role: "assistant", text: "Hi", stopped: false, created_at: "2026-09-01T10:00:00Z" }] }));
    const result = await call("GET", `/office/conversations/${CONV}/events?before=2`);
    expect(result.status).toBe(200);
    expect(calls.some(c => c.path.startsWith("/rest/v1/patient_chat_read_markers"))).toBe(false);
  });

  it("answers a neutral 404 for another office's conversation", async () => {
    const result = await call("GET", `/office/conversations/${OTHER}/events`);
    expect(result.status).toBe(404);
    expect(calls.filter(c => c.path.startsWith("/rest/v1/patient_chat_messages"))).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("assignment and status", () => {
  it("claims a thread for the caller with their resolved label and audits it", async () => {
    const result = await call("POST", `/office/conversations/${CONV}/assign`, { assigneeUserId: "me" });
    expect(result.status).toBe(200);
    const patch = calls.find(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate");
    expect(patch?.body).toMatchObject({ p_action: "assign", p_payload: { assigneeUserId: STAFF_USER, assigneeLabel: "Dr. Ellis" } });
    await settle();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "conversation_assigned", metadata: { thread: "coach", assigneeUserId: STAFF_USER, previousAssigneeUserId: null, self: true },
    }));
  });

  it("allows an authorized HQ caller to self-assign a legacy AI thread", async () => {
    mocks.scope.mockResolvedValue(officeScope("hq"));
    const result = await call("POST", `/office/conversations/${CONV}/assign?office=office-a`,
      { assigneeUserId: "me" });
    expect(result.status).toBe(200);
    expect(calls.find(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")?.body)
      .toMatchObject({
        p_actor_kind: "hq", p_action: "assign",
        p_payload: { assigneeUserId: STAFF_USER, assigneeLabel: "Pat Rivera (THINNR HQ)" },
      });
  });

  it("assigns to a teammate, refuses strangers, and unassigns with null", async () => {
    expect((await call("POST", `/office/conversations/${CONV}/assign`, { assigneeUserId: TEAMMATE })).status).toBe(200);
    expect(calls.find(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")?.body)
      .toMatchObject({ p_payload: { assigneeUserId: TEAMMATE, assigneeLabel: "Nurse Kim" } });
    const stranger = await call("POST", `/office/conversations/${CONV}/assign`, { assigneeUserId: "00000000-0000-4000-8000-000000000555" });
    expect(stranger.status).toBe(400);
    expect(calls.filter(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")).toHaveLength(1);
    expect((await call("POST", `/office/conversations/${CONV}/assign`, { assigneeUserId: null })).status).toBe(200);
    expect((calls.filter(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")[1].body as Record<string, unknown>).p_payload)
      .toEqual({ assigneeUserId: "", assigneeLabel: "" });
    expect((await call("POST", `/office/conversations/${CONV}/assign`, {})).status).toBe(400);
  });

  it("changes status (including reopen) and records from → to", async () => {
    expect((await call("POST", `/office/conversations/${CONV}/status`, { status: "closed" })).status).toBe(200);
    expect(calls.find(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")?.body)
      .toMatchObject({ p_action: "status", p_payload: { status: "closed" } });
    await settle();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "conversation_status_changed", metadata: { thread: "coach", from: "open", to: "closed" },
    }));
    expect((await call("POST", `/office/conversations/${CONV}/status`, { status: "archived" })).status).toBe(400);
    expect((await call("POST", `/office/conversations/${OTHER}/status`, { status: "open" })).status).toBe(404);
  });
});

describe("care-team reply", () => {
  it("writes care-team message and privacy-safe push atomically through the RPC", async () => {
    routes.unshift({
      match: c => c.method === "POST" && c.path === "/rest/v1/rpc/patient_chat_inbox_list_guarded",
      reply: () => ({ status: 200, json: [inboxRow({ thread: "care_team" })] }),
    });
    on("POST", "/rest/v1/rpc/care_team_send", c => ({
      status: 200, json: { created: true, seq: 4, clientId: (c.body as Record<string, unknown>).p_client_id,
        role: "staff", text: (c.body as Record<string, unknown>).p_text, createdAt: "2026-09-01T10:15:00Z" },
    }));
    const result = await call("POST", `/office/conversations/${CONV}/reply`, { clientId: "stable-1", text: "  Skip the pasta tonight, try the zucchini option instead.  " });
    expect(result.status).toBe(200);
    const insert = calls.find(c => c.path === "/rest/v1/rpc/care_team_send");
    expect(insert?.body).toMatchObject({
      p_conversation_id: CONV, p_role: "staff", p_text: "Skip the pasta tonight, try the zucchini option instead.",
      p_sender_user_id: STAFF_USER, p_sender_label: "Dr. Ellis", p_enqueue_push: true, p_client_id: "stable-1",
    });
    expect(result.json.event).toMatchObject({ seq: 4, role: "staff", senderLabel: "Dr. Ellis", text: "Skip the pasta tonight, try the zucchini option instead." });
    expect(store.notifications.size).toBe(0);
    await settle();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "conversation_replied", targetId: CONV, metadata: { thread: "care_team", messageClientId: "stable-1", length: 56 },
    }));
    // Audit metadata never carries the reply text.
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("zucchini");
  });

  it("requires a stable client id for human replies and performs no write RPC when absent", async () => {
    routes.unshift({
      match: c => c.method === "POST" && c.path === "/rest/v1/rpc/patient_chat_inbox_list_guarded",
      reply: () => ({ status: 200, json: [inboxRow({ thread: "care_team" })] }),
    });
    const result = await call("POST", `/office/conversations/${CONV}/reply`, { text: "Retry safe." });
    expect(result.status).toBe(400);
    expect(calls.some(c => c.path === "/rest/v1/rpc/care_team_send")).toBe(false);
    expect(calls.some(c => c.path === "/rest/v1/rpc/care_team_start")).toBe(false);
  });

  it("redirects a legacy AI reply to the distinct care-team conversation without changing AI history", async () => {
    on("POST", "/rest/v1/rpc/care_team_start", () => ({ status: 200, json: { conversationId: OTHER, created: true } }));
    const result = await call("POST", `/office/conversations/${CONV}/reply`, { text: "Try signing out and back in." });
    expect(result.status).toBe(409);
    expect(result.json.careTeamConversationId).toBe(OTHER);
    expect(calls.some(c => c.path.startsWith("/rest/v1/patient_chat_messages"))).toBe(false);
  });

  it("rejects every HQ reply before invoking care-team start or send", async () => {
    mocks.scope.mockResolvedValue(officeScope("hq"));
    const result = await call("POST", `/office/conversations/${CONV}/reply?office=office-a`,
      { text: "HQ must not message patients." });
    expect(result.status).toBe(403);
    expect(calls.some(c => c.path === "/rest/v1/rpc/care_team_start")).toBe(false);
    expect(calls.some(c => c.path === "/rest/v1/rpc/care_team_send")).toBe(false);
  });

  it("rejects blank replies and never enqueues when the message write fails", async () => {
    expect((await call("POST", `/office/conversations/${CONV}/reply`, { text: "   " })).status).toBe(400);
    routes.unshift({ match: c => c.path === "/rest/v1/rpc/patient_chat_inbox_list_guarded",
      reply: () => ({ status: 200, json: [inboxRow({ thread: "care_team" })] }) });
    on("POST", "/rest/v1/rpc/care_team_send", () => ({ status: 500 }));
    expect((await call("POST", `/office/conversations/${CONV}/reply`,
      { clientId: "write-failure-1", text: "hello" })).status).toBe(502);
    expect(store.notifications.size).toBe(0);
    expect(auditActions()).not.toContain("conversation_replied");
  });

  it("trims long replies into a notification-sized preview", () => {
    expect(replyPreview("a\n\n b")).toBe("a b");
    const long = "word ".repeat(60).trim();
    expect(replyPreview(long).length).toBeLessThanOrEqual(140);
    expect(replyPreview(long).endsWith("…")).toBe(true);
  });
});

describe("internal notes", () => {
  it("stores notes on the office-scoped conversation and audits without the note text", async () => {
    on("POST", "/rest/v1/patient_chat_notes?", c => ({ status: 201, json: [{ ...(c.body as Record<string, unknown>), id: "note-1", created_at: "2026-09-01T11:00:00Z" }] }));
    const result = await call("POST", `/office/conversations/${CONV}/notes`, { body: "Called the patient about the swap." });
    expect(result.status).toBe(200);
    expect(result.json.note).toEqual({ id: "note-1", authorUserId: STAFF_USER, authorLabel: "Dr. Ellis", body: "Called the patient about the swap.", createdAt: "2026-09-01T11:00:00Z" });
    expect(calls.find(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")?.body)
      .toMatchObject({ p_provider_id: "office-a", p_action: "note", p_payload: { body: "Called the patient about the swap." } });
    // Notes never touch the patient's message table.
    expect(calls.some(c => c.path.startsWith("/rest/v1/patient_chat_messages"))).toBe(false);
    expect(store.notifications.size).toBe(0);
    await settle();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conversation_note_added", metadata: { thread: "coach", noteId: "note-1" } }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("Called the patient");
  });

  it("lists notes for the conversation and 404s across offices", async () => {
    on("GET", "/rest/v1/patient_chat_notes?", () => ({ status: 200, json: [{ id: "note-1", author_user_id: STAFF_USER, author_label: "Dr. Ellis", body: "x", created_at: "2026-09-01T11:00:00Z" }] }));
    expect((await call("GET", `/office/conversations/${CONV}/notes`)).json.notes).toHaveLength(1);
    expect((await call("GET", `/office/conversations/${OTHER}/notes`)).status).toBe(404);
  });
});

describe("escalations", () => {
  const escalationRow = (overrides: Record<string, unknown> = {}) => ({
    id: ESC, conversation_id: CONV, provider_id: "office-a", department: "clinical", reason: "Reports dizziness", status: "open",
    created_by_label: "Dr. Ellis", created_at: "2026-09-01T12:00:00Z", resolved_by_label: null, resolved_at: null, resolution_note: null,
    patient_chat_conversations: { thread: "coach", patient_id: PATIENT, patients: { first_name: "Anna", last_name: "O'Neil", name: null } },
    providers: { office_name: "Office A", provider_name: "Dr. Ellis" },
    ...overrides,
  });

  it("escalates with a reason, reports the office and patient, and refuses a second open one", async () => {
    const result = await call("POST", `/office/conversations/${CONV}/escalations`, { department: "clinical", reason: "Reports dizziness" });
    expect(result.status).toBe(200);
    expect(result.json.escalation).toMatchObject({ id: ESC, officeName: "Office A", patientName: "Anna O'Neil", department: "clinical", status: "open", createdByLabel: "Dr. Ellis" });
    expect(calls.find(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")?.body)
      .toMatchObject({ p_provider_id: "office-a", p_actor_user_id: STAFF_USER, p_action: "escalate" });
    await settle();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "conversation_escalated", metadata: { thread: "coach", department: "clinical", escalationId: ESC } }));
    expect((await call("POST", `/office/conversations/${CONV}/escalations`, { department: "billing", reason: "x" })).status).toBe(400);
  });

  it("forbids care-team escalation creation and every HQ human workflow mutation", async () => {
    routes.unshift({
      match: c => c.method === "POST" && c.path === "/rest/v1/rpc/patient_chat_inbox_list_guarded",
      reply: () => ({ status: 200, json: [inboxRow({ thread: "care_team" })] }),
    });
    expect((await call("POST", `/office/conversations/${CONV}/escalations`,
      { department: "clinical", reason: "no human escalation" })).status).toBe(409);
    expect(calls.some(c => c.path === "/rest/v1/rpc/patient_chat_workflow_mutate")).toBe(false);

    mocks.scope.mockResolvedValue(officeScope("hq"));
    expect((await call("POST", `/office/conversations/${CONV}/assign?office=office-a`,
      { assigneeUserId: null })).status).toBe(403);
    expect((await call("POST", `/office/conversations/${CONV}/status?office=office-a`,
      { status: "closed" })).status).toBe(403);
    expect((await call("POST", `/office/conversations/${CONV}/notes?office=office-a`,
      { body: "forbidden" })).status).toBe(403);
  });

  it("scopes the HQ queue to the caller's departments", async () => {
    on("GET", "/rest/v1/patient_chat_escalations?", () => ({ status: 200, json: [escalationRow()], contentRange: "0-0/1" }));
    mocks.hasPermission.mockImplementation((_staff, permission) => permission === "conversation_clinical");
    const result = await call("GET", "/hq/escalations");
    expect(result.status).toBe(200);
    expect(result.json.departments).toEqual(["clinical"]);
    expect(result.json.total).toBe(1);
    expect(calls[0].path).toContain("department=in.(clinical)");
    expect(calls[0].path).toContain("status=eq.open");
    expect((await call("GET", "/hq/escalations?department=support")).status).toBe(403);
    mocks.hasPermission.mockReturnValue(false);
    expect((await call("GET", "/hq/escalations")).status).toBe(403);
    mocks.verify.mockResolvedValue(null);
    expect((await call("GET", "/hq/escalations")).status).toBe(401);
  });

  it("resolves an escalation once, stamping the HQ resolver and auditing against the office", async () => {
    on("GET", "/rest/v1/patient_chat_escalations?id=eq.", () => ({ status: 200, json: [{ id: ESC, status: "open", department: "clinical", provider_id: "office-a", conversation_id: CONV }] }));
    on("PATCH", "/rest/v1/patient_chat_escalations?id=eq.", c => ({
      status: 200,
      json: [escalationRow({ status: "resolved", resolved_by_label: (c.body as { resolved_by_label: string }).resolved_by_label, resolved_at: "2026-09-02T09:00:00Z", resolution_note: "Spoke with the office." })],
    }));
    const result = await call("POST", `/hq/escalations/${ESC}/resolve`, { note: "Spoke with the office." });
    expect(result.status).toBe(200);
    expect(result.json.escalation).toMatchObject({ status: "resolved", resolvedByLabel: "Pat Rivera (THINNR HQ)", resolutionNote: "Spoke with the office." });
    const patch = calls.find(c => c.method === "PATCH");
    expect(patch?.path).toContain("status=eq.open");
    expect(patch?.body).toMatchObject({ status: "resolved", resolved_by: STAFF_USER, resolution_note: "Spoke with the office." });
    await settle();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "conversation_escalation_resolved", actorKind: "hq", providerId: "office-a", targetId: CONV,
      metadata: { escalationId: ESC, department: "clinical", hasNote: true },
    }));
    // A support-only role cannot see (let alone resolve) a clinical escalation.
    mocks.hasPermission.mockImplementation((_staff, permission) => permission === "conversation_support");
    routes.unshift({ match: c => c.method === "GET" && c.path.includes("department=in.(support)"), reply: () => ({ status: 200, json: [] }) });
    expect((await call("POST", `/hq/escalations/${ESC}/resolve`, {})).status).toBe(404);
  });
});
