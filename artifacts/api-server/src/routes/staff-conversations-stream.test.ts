/**
 * Staff inbox event stream: the server-sent replacement for the 5-second
 * list + events polling. Proves auth and scope are checked before any byte
 * streams, that keepalives flow, that a change the shared feed sees turns
 * into a list hint (and, for the open thread, the new events), that
 * cross-office and off-permission changes never leak, and that the stream
 * ends with an explicit signal when its lifetime expires.
 *
 * Same fake PostgREST as staff-conversations.test.ts; the feed's watcher
 * reads through it too, so the whole path from a bumped conversation row to
 * the SSE payload runs for real.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { createStaffConversationsRouter } from "./staff-conversations";
import { inboxFeed } from "../lib/inbox-feed";
import { invalidateOrgPolicyCache } from "../lib/org-policy";

const CONV = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const PATIENT = "00000000-0000-4000-8000-000000000011";
const STAFF_USER = "00000000-0000-4000-8000-000000000099";

let server: http.Server;
let base = "";
type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let routes: Array<{ match: (call: Call) => boolean; reply: (call: Call) => { status: number; json?: unknown } }> = [];
function on(method: string, pathPrefix: string, reply: (call: Call) => { status: number; json?: unknown }) {
  routes.push({ match: call => call.method === method && call.path.startsWith(pathPrefix), reply });
}
const officeScope = (providerId = "office-a", actorKind: "provider" | "hq" = "provider") => ({
  kind: "ok",
  scope: { providerId, officeName: "Office A", providerName: "Dr. Ellis", onboardingCode: null, actorUserId: STAFF_USER, actorKind },
});
const inboxRow = (overrides: Record<string, unknown> = {}) => ({
  id: CONV, patient_id: PATIENT, patient_name: "Anna O'Neil", thread: "care_team", status: "open",
  assignee_user_id: null, assignee_label: null, message_count: 2, last_message_at: "2026-09-01T10:05:00+00:00",
  last_patient_message_at: "2026-09-01T10:05:00+00:00", last_staff_reply_at: null, preview: "Hi",
  unread: true, note_count: 0, open_escalation_id: null, open_escalation_department: null,
  created_at: "2026-09-01T10:00:00+00:00", total: 1, ...overrides,
});
const message = (seq: number, text: string) => ({
  seq, client_id: `m${seq}`, role: "user", text, stopped: false, sender_user_id: null, sender_label: null,
  created_at: `2026-09-18T12:00:0${seq}Z`, card: null,
});

/** Conversation rows the feed's watcher will find on its next poll. */
let changed: Array<Record<string, unknown>> = [];
/** Messages of CONV, by seq. */
let messages: Array<ReturnType<typeof message>> = [];

interface Frame { type: string; [key: string]: unknown }
interface OpenStream {
  status: number;
  frames: Frame[];
  comments: string[];
  ended: Promise<void>;
  /** Waits for a frame matching the predicate (already received or next). */
  until(predicate: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>;
  close(): void;
}

async function openStream(path: string, token = "staff"): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const frames: Frame[] = [];
  const comments: string[] = [];
  const waiters: Array<() => void> = [];
  const wake = () => { waiters.splice(0).forEach(fn => fn()); };
  let ended: Promise<void> = Promise.resolve();
  if (response.ok && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    ended = (async () => {
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          for (const line of block.split("\n")) {
            if (line.startsWith("data: ")) frames.push(JSON.parse(line.slice(6)) as Frame);
            else if (line.startsWith(":")) comments.push(line);
          }
          wake();
          split = buffer.indexOf("\n\n");
        }
      }
      wake();
    })();
  }
  return {
    status: response.status,
    frames,
    comments,
    ended,
    until(predicate, timeoutMs = 2_000) {
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms; saw ${JSON.stringify(frames)}`)), timeoutMs);
        const check = () => {
          const hit = frames.find(predicate);
          if (hit) { clearTimeout(timer); resolve(hit); return true; }
          return false;
        };
        if (check()) return;
        const listen = () => { if (!check()) waiters.push(listen); };
        waiters.push(listen);
      });
    },
    close() { controller.abort(); },
  };
}

const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  process.env.INBOX_FEED_POLL_MS = "15";
  process.env.COACH_KEEPALIVE_MS = "20";
  process.env.INBOX_STREAM_MAX_MS = "60000";
  const app = express();
  app.use(express.json());
  app.use(createStaffConversationsRouter());
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections?.();
  server.close();
  delete process.env.INBOX_FEED_POLL_MS;
  delete process.env.COACH_KEEPALIVE_MS;
  delete process.env.INBOX_STREAM_MAX_MS;
});

afterEach(async () => {
  // Closed sockets release their feed subscription asynchronously; never let
  // one test's stream count against the next.
  for (let i = 0; i < 20 && inboxFeed.subscriberCount > 0; i += 1) await settle(25);
  expect(inboxFeed.subscriberCount).toBe(0);
});

beforeEach(() => {
  calls = [];
  routes = [];
  changed = [];
  messages = [message(1, "Hello"), message(2, "Is pasta ok?")];
  invalidateOrgPolicyCache();
  mocks.scope.mockReset().mockResolvedValue(officeScope());
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.verify.mockReset().mockResolvedValue({ userId: STAFF_USER, role: "hq_admin", departmentRole: "admin" });
  mocks.hasPermission.mockReset().mockReturnValue(true);
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: unknown) => {
    const entry: Call = { method, path, body };
    calls.push(entry);
    const route = routes.find(r => r.match(entry));
    if (!route) return { status: 404, json: { message: `unmocked ${method} ${path}` }, contentRange: null };
    const reply = route.reply(entry);
    return { status: reply.status, json: reply.json ?? null, contentRange: null };
  });
  on("GET", "/rest/v1/hq_organization_settings?", () => ({ status: 200, json: [{ conversation_auto_close_days: 14, version: 1 }] }));
  on("POST", "/rest/v1/rpc/patient_chat_inbox_list_guarded", c => {
    const args = c.body as Record<string, unknown>;
    if (args.p_conversation_id && args.p_conversation_id !== CONV) return { status: 200, json: [] };
    if (!(args.p_threads as string[]).includes("care_team")) return { status: 200, json: [] };
    return { status: 200, json: [inboxRow()] };
  });
  on("GET", "/rest/v1/patient_chat_conversations?select=id,patient_id,provider_id,thread,updated_at", c => {
    const since = decodeURIComponent(c.path.match(/updated_at=gt\.([^&]+)/)?.[1] ?? "");
    return { status: 200, json: changed.filter(row => String(row.updated_at) > since) };
  });
  on("GET", `/rest/v1/patient_chat_conversations?id=eq.${CONV}`, () => ({ status: 200, json: [{ id: CONV, thread: "care_team" }] }));
  on("GET", `/rest/v1/patient_chat_conversations?id=eq.${OTHER}`, () => ({ status: 200, json: [{ id: OTHER, thread: "support" }] }));
  on("GET", `/rest/v1/patient_chat_messages?conversation_id=eq.${OTHER}`, () => ({ status: 200, json: [] }));
  on("GET", `/rest/v1/patient_chat_messages?conversation_id=eq.${CONV}`, c => {
    if (c.path.includes("order=seq.desc")) return { status: 200, json: messages.slice(-1) };
    const after = Number(c.path.match(/seq=gt\.(\d+)/)?.[1] ?? 0);
    return { status: 200, json: messages.filter(row => row.seq > after) };
  });
});

const bump = (id: string, providerId: string, thread = "care_team") => {
  changed.push({ id, patient_id: PATIENT, provider_id: providerId, thread, updated_at: new Date(Date.now() + 5).toISOString(), patients: { provider_id: providerId } });
};

describe("office inbox stream", () => {
  it("refuses before streaming: denied scope, unknown or cross-office thread, bad query", async () => {
    mocks.scope.mockResolvedValue({ kind: "denied", status: 401, message: "Sign in to continue.", reason: "unauthenticated", actorUserId: null, providerId: null });
    const denied = await openStream("/office/conversations/stream");
    expect(denied.status).toBe(401);

    mocks.scope.mockResolvedValue(officeScope());
    const missing = await openStream(`/office/conversations/stream?conversation=${OTHER}`);
    expect(missing.status).toBe(404);
    expect(inboxFeed.subscriberCount).toBe(0);

    const malformed = await openStream("/office/conversations/stream?conversation=not-a-uuid");
    expect(malformed.status).toBe(400);
  });

  it("announces readiness with the thread cursor, keeps the connection alive, and cleans up on close", async () => {
    const stream = await openStream(`/office/conversations/stream?conversation=${CONV}`);
    expect(stream.status).toBe(200);
    const ready = await stream.until(frame => frame.type === "ready");
    expect(ready).toMatchObject({ conversationId: CONV, cursor: 2 });
    await settle(80);
    expect(stream.comments.some(line => line.includes("keepalive"))).toBe(true);
    expect(inboxFeed.subscriberCount).toBe(1);
    // Idle: no list reads, no event reads — only the shared watcher's poll.
    expect(calls.filter(c => c.path.includes("patient_chat_messages") && c.path.includes("seq=gt."))).toHaveLength(0);
    stream.close();
    await settle(60);
    expect(inboxFeed.subscriberCount).toBe(0);
  });

  it("turns a bumped conversation row into a list hint plus the open thread's new events, in seq order", async () => {
    const stream = await openStream(`/office/conversations/stream?conversation=${CONV}&after=2`);
    await stream.until(frame => frame.type === "ready");
    messages.push(message(3, "Actually, rice?"));
    bump(CONV, "office-a");
    const list = await stream.until(frame => frame.type === "list");
    expect(list.conversations).toEqual([expect.objectContaining({ id: CONV, thread: "care_team" })]);
    const events = await stream.until(frame => frame.type === "events");
    expect(events).toMatchObject({ conversationId: CONV, nextAfter: 3 });
    expect((events.events as Array<{ seq: number; text: string }>).map(e => e.text)).toEqual(["Actually, rice?"]);
    // A later bump with nothing new past the cursor sends no empty events frame.
    bump(CONV, "office-a");
    await stream.until(frame => frame.type === "list" && frame !== list);
    await settle(60);
    expect(stream.frames.filter(frame => frame.type === "events")).toHaveLength(1);
    stream.close();
  });

  it("never leaks another office's changes and hides threads outside the actor's permissions", async () => {
    const stream = await openStream("/office/conversations/stream");
    await stream.until(frame => frame.type === "ready");
    bump(OTHER, "office-b");
    await settle(80);
    expect(stream.frames.filter(frame => frame.type === "list")).toHaveLength(0);
    bump(OTHER, "office-a", "support");
    const list = await stream.until(frame => frame.type === "list");
    expect(list.conversations).toEqual([expect.objectContaining({ id: OTHER, thread: "support" })]);
    stream.close();

    // HQ drill-in with support-only permission: coach/care-team changes are silent.
    mocks.scope.mockResolvedValue(officeScope("office-a", "hq"));
    mocks.hasPermission.mockImplementation((_staff: unknown, permission: string) => permission === "conversation_support");
    const hq = await openStream("/office/conversations/stream");
    await hq.until(frame => frame.type === "ready");
    bump(CONV, "office-a", "care_team");
    await settle(80);
    const mentions = (frame: Frame) => (frame.conversations as Array<{ id: string }>).map(c => c.id);
    expect(hq.frames.filter(frame => frame.type === "list").flatMap(mentions)).not.toContain(CONV);
    hq.close();
  });

  it("ends with an explicit signal when the stream's lifetime expires", async () => {
    process.env.INBOX_STREAM_MAX_MS = "60";
    try {
      const stream = await openStream("/office/conversations/stream");
      const end = await stream.until(frame => frame.type === "end");
      expect(end).toMatchObject({ reason: "expired" });
      await stream.ended;
      await settle(20);
      expect(inboxFeed.subscriberCount).toBe(0);
    } finally {
      process.env.INBOX_STREAM_MAX_MS = "60000";
    }
  });

  it("ends with an error signal instead of going silent when an event read fails", async () => {
    const stream = await openStream(`/office/conversations/stream?conversation=${CONV}&after=2`);
    await stream.until(frame => frame.type === "ready");
    routes.unshift({
      match: call => call.path.startsWith(`/rest/v1/patient_chat_messages?conversation_id=eq.${CONV}`) && call.path.includes("seq=gt."),
      reply: () => ({ status: 500 }),
    });
    bump(CONV, "office-a");
    const end = await stream.until(frame => frame.type === "end");
    expect(end).toMatchObject({ reason: "error" });
    await stream.ended;
  });

  it("hears a staff reply made through this server without waiting for the poll cadence", async () => {
    process.env.INBOX_FEED_POLL_MS = "5000";
    try {
      const stream = await openStream(`/office/conversations/stream?conversation=${CONV}&after=2`);
      await stream.until(frame => frame.type === "ready");
      on("GET", "/rest/v1/providers?auth_user_id=", () => ({ status: 200, json: [{ provider_name: "Dr. Ellis", office_name: "Office A" }] }));
      on("POST", "/rest/v1/rpc/care_team_send", () => {
        messages.push(message(3, "Rice is fine tonight."));
        bump(CONV, "office-a");
        return { status: 200, json: { seq: 3, role: "staff", text: "Rice is fine tonight.", createdAt: "2026-09-18T12:00:03Z" } };
      });
      const started = Date.now();
      const reply = await fetch(`${base}/office/conversations/${CONV}/reply`, {
        method: "POST", headers: { authorization: "Bearer staff", "content-type": "application/json" },
        body: JSON.stringify({ clientId: "r1", text: "Rice is fine tonight." }),
      });
      expect(reply.status).toBe(200);
      const events = await stream.until(frame => frame.type === "events");
      expect(Date.now() - started).toBeLessThan(1_500);
      expect((events.events as Array<{ text: string }>)[0].text).toBe("Rice is fine tonight.");
      stream.close();
    } finally {
      process.env.INBOX_FEED_POLL_MS = "15";
    }
  });

  it("announces a moved read marker as a list hint even though the watched row never changes", async () => {
    process.env.INBOX_FEED_POLL_MS = "5000";
    try {
      const stream = await openStream(`/office/conversations/stream`);
      await stream.until(frame => frame.type === "ready");
      let changedMarker = true;
      on("POST", "/rest/v1/rpc/care_team_staff_read", () => ({ status: 200, json: { changed: changedMarker } }));
      const read = await fetch(`${base}/office/conversations/${CONV}/read`, {
        method: "POST", headers: { authorization: "Bearer staff", "content-type": "application/json" },
        body: JSON.stringify({ throughSeq: 2 }),
      });
      expect(read.status).toBe(200);
      const hint = await stream.until(frame => frame.type === "list");
      expect((hint.conversations as Array<{ id: string }>).map(row => row.id)).toEqual([CONV]);
      // An unchanged marker is not news.
      changedMarker = false;
      const before = stream.frames.length;
      await fetch(`${base}/office/conversations/${CONV}/read`, {
        method: "POST", headers: { authorization: "Bearer staff", "content-type": "application/json" },
        body: JSON.stringify({ throughSeq: 2 }),
      });
      await settle(60);
      expect(stream.frames.length).toBe(before);
      stream.close();
    } finally {
      process.env.INBOX_FEED_POLL_MS = "15";
    }
  });
});

describe("HQ inbox stream", () => {
  it("needs an HQ identity with a conversation permission", async () => {
    const anonymous = await openStream("/hq/conversations/stream", "");
    expect(anonymous.status).toBe(401);
    mocks.hasPermission.mockReturnValue(false);
    const forbidden = await openStream("/hq/conversations/stream");
    expect(forbidden.status).toBe(403);
  });

  it("subscribes only to threads the department may read and filters hints by permission and office", async () => {
    mocks.hasPermission.mockImplementation((_staff: unknown, permission: string) => permission === "conversation_support");
    const clinicalThread = await openStream(`/hq/conversations/stream?conversation=${CONV}`);
    expect(clinicalThread.status).toBe(404);

    const stream = await openStream(`/hq/conversations/stream?conversation=${OTHER}&office=acct-office-b`);
    const ready = await stream.until(frame => frame.type === "ready");
    expect(ready).toMatchObject({ conversationId: OTHER });
    bump(CONV, "office-b", "care_team"); // wrong department
    bump(OTHER, "office-a", "support"); // wrong office
    await settle(80);
    expect(stream.frames.filter(frame => frame.type === "list")).toHaveLength(0);
    bump(OTHER, "office-b", "support");
    const list = await stream.until(frame => frame.type === "list");
    expect(list.conversations).toEqual([expect.objectContaining({ id: OTHER })]);
    stream.close();
  });
});
