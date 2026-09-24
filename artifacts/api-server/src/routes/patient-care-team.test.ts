import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  admin: vi.fn(),
  audit: vi.fn(),
  restricted: vi.fn(),
}));
vi.mock("../lib/office-restriction", () => ({
  officeRestrictedForNonpayment: mocks.restricted,
}));
vi.mock("../lib/patient-auth", () => ({ resolvePatient: mocks.resolve }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/admin-audit", () => ({
  recordAdminAuditEvent: mocks.audit,
  requestIdOf: () => "request-1",
}));
import router from "./patient-care-team";

const PATIENT = "00000000-0000-4000-8000-000000000001";
const OTHER_PATIENT = "00000000-0000-4000-8000-000000000002";
const CONVERSATION = "00000000-0000-4000-8000-000000000010";
const RETAINED = "00000000-0000-4000-8000-000000000011";
const USER = "00000000-0000-4000-8000-000000000020";

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let server: http.Server;
let base = "";

const current = (overrides: Record<string, unknown> = {}) => ({
  id: CONVERSATION, patient_id: PATIENT, provider_id: "office-a", office_name: "North Clinic",
  status: "open", last_seq: 240, last_staff_seq: 239, last_read_seq: 220,
  unread_count: 10, office_available: true,
  created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ...overrides,
});
const retained = () => current({
  id: RETAINED, provider_id: "office-old", office_name: "Former Clinic",
  last_seq: 30, last_staff_seq: 30, last_read_seq: 30, unread_count: 0,
});

async function request(method: string, path: string, body?: unknown, token = "patient") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: token ? `Bearer ${token}` : "", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, error => error ? reject(error) : resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  calls = [];
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.restricted.mockReset().mockResolvedValue(false);
  mocks.resolve.mockReset().mockResolvedValue({
    ok: true, patientId: PATIENT, authUserId: USER, consent: { satisfied: true },
  });
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path.startsWith("/rest/v1/patients?")) {
      return { status: 200, json: [{ id: PATIENT, provider_id: "office-a", activation_status: "activated" }] };
    }
    if (path === "/rest/v1/rpc/care_team_patient_bootstrap") {
      return { status: 200, json: [current(), retained()] };
    }
    if (path === "/rest/v1/rpc/care_team_start") {
      return { status: 200, json: { conversationId: CONVERSATION, created: true } };
    }
    if (path.startsWith("/rest/v1/patient_chat_messages?")) {
      const params = new URLSearchParams(path.split("?")[1]);
      const after = Number(params.get("seq")?.replace("gt.", "") || 0);
      const before = Number(params.get("seq")?.replace("lt.", "") || 0);
      const descending = params.get("order") === "seq.desc";
      let rows = Array.from({ length: 240 }, (_, index) => ({
        seq: index + 1, client_id: `m-${index + 1}`,
        role: (index + 1) % 2 ? "user" : "staff",
        text: `message ${index + 1}`, created_at: `2026-10-02T00:${String(index % 60).padStart(2, "0")}:00Z`,
        sender_user_id: "must-not-leak", sender_label: "must-not-leak",
        card: index + 1 === 130 ? {
          kind: "product_suggestion",
          payload: {
            mode: "individual",
            items: [{ productId: "p-1", slug: "daily", name: "Daily", imageUrl: null,
              purchase: "one_time", cadenceWeeks: null, quantity: 1, unitPriceCents: 1200 }],
            totalCents: 1200,
          },
        } : index + 1 === 131 ? { kind: "ai_coach_card", payload: { private: true } } : null,
      })).filter(row => (!after || row.seq > after) && (!before || row.seq < before));
      rows.sort((a, b) => descending ? b.seq - a.seq : a.seq - b.seq);
      return { status: 200, json: rows.slice(0, Number(params.get("limit") ?? 51)) };
    }
    if (path === "/rest/v1/rpc/care_team_send") {
      const input = body as Record<string, unknown>;
      return { status: 200, json: {
        created: true, seq: 241, clientId: input.p_client_id, role: "user",
        text: input.p_text, createdAt: "2026-10-02T01:00:00Z",
        senderUserId: "must-not-leak", senderLabel: "must-not-leak",
      } };
    }
    if (path === "/rest/v1/rpc/care_team_patient_read") {
      return { status: 200, json: { lastReadSeq: 240, changed: true } };
    }
    return { status: 404, json: { message: `unmocked ${method} ${path}` } };
  });
});

describe("patient care-team HTTP contract", () => {
  it("bootstraps current and retained business threads with complete patient-safe metadata", async () => {
    const result = await request("GET", "/patient-care-team");
    expect(result.status).toBe(200);
    expect(result.json.current).toMatchObject({
      id: CONVERSATION, providerId: "office-a", businessName: "North Clinic",
      current: true, canSend: true, unreadCount: 10, lastMessageSeq: 240, lastReadSeq: 220,
    });
    expect(result.json.retained).toEqual([
      expect.objectContaining({ id: RETAINED, current: false, canSend: false, businessName: "Former Clinic" }),
    ]);
    expect(JSON.stringify(result.json)).not.toMatch(/sender(UserId|Label)|must-not-leak/);
  });

  it("atomically starts the current business thread and rejects non-empty start bodies", async () => {
    const started = await request("POST", "/patient-care-team/start", {});
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({
      created: true, conversation: { id: CONVERSATION, businessName: "North Clinic", lastMessageSeq: 240 },
    });
    expect(calls.find(call => call.path === "/rest/v1/rpc/care_team_start")?.body)
      .toEqual({ p_patient_id: PATIENT, p_provider_id: "office-a" });
    expect((await request("POST", "/patient-care-team/start", { patientId: OTHER_PATIENT })).status).toBe(400);
  });

  it("pages all history before and after without a 200-message hydration cap or internal attribution", async () => {
    const older = await request("GET", `/patient-care-team/${CONVERSATION}/messages?before=230&limit=100`);
    expect(older.status).toBe(200);
    expect((older.json.messages as unknown[])).toHaveLength(100);
    expect((older.json.messages as Array<Record<string, unknown>>)[0]).toEqual({
      seq: 130, clientId: "m-130", sender: "care_team", text: "message 130",
      createdAt: "2026-10-02T00:09:00Z",
      suggestion: expect.objectContaining({ mode: "individual", totalCents: 1200 }),
    });
    expect(older.json.nextBefore).toBe(130);
    expect(JSON.stringify(older.json)).not.toContain("must-not-leak");

    const newer = await request("GET", `/patient-care-team/${CONVERSATION}/messages?after=200&limit=20`);
    expect((newer.json.messages as Array<Record<string, unknown>>).map(row => row.seq))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 201));
    expect(newer.json.nextBefore).toBeNull();
    expect(newer.json.nextAfter).toBe(220);
    expect((await request("GET", `/patient-care-team/${CONVERSATION}/messages?before=5&after=2`)).status).toBe(400);
  });

  it("fixes patient sender attribution and preserves stable client-id conflict behavior", async () => {
    const sent = await request("POST", `/patient-care-team/${CONVERSATION}/messages`, {
      clientId: "device-stable-1", text: " Hello team ",
    });
    expect(sent.status).toBe(200);
    expect(sent.json.message).toEqual({
      seq: 241, clientId: "device-stable-1", sender: "patient",
      text: "Hello team", createdAt: "2026-10-02T01:00:00Z", suggestion: null,
    });
    expect(calls.find(call => call.path === "/rest/v1/rpc/care_team_send")?.body).toMatchObject({
      p_patient_id: PATIENT, p_provider_id: "office-a", p_role: "user",
      p_sender_user_id: null, p_sender_label: null, p_client_id: "device-stable-1",
    });
    // HQ Insights: the created message is one care_team_message event keyed
    // on <conversation>:<client id>, so a retried send can never count twice.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.find(call => call.path === "/rest/v1/rpc/patient_app_event_record")?.body).toMatchObject({
      p_patient_id: PATIENT, p_feature: "care_team_message",
      p_source_keys: [`${CONVERSATION}:device-stable-1`],
    });
    expect((await request("POST", `/patient-care-team/${CONVERSATION}/messages`,
      { clientId: "bad id", text: "x" })).status).toBe(400);
    expect((await request("POST", `/patient-care-team/${CONVERSATION}/messages`,
      { clientId: "x", text: "x", role: "staff" })).status).toBe(400);

    mocks.admin.mockImplementationOnce(async () => ({ status: 200, json: [{ id: PATIENT, provider_id: "office-a", activation_status: "activated" }] }))
      .mockImplementationOnce(async () => ({ status: 200, json: [current()] }))
      .mockImplementationOnce(async () => ({ status: 409, json: { message: "client id payload conflict" } }));
    expect((await request("POST", `/patient-care-team/${CONVERSATION}/messages`,
      { clientId: "device-stable-1", text: "different" })).status).toBe(409);
  });

  it("uses an explicit monotonic read high-water and audits only an actual advance", async () => {
    const first = await request("POST", `/patient-care-team/${CONVERSATION}/read`, { throughSeq: 240 });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ lastReadSeq: 240, changed: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "patient_care_team_read", actorKind: "patient", targetId: CONVERSATION,
      metadata: { throughSeq: 240 },
    }));

    mocks.audit.mockClear();
    mocks.admin.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/rest/v1/patients?")) return { status: 200, json: [{ id: PATIENT, provider_id: "office-a", activation_status: "activated" }] };
      if (path === "/rest/v1/rpc/care_team_patient_bootstrap") return { status: 200, json: [current()] };
      if (path === "/rest/v1/rpc/care_team_patient_read") return { status: 200, json: { lastReadSeq: 240, changed: false } };
      return { status: 404, json: null };
    });
    expect((await request("POST", `/patient-care-team/${CONVERSATION}/read`, { throughSeq: 230 })).json.changed).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails closed for anonymous, consent, wrong-patient, archived/deleting/disabled, retained, and locked states", async () => {
    mocks.resolve.mockResolvedValueOnce({ ok: false, status: 401, error: "Sign in required." });
    expect((await request("GET", "/patient-care-team", undefined, "")).status).toBe(401);
    mocks.resolve.mockResolvedValueOnce({ ok: false, status: 403, error: "Consent required", details: { code: "CONSENT_REQUIRED" } });
    expect((await request("GET", "/patient-care-team")).status).toBe(403);

    mocks.admin.mockImplementationOnce(async () => ({ status: 200, json: [] }));
    expect((await request("GET", "/patient-care-team")).status).toBe(403);

    mocks.admin.mockImplementationOnce(async () => ({ status: 200, json: [{ id: PATIENT, provider_id: "office-a", activation_status: "disabled" }] }));
    expect((await request("POST", "/patient-care-team/start", {})).status).toBe(403);

    expect((await request("GET", `/patient-care-team/${OTHER_PATIENT}/messages`)).status).toBe(404);
    expect((await request("POST", `/patient-care-team/${RETAINED}/messages`,
      { clientId: "retained-1", text: "no" })).status).toBe(409);

    mocks.admin.mockImplementationOnce(async () => ({ status: 200, json: [{ id: PATIENT, provider_id: "office-a", activation_status: "activated" }] }))
      .mockImplementationOnce(async () => ({ status: 200, json: [current({ office_available: false })] }));
    const locked = await request("GET", `/patient-care-team/${CONVERSATION}/messages`);
    expect(locked.status).toBe(200);
    expect((locked.json.conversation as Record<string, unknown>).canSend).toBe(false);
    mocks.admin.mockImplementationOnce(async () => ({ status: 200, json: [{ id: PATIENT, provider_id: "office-a", activation_status: "activated" }] }))
      .mockImplementationOnce(async () => ({ status: 200, json: [current({ office_available: false })] }));
    expect((await request("POST", `/patient-care-team/${CONVERSATION}/messages`,
      { clientId: "locked-1", text: "no" })).status).toBe(403);
  });
  it("makes the thread read-only, with the office's phone and no billing hint, while the office is restricted", async () => {
    mocks.restricted.mockResolvedValue(true);
    const base = mocks.admin.getMockImplementation()!;
    mocks.admin.mockImplementation(async (method: string, path: string, body?: unknown) =>
      path.startsWith("/rest/v1/providers?")
        ? { status: 200, json: [{ phone: "(555) 010-2030" }] }
        : base(method, path, body));

    const listed = await request("GET", "/patient-care-team");
    const thread = listed.json.current as Record<string, unknown>;
    expect(thread.canSend).toBe(false);
    expect(thread.officePhone).toBe("(555) 010-2030");
    expect(String(thread.readOnlyNotice)).toContain("(555) 010-2030");
    // The patient is told how to reach the office, never why the thread paused.
    expect(JSON.stringify(listed.json)).not.toMatch(/billing|unpaid|overdue|payment/i);
    // A thread the office never left keeps its own history readable too.
    expect((listed.json.retained as Array<Record<string, unknown>>)[0].readOnlyNotice).toBeNull();

    const history = await request("GET", `/patient-care-team/${CONVERSATION}/messages`);
    expect(history.status).toBe(200);
    expect((history.json.messages as unknown[]).length).toBeGreaterThan(0);
    expect((history.json.conversation as Record<string, unknown>).canSend).toBe(false);

    // Sending is refused by the server, not merely hidden by the app.
    const sent = await request("POST", `/patient-care-team/${CONVERSATION}/messages`,
      { clientId: "restricted-1", text: "hello?" });
    expect(sent.status).toBe(403);
    expect(JSON.stringify(sent.json)).not.toMatch(/billing|unpaid|overdue|payment/i);
    expect(calls.some(call => call.path === "/rest/v1/rpc/care_team_send")).toBe(false);
  });

  it("leaves messaging open when the office's access state cannot be read", async () => {
    mocks.restricted.mockRejectedValue(new Error("access state unavailable"));
    const listed = await request("GET", "/patient-care-team");
    expect((listed.json.current as Record<string, unknown>).canSend).toBe(true);
  });

  it("resumes sending the moment the office pays, with no HQ action", async () => {
    mocks.restricted.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(((await request("GET", "/patient-care-team")).json.current as Record<string, unknown>).canSend).toBe(false);

    const listed = await request("GET", "/patient-care-team");
    const thread = listed.json.current as Record<string, unknown>;
    expect(thread.canSend).toBe(true);
    expect(thread.readOnlyNotice).toBeNull();
    expect(thread.officePhone).toBeNull();
    const sent = await request("POST", `/patient-care-team/${CONVERSATION}/messages`,
      { clientId: "recovered-1", text: "hello again" });
    expect(sent.status).toBe(200);
  });
});
