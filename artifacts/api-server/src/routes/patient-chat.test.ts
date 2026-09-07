/**
 * Patient-chat routes suite — durable per-patient chat transcripts.
 *
 * Runs against an in-memory fake of the Supabase REST + GoTrue surfaces
 * (same approach as patient-data.test.ts) so the auth ladder, the
 * client-shape round-trip, upsert idempotency, field-by-field validation,
 * photo-path ownership, cross-patient isolation, thread separation, the
 * transcript cap, and the friendly failure answers can all be exercised
 * deterministically.
 *
 * The contract under test is the app's restart-resume story: what the
 * client stores is EXACTLY the on-screen message shape, and what hydration
 * returns is that same shape oldest-first — so a reload renders the
 * conversation as it originally appeared.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_POLICY_VERSION } from "../privacy/consent";
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

const FAKE_SUPABASE = "http://fake.supabase.local";

type Row = Record<string, unknown>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** `?col=eq.value` reader for the handful of filters these routes use. */
function eqParam(url: URL, col: string): string | null {
  const raw = url.searchParams.get(col);
  if (!raw || !raw.startsWith("eq.")) return null;
  return decodeURIComponent(raw.slice(3));
}

class FakeChatBackend {
  patients: Row[] = [];
  /** Consent rows — every chat route enforces the current policy version. */
  consents: Row[] = [];
  conversations: Row[] = [];
  messages: Row[] = [];
  /** access token → auth user id */
  tokens = new Map<string, string>();
  authOutage = false;
  /** one-shot 500s: 'RPC patient_chat_apply' | 'GET patient_chat_messages' | 'GET patient_chat_conversations' */
  failOnce = new Set<string>();
  rpcCalls = 0;
  private convSeq = 0;
  private msgSeq = 0;

  reset() {
    this.patients = [];
    this.consents = [];
    this.conversations = [];
    this.messages = [];
    this.tokens.clear();
    this.authOutage = false;
    this.failOnce.clear();
    this.rpcCalls = 0;
    this.convSeq = 0;
    this.msgSeq = 0;
  }

  seedSignedInPatient(
    token: string,
    overrides: Row = {},
  ): { patientId: string; userId: string } {
    const userId = crypto.randomUUID();
    this.tokens.set(token, userId);
    const row: Row = {
      id: crypto.randomUUID(),
      auth_user_id: userId,
      name: "Riley Chen",
      program_start_date: "2026-08-10",
      created_at: "2026-08-10T09:00:00Z",
      ...overrides,
    };
    this.patients.push(row);
    this.consents.push({
      id: crypto.randomUUID(),
      patient_id: row.id,
      policy_version: CONSENT_POLICY_VERSION,
      terms_accepted: true,
      privacy_accepted: true,
      health_data_accepted: true,
      photo_analysis_accepted: true,
      app_version: null,
      platform: null,
      recorded_at: "2026-09-01T00:00:00Z",
    });
    return { patientId: String(row.id), userId };
  }

  conversationFor(patientId: string, thread: string): Row {
    let conv = this.conversations.find(
      c => String(c.patient_id) === patientId && String(c.thread) === thread,
    );
    if (!conv) {
      conv = { id: `conv-${++this.convSeq}`, patient_id: patientId, thread };
      this.conversations.push(conv);
    }
    return conv;
  }

  /** Direct seeding for the transcript-cap test (bypasses the 20/append cap). */
  seedMessages(patientId: string, thread: string, rows: Array<Partial<Row> & { client_id: string }>) {
    const conv = this.conversationFor(patientId, thread);
    for (const row of rows) {
      this.messages.push({
        conversation_id: conv.id,
        role: "user",
        text: "",
        stopped: false,
        hidden: false,
        card: null,
        quick_replies: null,
        reply_to_client_id: null,
        photo: null,
        ...row,
        seq: ++this.msgSeq,
      });
    }
  }

  handle(href: string, init?: RequestInit): Response {
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);

    if (url.pathname === "/auth/v1/user") {
      if (this.authOutage) return json(500, { error: "outage" });
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const userId = this.tokens.get(token);
      if (!userId) return json(401, { message: "invalid token" });
      return json(200, { id: userId, email: null, phone: null });
    }

    if (url.pathname === "/rest/v1/rpc/patient_chat_apply") {
      this.rpcCalls += 1;
      if (this.failOnce.has("RPC patient_chat_apply")) {
        this.failOnce.delete("RPC patient_chat_apply");
        return json(500, { message: "fake upstream failure" });
      }
      // Mirrors the SQL function: one transaction — conversation upsert,
      // then message upserts by (conversation_id, client_id) that overwrite
      // content but PRESERVE seq, so updates never reorder the transcript.
      const args = JSON.parse(String(init?.body ?? "{}")) as {
        p_patient_id: string;
        p_thread: string;
        p_messages: Row[];
      };
      const conv = this.conversationFor(args.p_patient_id, args.p_thread);
      for (const incoming of args.p_messages ?? []) {
        const existing = this.messages.find(
          m =>
            String(m.conversation_id) === String(conv.id) &&
            String(m.client_id) === String(incoming.client_id),
        );
        if (existing) {
          const seq = existing.seq;
          Object.assign(existing, incoming, { conversation_id: conv.id, seq });
        } else {
          this.messages.push({ ...incoming, conversation_id: conv.id, seq: ++this.msgSeq });
        }
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/rest/v1/patients" && method === "GET") {
      const byUser = eqParam(url, "auth_user_id");
      const byId = eqParam(url, "id");
      const rows = this.patients.filter(
        p =>
          (byUser === null || String(p.auth_user_id) === byUser) &&
          (byId === null || String(p.id) === byId),
      );
      return json(200, rows);
    }

    if (url.pathname === "/rest/v1/patient_consents" && method === "GET") {
      const byPatient = eqParam(url, "patient_id");
      return json(200, this.consents.filter(c => String(c.patient_id) === byPatient));
    }

    if (url.pathname === "/rest/v1/patient_chat_conversations" && method === "GET") {
      if (this.failOnce.has("GET patient_chat_conversations")) {
        this.failOnce.delete("GET patient_chat_conversations");
        return json(500, { message: "fake upstream failure" });
      }
      const pid = eqParam(url, "patient_id");
      const thread = eqParam(url, "thread");
      const rows = this.conversations
        .filter(
          c =>
            (pid === null || String(c.patient_id) === pid) &&
            (thread === null || String(c.thread) === thread),
        )
        .map(c => ({ id: c.id }));
      return json(200, rows);
    }

    if (url.pathname === "/rest/v1/patient_chat_messages" && method === "GET") {
      if (this.failOnce.has("GET patient_chat_messages")) {
        this.failOnce.delete("GET patient_chat_messages");
        return json(500, { message: "fake upstream failure" });
      }
      const convId = eqParam(url, "conversation_id");
      let rows = this.messages.filter(
        m => convId === null || String(m.conversation_id) === convId,
      );
      // The route asks newest-first by seq with a limit; honor it numerically.
      if ((url.searchParams.get("order") ?? "").startsWith("seq.desc")) {
        rows = [...rows].sort((a, b) => Number(b.seq) - Number(a.seq));
      }
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return json(200, rows);
    }

    return json(404, { message: `fake: no route ${method} ${url.pathname}` });
  }
}

const backend = new FakeChatBackend();
const realFetch = globalThis.fetch.bind(globalThis);
let server: http.Server;
let base: string;

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const response = await realFetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** A storage path inside the given patient's own patient-media prefix. */
function ownPhotoPath(patientId: string, name = "chat-abcdef123456"): string {
  return `/objects/patient-media/${patientId}/${name}`;
}

beforeAll(async () => {
  process.env.SUPABASE_URL = FAKE_SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  for (const knob of ["READ", "WRITE"]) {
    process.env[`PATIENT_CHAT_${knob}_BURST`] = "100000";
    process.env[`PATIENT_CHAT_${knob}_DAILY_BUDGET`] = "100000";
  }

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).hostname === "fake.supabase.local") {
      return Promise.resolve(backend.handle(href, init));
    }
    return realFetch(input as string, init);
  });

  const { default: patientChatRouter } = await import("./patient-chat");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: () => {},
    };
    next();
  });
  app.use("/api", patientChatRouter);
  server = app.listen(0);
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  backend.reset();
});

describe("auth ladder", () => {
  it("rejects requests without a bearer token", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/patient-chat/coach", undefined],
      ["POST", "/api/patient-chat/coach/messages", { messages: [{ id: "u-1", role: "user", text: "hi" }] }],
    ] as const) {
      const res = await api(method, path, { body });
      expect(res.status).toBe(401);
      expect(res.json.error).toBe("Sign in required.");
    }
  });

  it("rejects unknown/expired tokens", async () => {
    const res = await api("GET", "/api/patient-chat/coach", { token: "stale" });
    expect(res.status).toBe(401);
    expect(res.json.error).toBe("Sign in required.");
  });

  it("responds 503 (not 401) when the auth lookup is down", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.authOutage = true;
    const res = await api("GET", "/api/patient-chat/coach", { token: "tok-1" });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe("Account lookup is unavailable right now.");
  });

  it("rejects signed-in accounts with no linked patient row", async () => {
    backend.tokens.set("tok-staff", crypto.randomUUID());
    const res = await api("GET", "/api/patient-chat/coach", { token: "tok-staff" });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("This account is not linked to a patient record.");
  });

  it("knows only the coach and support threads", async () => {
    backend.seedSignedInPatient("tok-1");
    for (const [method, path, body] of [
      ["GET", "/api/patient-chat/diary", undefined],
      ["POST", "/api/patient-chat/diary/messages", { messages: [{ id: "u-1", role: "user", text: "hi" }] }],
    ] as const) {
      const res = await api(method, path, { token: "tok-1", body });
      expect(res.status).toBe(404);
      expect(res.json.error).toBe("No such chat thread.");
    }
  });
});

describe("round-trip: what the app stores is what hydration returns", () => {
  it("answers an empty thread with no messages plus the greeting facts", async () => {
    backend.seedSignedInPatient("tok-1");
    const res = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    expect(res.status).toBe(200);
    expect(res.json.messages).toEqual([]);
    // Day 12: enrolled 2026-08-10, asking on 2026-08-22.
    expect(res.json.patient).toEqual({ firstName: "Riley", programDay: 12 });
  });

  it("falls back to created_at for the program day when no start date is recorded", async () => {
    backend.seedSignedInPatient("tok-1", {
      program_start_date: null,
      created_at: "2026-08-01T10:00:00Z",
    });
    const res = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    expect(res.status).toBe(200);
    expect(res.json.patient.programDay).toBe(21);
  });

  it("stores and returns the full client message shape, oldest first", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    const photoPath = ownPhotoPath(patientId);
    const post = await api("POST", "/api/patient-chat/coach/messages", {
      token: "tok-1",
      body: {
        messages: [
          { id: "u-1", role: "user", text: "What should I eat?" },
          {
            id: "a-1",
            role: "assistant",
            text: "Try the grilled chicken with",
            stopped: true,
            card: { kind: "food", refId: "grilled-chicken" },
            quickReplies: ["Yes, please", "No thanks"],
            replyToId: "u-1",
          },
          {
            id: "p-1",
            role: "user",
            text: "I sent a photo of my meal.",
            photo: { path: photoPath, width: 1024, height: 768, kind: "meal", mealSlot: "lunch", reused: true },
          },
        ],
      },
    });
    expect(post.status).toBe(200);
    expect(post.json).toEqual({ ok: true });

    const res = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    expect(res.status).toBe(200);
    expect(res.json.messages).toEqual([
      { id: "u-1", role: "user", text: "What should I eat?" },
      {
        id: "a-1",
        role: "assistant",
        text: "Try the grilled chicken with",
        stopped: true,
        card: { kind: "food", refId: "grilled-chicken" },
        quickReplies: ["Yes, please", "No thanks"],
        replyToId: "u-1",
      },
      {
        id: "p-1",
        role: "user",
        text: "I sent a photo of my meal.",
        photo: { path: photoPath, width: 1024, height: 768, kind: "meal", mealSlot: "lunch", reused: true },
      },
    ]);
  });

  it("re-appending a client id updates the payload without reordering (card-state updates)", async () => {
    backend.seedSignedInPatient("tok-1");
    await api("POST", "/api/patient-chat/coach/messages", {
      token: "tok-1",
      body: {
        messages: [
          { id: "u-1", role: "user", text: "hi" },
          { id: "a-1", role: "assistant", text: "Hello.", card: { kind: "food", saved: false } },
          { id: "u-2", role: "user", text: "thanks" },
        ],
      },
    });
    // Outbox retry / card update: same id, new card payload.
    const again = await api("POST", "/api/patient-chat/coach/messages", {
      token: "tok-1",
      body: {
        messages: [{ id: "a-1", role: "assistant", text: "Hello.", card: { kind: "food", saved: true } }],
      },
    });
    expect(again.status).toBe(200);

    const res = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    expect(res.json.messages.map((m: any) => m.id)).toEqual(["u-1", "a-1", "u-2"]);
    expect(res.json.messages[1].card).toEqual({ kind: "food", saved: true });
    expect(backend.messages.length).toBe(3);
  });

  it("caps hydration at the newest 200 messages, still oldest first", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedMessages(
      patientId,
      "coach",
      Array.from({ length: 205 }, (_, i) => ({ client_id: `m-${i + 1}`, text: `t${i + 1}` })),
    );
    const res = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    expect(res.status).toBe(200);
    expect(res.json.messages.length).toBe(200);
    // The cap drops the OLDEST five, never the latest exchange.
    expect(res.json.messages[0].id).toBe("m-6");
    expect(res.json.messages[199].id).toBe("m-205");
  });
});

describe("validation", () => {
  let patientId: string;
  beforeEach(() => {
    patientId = backend.seedSignedInPatient("tok-1").patientId;
  });

  async function postMessages(messages: unknown): Promise<{ status: number; json: any }> {
    return api("POST", "/api/patient-chat/coach/messages", { token: "tok-1", body: { messages } });
  }

  it("rejects malformed batches and fields with specific errors", async () => {
    const cases: Array<[unknown, string]> = [
      [[], "Invalid message batch."],
      [
        Array.from({ length: 21 }, (_, i) => ({ id: `m-${i}`, role: "user", text: "x" })),
        "Invalid message batch.",
      ],
      [[{ id: "bad id!", role: "user", text: "x" }], "Invalid message id."],
      [[{ id: "x".repeat(65), role: "user", text: "x" }], "Invalid message id."],
      [[{ id: "u-1", role: "system", text: "x" }], "Invalid message role."],
      [[{ id: "u-1", role: "user", text: "x".repeat(40_001) }], "Invalid message text."],
      [[{ id: "u-1", role: "user", text: "x", stopped: "yes" }], "Invalid message."],
      [[{ id: "a-1", role: "assistant", text: "x", card: { refId: "no-kind" } }], "Invalid card."],
      [[{ id: "a-1", role: "assistant", text: "x", card: { kind: "k".repeat(41) } }], "Invalid card."],
      [
        [{ id: "a-1", role: "assistant", text: "x", card: { kind: "recipe", blob: "x".repeat(24_000) } }],
        "That card is too large to store.",
      ],
      [[{ id: "a-1", role: "assistant", text: "x", quickReplies: [] }], "Invalid quick replies."],
      [
        [{ id: "a-1", role: "assistant", text: "x", quickReplies: ["1", "2", "3", "4", "5"] }],
        "Invalid quick replies.",
      ],
      [
        [{ id: "a-1", role: "assistant", text: "x", quickReplies: ["y".repeat(81)] }],
        "Invalid quick replies.",
      ],
      [[{ id: "a-1", role: "assistant", text: "x", replyToId: "bad id!" }], "Invalid reply link."],
      [
        [{ id: "p-1", role: "user", text: "x", photo: { path: "/objects/other/pic", width: 10, height: 10 } }],
        "That photo isn't yours to reference.",
      ],
      [
        [{ id: "p-1", role: "user", text: "x", photo: { path: ownPhotoPath(patientId), width: 0, height: 10 } }],
        "Invalid photo size.",
      ],
      [
        [
          {
            id: "p-1",
            role: "user",
            text: "x",
            photo: { path: ownPhotoPath(patientId), width: 10, height: 10, kind: "selfie" },
          },
        ],
        "Invalid photo kind.",
      ],
      [
        [
          {
            id: "p-1",
            role: "user",
            text: "x",
            photo: { path: ownPhotoPath(patientId), width: 10, height: 10, mealSlot: "brunch" },
          },
        ],
        "Invalid photo meal slot.",
      ],
    ];
    for (const [messages, error] of cases) {
      const res = await postMessages(messages);
      expect(res.status, JSON.stringify(messages).slice(0, 80)).toBe(400);
      expect(res.json.error).toBe(error);
    }
    // Nothing above may have reached storage.
    expect(backend.rpcCalls).toBe(0);
  });

  it("rejects a photo path under ANOTHER patient's prefix", async () => {
    const other = backend.seedSignedInPatient("tok-2");
    const res = await postMessages([
      { id: "p-1", role: "user", text: "x", photo: { path: ownPhotoPath(other.patientId), width: 10, height: 10 } },
    ]);
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("That photo isn't yours to reference.");
  });
});

describe("isolation", () => {
  it("keeps accounts and threads separate", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.seedSignedInPatient("tok-2", { name: "Jordan Fox" });

    await api("POST", "/api/patient-chat/coach/messages", {
      token: "tok-1",
      body: { messages: [{ id: "u-1", role: "user", text: "coach question" }] },
    });
    await api("POST", "/api/patient-chat/support/messages", {
      token: "tok-1",
      body: { messages: [{ id: "s-1", role: "user", text: "support question" }] },
    });

    // Another patient sees nothing.
    const other = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-2" });
    expect(other.json.messages).toEqual([]);
    expect(other.json.patient.firstName).toBe("Jordan");

    // Threads do not bleed into each other.
    const coach = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    const support = await api("GET", "/api/patient-chat/support?today=2026-08-22", { token: "tok-1" });
    expect(coach.json.messages.map((m: any) => m.id)).toEqual(["u-1"]);
    expect(support.json.messages.map((m: any) => m.id)).toEqual(["s-1"]);
  });
});

describe("failure answers", () => {
  it("answers a storage write failure with the friendly 502", async () => {
    backend.seedSignedInPatient("tok-1");
    backend.failOnce.add("RPC patient_chat_apply");
    const res = await api("POST", "/api/patient-chat/coach/messages", {
      token: "tok-1",
      body: { messages: [{ id: "u-1", role: "user", text: "hi" }] },
    });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't save your conversation right now. Please try again.");
  });

  it("answers a transcript read failure with the friendly 502", async () => {
    const { patientId } = backend.seedSignedInPatient("tok-1");
    backend.seedMessages(patientId, "coach", [{ client_id: "m-1", text: "hello" }]);
    backend.failOnce.add("GET patient_chat_messages");
    const res = await api("GET", "/api/patient-chat/coach?today=2026-08-22", { token: "tok-1" });
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("Couldn't load your conversation right now. Please try again.");
  });
});
