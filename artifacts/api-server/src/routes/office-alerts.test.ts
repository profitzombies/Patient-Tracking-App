import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  items: [] as Row[], seen: [] as Row[], digests: [] as Row[], preferences: [] as Row[],
  version: 1, mode: "all", selected: [] as string[], sendTime: "08:00", zone: null as string | null,
  flags: [] as Row[], audits: [] as Row[],
}));
vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: vi.fn(async (input: Row) => {
    const token = String(input.authorization ?? "").replace("Bearer ", "");
    if (token === "patient") return { kind: "denied", status: 403, message: "Office staff only." };
    if (token === "hq" && !input.explicitOfficeId) return { kind: "denied", status: 400, message: "Choose an office." };
    if (!["owner", "staff", "hq"].includes(token)) return { kind: "denied", status: 401, message: "Unauthorized." };
    return { kind: "ok", scope: { providerId: "office-1", officeName: "Office", providerName: "Owner", actorUserId: `${token}-user`, actorKind: token === "hq" ? "hq" : token === "owner" ? "provider" : "team_member", officeRole: token === "staff" ? "staff" : "owner", teamMemberId: token === "staff" ? "member-1" : null } };
  }),
}));
vi.mock("../lib/office-attention", () => ({ loadOfficeAttention: vi.fn(async () => ({ asOf: "2026-10-11", items: state.items })) }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: vi.fn(async (input: Row) => { state.audits.push(input); }) }));
vi.mock("../lib/org-policy", async (original) => {
  const actual = await original<typeof import("../lib/org-policy")>();
  const current = (providerId: string) => ({ ...actual.NO_OVERRIDES(providerId), version: state.version, alertRecipientMode: state.mode, alertRecipientMemberIds: state.selected, alertSendTime: state.sendTime, alertTimeZone: state.zone });
  return { ...actual, loadOfficeOverrides: vi.fn(async () => current("office-1")), loadOrgPolicy: vi.fn(async () => actual.DEFAULT_ORG_POLICY), overridesFromRow: vi.fn((row: Row) => current(String(row.provider_id))) };
});
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://fake${path}`); const name = url.pathname.split("/").pop();
    if (name === "office_attention_seen") {
      if (method === "GET") return { status: 200, json: state.seen };
      const row = (body as Row[])[0]!; state.seen = state.seen.filter((old) => old.patient_id !== row.patient_id); state.seen.push(row); return { status: 201, json: [] };
    }
    if (name === "patients") return { status: 200, json: [{ id: "patient-1", name: "Pat Example", first_name: "Pat", last_name: "Example" }] };
    if (name === "coach_chat_flags") {
      if (method === "GET") {
        const onlyOpen = url.searchParams.get("status") === "eq.open";
        const id = url.searchParams.get("id")?.replace("eq.", "");
        return { status: 200, json: state.flags.filter((row) => (!onlyOpen || row.status === "open") && (!id || row.id === id)) };
      }
      const id = url.searchParams.get("id")?.replace("eq.", "");
      const target = state.flags.find((row) => row.id === id && row.status === "open");
      if (!target) return { status: 200, json: [] };
      Object.assign(target, body as Row); return { status: 200, json: [target] };
    }
    if (name === "office_attention_digests") return { status: 200, json: state.digests };
    if (name === "providers") return { status: 200, json: [{ provider_name: "Owner", email: "owner@example.com", auth_user_id: "owner-user" }] };
    if (name === "team_members") return { status: 200, json: [{ id: "member-1", name: "Staff", email: "staff@example.com", office_role: "staff", activation_status: "active", auth_user_id: "staff-user" }] };
    if (name === "staff_alert_preferences") {
      if (method === "GET") return { status: 200, json: state.preferences };
      state.preferences = body as Row[]; return { status: 201, json: body };
    }
    if (name === "provider_policy_overrides") {
      state.version += 1; const row = body as Row; state.mode = row.alert_recipient_mode as typeof state.mode; state.sendTime = String(row.alert_send_time); state.zone = row.alert_time_zone as string | null;
      return { status: 200, json: [{ ...row, version: state.version }] };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }),
}));
import router from "./office-alerts";

let server: http.Server; let base = "";
async function call(method: string, path: string, token = "owner", body?: unknown) {
  const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Row };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(router); server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
beforeEach(() => {
  state.items = [{ patientId: "patient-1", name: "Pat", reasons: [{ code: "no_meals", label: "No meals logged", days: 3 }], signature: "no_meals" }];
  state.seen = []; state.digests = [{ digest_date: "2026-10-11", generated_at: "2026-10-11T12:00:00Z", time_zone: "UTC", flagged_count: 1, items: state.items }, { digest_date: "2026-10-10", generated_at: "2026-10-10T12:00:00Z", time_zone: "UTC", flagged_count: 0, items: [] }];
  state.preferences = []; state.version = 1; state.mode = "all"; state.sendTime = "08:00"; state.zone = null;
  state.audits = [];
  state.flags = [
    { id: "flag-1", patient_id: "patient-1", conversation_id: "conv-1", category: "self_harm", reason: "Expressed a wish to not wake up.", message_excerpt: "I wish I wouldn't wake up", status: "open", created_at: "2026-10-11T03:30:00Z", reviewed_at: null, reviewed_by_name: null },
    { id: "flag-0", patient_id: "patient-1", conversation_id: null, category: "pregnancy", reason: "Reports a positive test.", message_excerpt: "I'm pregnant", status: "reviewed", created_at: "2026-10-09T10:00:00Z", reviewed_at: "2026-10-09T11:00:00Z", reviewed_by_name: "Owner" },
  ];
});
describe("coach chat flag routes", () => {
  it("lists open flags with the patient's name and a readable category, and counts the open ones", async () => {
    const response = await call("GET", "/office/alerts/chat-flags");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ openCount: 1, items: [{
      id: "flag-1", patientId: "patient-1", patientName: "Pat Example", conversationId: "conv-1", category: "self_harm", categoryLabel: "Thoughts of self-harm",
      reason: "Expressed a wish to not wake up.", messageExcerpt: "I wish I wouldn't wake up", status: "open", createdAt: "2026-10-11T03:30:00Z", reviewedAt: null, reviewedByName: null,
    }] });
    const all = await call("GET", "/office/alerts/chat-flags?status=all");
    expect((all.json.items as Row[]).map((row) => row.id)).toEqual(["flag-1", "flag-0"]);
    expect(all.json.openCount).toBe(1);
  });
  it("lets HQ drill-in read flags but not review them", async () => {
    expect((await call("GET", "/office/alerts/chat-flags?office=office-1", "hq")).status).toBe(200);
    const denied = await call("POST", "/office/alerts/chat-flags/flag-1/reviewed?office=office-1", "hq");
    expect(denied.status).toBe(403);
    expect(state.flags[0]!.status).toBe("open");
  });
  it("marks a flag reviewed by a teammate with their name and writes an id-only audit event", async () => {
    const response = await call("POST", "/office/alerts/chat-flags/flag-1/reviewed", "staff");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ id: "flag-1", status: "reviewed", reviewedByName: "Staff" });
    expect(typeof response.json.reviewedAt).toBe("string");
    expect(state.flags[0]).toMatchObject({ status: "reviewed", reviewed_by: "staff-user", reviewed_by_name: "Staff" });
    expect(state.audits).toEqual([expect.objectContaining({ action: "coach_chat_flag_reviewed", targetKind: "patient", targetId: "patient-1", metadata: { flagId: "flag-1", category: "self_harm" } })]);
    expect(JSON.stringify(state.audits)).not.toContain("wake up");
    // Reviewing again is idempotent: no second audit row.
    expect((await call("POST", "/office/alerts/chat-flags/flag-1/reviewed", "owner")).json).toMatchObject({ status: "reviewed", reviewedByName: "Staff" });
    expect(state.audits).toHaveLength(1);
  });
  it("uses the owner's name when the account holder reviews and 404s for an unknown flag", async () => {
    expect((await call("POST", "/office/alerts/chat-flags/flag-1/reviewed", "owner")).json).toMatchObject({ reviewedByName: "Owner" });
    expect((await call("POST", "/office/alerts/chat-flags/missing/reviewed", "owner")).status).toBe(404);
    expect((await call("GET", "/office/alerts/chat-flags", "patient")).status).toBe(403);
  });
});
describe("office alerts routes", () => {
  it("lists alerts and counts unseen signatures", async () => {
    state.seen = [{ patient_id: "patient-1", signature: "old_reason" }];
    const response = await call("GET", "/office/alerts"); expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ count: 1, total: 1, items: [{ seen: false }] });
  });
  it("marks the current signature seen and a changed signature resurfaces", async () => {
    expect((await call("POST", "/office/alerts/patient-1/seen", "owner", { signature: "no_meals" })).json.count).toBe(0);
    state.items[0]!.signature = "no_water"; const response = await call("GET", "/office/alerts");
    expect(response.json).toMatchObject({ count: 1, items: [{ seen: false }] });
  });
  it("keeps HQ drill-in read-only for seen state", async () => {
    const response = await call("POST", "/office/alerts/patient-1/seen?office=office-1", "hq", { signature: "no_meals" });
    expect(response.status).toBe(403);
    expect(state.seen).toEqual([]);
  });
  it("browses digests by date", async () => {
    const response = await call("GET", "/office/alerts/digests?date=2026-10-10");
    expect(response.json).toMatchObject({ dates: ["2026-10-11", "2026-10-10"], digest: { digestDate: "2026-10-10" }, latestDate: "2026-10-11" });
  });
  it("reads and updates settings with permissions and version conflicts", async () => {
    expect((await call("GET", "/office/alerts/settings")).json).toMatchObject({ recipientMode: "all", version: 1, canEdit: true });
    expect((await call("PUT", "/office/alerts/settings", "staff", { expectedVersion: 1, recipientMode: "all", recipientMemberIds: [], sendTime: "09:00", timeZone: null })).status).toBe(403);
    expect((await call("PUT", "/office/alerts/settings", "owner", { expectedVersion: 0, recipientMode: "all", recipientMemberIds: [], sendTime: "09:00", timeZone: null })).status).toBe(409);
    expect((await call("PUT", "/office/alerts/settings", "owner", { expectedVersion: 1, recipientMode: "owners_admins", recipientMemberIds: [], sendTime: "09:00", timeZone: "UTC" })).status).toBe(200);
    expect((await call("GET", "/office/alerts/settings", "hq")).status).toBe(400);
    expect((await call("GET", "/office/alerts/settings?office=office-1", "hq")).status).toBe(200);
  });
  it("saves personal preferences but rejects HQ", async () => {
    expect((await call("PUT", "/office/alerts/preferences", "staff", { emailEnabled: false, pushEnabled: true })).json).toEqual({ emailEnabled: false, pushEnabled: true });
    expect((await call("PUT", "/office/alerts/preferences?office=office-1", "hq", { emailEnabled: false, pushEnabled: false })).status).toBe(403);
  });
});