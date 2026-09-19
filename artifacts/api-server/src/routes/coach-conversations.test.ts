import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  patient: vi.fn(),
  office: vi.fn(),
  admin: vi.fn(),
  profile: vi.fn(),
  signedDownload: vi.fn(),
}));
vi.mock("../lib/patient-auth", () => ({ resolvePatient: mocks.patient }));
vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: mocks.office,
  respondOfficeScopeDenied: (_req: unknown, res: { status: (s: number) => { json: (x: unknown) => void } }, denial: { status: number; message: string }) =>
    res.status(denial.status).json({ error: denial.message }),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/objectStorage", () => ({
  objectStorage: { signedDownloadURL: mocks.signedDownload },
}));
vi.mock("../coach/real-patient", () => ({
  fetchPatientProfile: mocks.profile,
  firstNameOf: (name: string) => name.split(" ")[0],
  isDateKey: (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\d$/.test(value),
  programDayFor: () => 5,
}));

const PATIENT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CONVERSATION = "00000000-0000-4000-8000-000000000010";
const row = (overrides: Record<string, unknown> = {}) => ({
  id: CONVERSATION, title: "Pasta swaps", title_state: "ready", archived_at: null,
  created_at: "2026-10-08T10:00:00Z", updated_at: "2026-10-08T10:01:00Z",
  version: 1, processing_state: "ready", ...overrides,
});

let server: http.Server;
let base = "";
const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { authorization: "Bearer patient", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as any };
}

beforeAll(async () => {
  const { default: router } = await import("./coach-conversations");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { log: { error: () => void } }).log = { error: () => {} }; next(); });
  app.use(router);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, error => error ? reject(error) : resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

beforeEach(() => {
  calls.length = 0;
  mocks.patient.mockReset().mockResolvedValue({ ok: true, patientId: PATIENT, authUserId: "user", consent: {} });
  mocks.profile.mockReset().mockResolvedValue({ name: "Riley Chen", timezone: "UTC", program_start_date: "2026-10-04" });
  mocks.signedDownload.mockReset().mockResolvedValue("https://storage.example/signed-photo");
  mocks.office.mockReset().mockResolvedValue({
    kind: "ok", scope: { providerId: "office-a", officeName: "Office A", actorUserId: "staff", actorKind: "provider" },
  });
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, body });
    if (path === "/rest/v1/rpc/coach_conversation_list") return { status: 200, json: [row({ total: 2 })] };
    if (path === "/rest/v1/rpc/coach_conversation_create") return { status: 200, json: [row()] };
    if (path === "/rest/v1/rpc/coach_conversation_get") return { status: 200, json: [row()] };
    if (path === "/rest/v1/rpc/coach_conversation_append") return { status: 200, json: "ok" };
    if (path === "/rest/v1/rpc/coach_conversation_archive") return { status: 200, json: "ok" };
    if (path.startsWith("/rest/v1/patient_chat_messages?")) {
      return { status: 200, json: [
        { client_id: "a-1", role: "assistant", text: "Try chicken.", stopped: false, hidden: false, card: null, quick_replies: null, reply_to_client_id: null, photo: null, seq: 2, created_at: "2026-10-08T10:01:00Z" },
        { client_id: "u-1", role: "user", text: "Pasta?", stopped: false, hidden: false, card: null, quick_replies: null, reply_to_client_id: null, photo: null, seq: 1, created_at: "2026-10-08T10:00:00Z" },
      ] };
    }
    if (path.startsWith("/rest/v1/patients?")) return { status: 200, json: [{ id: PATIENT }] };
    if (path.startsWith("/rest/v1/patient_media?")) return { status: 200, json: [{ object_path: "unused" }] };
    if (path.startsWith("/rest/v1/patient_chat_conversations?")) return { status: 200, json: [row()] };
    return { status: 500, json: null };
  });
});

describe("patient coach conversations", () => {
  it("lists only bearer-scoped conversations with private no-store paging", async () => {
    const result = await api("GET", "/patient-coach/conversations?limit=1&offset=0");
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ total: 2, nextOffset: 1, conversations: [{ id: CONVERSATION, title: "Pasta swaps" }] });
    expect(calls[0]).toMatchObject({ path: "/rest/v1/rpc/coach_conversation_list", body: { p_patient_id: PATIENT, p_archived: false, p_limit: 1 } });
  });

  it("uses a client key for lazy idempotent creation and preserves paged transcript order", async () => {
    const created = await api("POST", "/patient-coach/conversations", { clientKey: "fresh-device-key" });
    expect(created.status).toBe(200);
    expect(calls[0].body).toMatchObject({ p_patient_id: PATIENT, p_client_key: "fresh-device-key" });
    const detail = await api("GET", `/patient-coach/conversations/${CONVERSATION}?before=9`);
    expect(detail.status).toBe(200);
    expect(detail.json.messages.map((message: { id: string }) => message.id)).toEqual(["u-1", "a-1"]);
    expect(detail.json.messages[0]).toMatchObject({ seq: 1, createdAt: "2026-10-08T10:00:00Z" });
  });

  it("uses the oldest returned sequence as an exclusive transcript cursor without overlap", async () => {
    const message = (seq: number) => ({
      client_id: `m-${seq}`, role: "user", text: `message ${seq}`, stopped: false, hidden: false,
      card: null, quick_replies: null, reply_to_client_id: null, photo: null, seq,
      created_at: "2026-10-08T10:00:00Z",
    });
    mocks.admin.mockImplementation(async (_method: string, path: string) => {
      if (path === "/rest/v1/rpc/coach_conversation_get") return { status: 200, json: [row()] };
      if (path.startsWith("/rest/v1/patient_chat_messages?")) {
        const before = Number(path.match(/seq=lt\.(\d+)/)?.[1] ?? 257);
        const high = before - 1;
        return { status: 200, json: Array.from({ length: Math.min(101, high) }, (_, index) => message(high - index)) };
      }
      return { status: 500, json: null };
    });
    const first = await api("GET", `/patient-coach/conversations/${CONVERSATION}`);
    expect(first.json.messages.map((item: { seq: number }) => item.seq)).toEqual(Array.from({ length: 100 }, (_, index) => index + 157));
    expect(first.json.nextBefore).toBe(157);
    const second = await api("GET", `/patient-coach/conversations/${CONVERSATION}?before=${first.json.nextBefore}`);
    expect(second.json.messages.map((item: { seq: number }) => item.seq)).toEqual(Array.from({ length: 100 }, (_, index) => index + 57));
    expect(second.json.nextBefore).toBe(57);
    const final = await api("GET", `/patient-coach/conversations/${CONVERSATION}?before=${second.json.nextBefore}`);
    expect(final.json.messages.map((item: { seq: number }) => item.seq)).toEqual(Array.from({ length: 56 }, (_, index) => index + 1));
    expect(final.json.nextBefore).toBeNull();
  });

  it("keys each patient-authored row of an append on <conversation>:<message id> for HQ Insights, so replays cannot recount", async () => {
    const messages = [
      { id: "u-1", role: "user", text: "Pasta?" },
      { id: "a-1", role: "assistant", text: "Go for the zucchini noodles." },
      { id: "u-2", role: "user", text: "Deal." },
    ];
    const append = await api("POST", `/patient-coach/conversations/${CONVERSATION}/messages`, { messages });
    expect(append.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = calls.filter((call) => call.path === "/rest/v1/rpc/patient_app_event_record");
    expect(events).toHaveLength(1);
    expect(events[0].body).toMatchObject({
      p_patient_id: PATIENT, p_feature: "coach_message",
      p_source_keys: [`${CONVERSATION}:u-1`, `${CONVERSATION}:u-2`],
    });
    // Replaying the same finalized batch produces the very same keys.
    await api("POST", `/patient-coach/conversations/${CONVERSATION}/messages`, { messages });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replayed = calls.filter((call) => call.path === "/rest/v1/rpc/patient_app_event_record");
    expect(replayed).toHaveLength(2);
    expect(replayed[1].body?.p_source_keys).toEqual(events[0].body?.p_source_keys);
  });

  it("maps exact SQL ownership/archive and version outcomes without trusting a body patient id", async () => {
    mocks.admin.mockImplementation(async (_method: string, path: string) => {
      if (path === "/rest/v1/rpc/coach_conversation_append") return { status: 200, json: "archived" };
      if (path === "/rest/v1/rpc/coach_conversation_archive") return { status: 200, json: "conflict" };
      return { status: 200, json: [row()] };
    });
    const append = await api("POST", `/patient-coach/conversations/${CONVERSATION}/messages`, {
      messages: [{ id: "u-1", role: "user", text: "Pasta?" }], patientId: OTHER,
    });
    expect(append).toMatchObject({ status: 403, json: { error: expect.stringMatching(/Restore/) } });
    const update = await api("PATCH", `/patient-coach/conversations/${CONVERSATION}`, { archived: true, expectedVersion: 1 });
    expect(update.status).toBe(409);
  });

  it("renames through the rename RPC with a shaped title and maps its outcomes", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      if (path === "/rest/v1/rpc/coach_conversation_rename") {
        return { status: 200, json: body?.p_expected_version === 7 ? "conflict" : body?.p_title === "" ? "invalid" : "ok" };
      }
      return { status: 200, json: [row({ title: "Chipotle dinner plan", version: 2 })] };
    });
    const renamed = await api("PATCH", `/patient-coach/conversations/${CONVERSATION}`, {
      title: "  Chipotle - dinner   plan!  ", expectedVersion: 1,
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.conversation).toMatchObject({ title: "Chipotle dinner plan", version: 2 });
    expect(calls[0]).toMatchObject({
      path: "/rest/v1/rpc/coach_conversation_rename",
      body: { p_patient_id: PATIENT, p_conversation_id: CONVERSATION, p_title: "Chipotle dinner plan", p_expected_version: 1 },
    });
    expect(calls.some(call => call.path === "/rest/v1/rpc/coach_conversation_archive")).toBe(false);
    expect((await api("PATCH", `/patient-coach/conversations/${CONVERSATION}`, { title: "Stale", expectedVersion: 7 })).status).toBe(409);
    expect((await api("PATCH", `/patient-coach/conversations/${CONVERSATION}`, { title: "!!!", expectedVersion: 1 })).status).toBe(400);
    // Never both intents in one call, and never an empty body.
    expect((await api("PATCH", `/patient-coach/conversations/${CONVERSATION}`, { title: "A", archived: true, expectedVersion: 1 })).status).toBe(400);
    expect((await api("PATCH", `/patient-coach/conversations/${CONVERSATION}`, { expectedVersion: 1 })).status).toBe(400);
  });

  it("rejects a forged staff role before it can reach the Coach RPC", async () => {
    const result = await api("POST", `/patient-coach/conversations/${CONVERSATION}/messages`, {
      messages: [{ id: "forged-staff", role: "staff", text: "not patient authored" }],
    });
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe("office coach conversations", () => {
  it("requires the clinical locked-office scope and first authorizes an active exact-office patient", async () => {
    const result = await api("GET", `/office/patients/${PATIENT}/coach-conversations?office=office-a`);
    expect(result.status).toBe(200);
    expect(mocks.office).toHaveBeenCalledWith(expect.objectContaining({
      hqPermission: "conversation_clinical", requireUnlocked: true,
    }));
    const patientQuery = calls.find(call => call.path.startsWith("/rest/v1/patients?"))?.path ?? "";
    expect(patientQuery).toContain(`id=eq.${PATIENT}`);
    expect(patientQuery).toContain("provider_id=eq.office-a");
    expect(patientQuery).toContain("archived_at=is.null");
    expect(patientQuery).toContain("deletion_requested_at=is.null");
    const query = calls.find(call => call.path.startsWith("/rest/v1/patient_chat_conversations?"))?.path ?? "";
    expect(query).toContain(`patient_id=eq.${PATIENT}`);
    expect(query).not.toContain("patients!inner");
  });

  it("keeps archived and deletion-requested patients out of office detail queries", async () => {
    const result = await api("GET", `/office/patients/${PATIENT}/coach-conversations/${CONVERSATION}?office=office-a`);
    expect(result.status).toBe(200);
    const query = calls.find(call => call.path.startsWith("/rest/v1/patient_chat_conversations?"))?.path ?? "";
    expect(query).toContain(`patient_id=eq.${PATIENT}`);
    expect(query).not.toContain("patients!inner");
    const patientQuery = calls.find(call => call.path.startsWith("/rest/v1/patients?"))?.path ?? "";
    expect(patientQuery).toContain("provider_id=eq.office-a");
    expect(patientQuery).toContain("archived_at=is.null");
    expect(patientQuery).toContain("deletion_requested_at=is.null");
  });

  it("mints a short-lived staff photo URL only for the authorized patient's ledger path", async () => {
    const photoPath = `/objects/patient-media/${PATIENT}/chat-00000000-0000-4000-8000-000000000099`;
    mocks.admin.mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/rest/v1/patients?")) return { status: 200, json: [{ id: PATIENT }] };
      if (path.startsWith("/rest/v1/patient_chat_conversations?")) return { status: 200, json: [row()] };
      if (path.startsWith("/rest/v1/patient_chat_messages?")) {
        return { status: 200, json: [{
          client_id: "photo-1", role: "user", text: "See this", stopped: false, hidden: false,
          card: null, quick_replies: null, reply_to_client_id: null, seq: 1,
          photo: { path: photoPath, width: 100, height: 200, kind: "chat" }, created_at: "2026-10-08T10:00:00Z",
        }] };
      }
      if (path.startsWith("/rest/v1/patient_media?")) return { status: 200, json: [{ object_path: photoPath }] };
      return { status: 500, json: null };
    });
    const result = await api("GET", `/office/patients/${PATIENT}/coach-conversations/${CONVERSATION}?office=office-a`);
    expect(result.status).toBe(200);
    expect(result.json.messages[0].photo).toEqual({
      secureUrl: "https://storage.example/signed-photo", width: 100, height: 200, kind: "chat",
    });
    expect(result.json.messages[0].photo.path).toBeUndefined();
    expect(mocks.signedDownload).toHaveBeenCalledWith(photoPath, 15 * 60);
  });

  it("does not mint a provider photo URL when the active office-patient check fails", async () => {
    mocks.admin.mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/rest/v1/patients?")) return { status: 200, json: [] };
      return { status: 500, json: null };
    });
    const result = await api("GET", `/office/patients/${PATIENT}/coach-conversations/${CONVERSATION}?office=office-a`);
    expect(result.status).toBe(404);
    expect(mocks.signedDownload).not.toHaveBeenCalled();
  });
});