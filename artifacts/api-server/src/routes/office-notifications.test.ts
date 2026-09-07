/**
 * Staff notification timeline: office scope, identical 404 for unknown and
 * foreign patients, event derivation from outbox rows + attempts, and the
 * roster chip state mapping.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), scope: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin, fetchAuthUser: vi.fn() }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));

import { MemoryNotificationStore } from "../notifications/memory-store";
import { outreachRosterDto, type OutreachStateRpcRow } from "../notifications/timeline";
import { createOfficeNotificationsRouter } from "./office-notifications";

const P1 = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "22222222-2222-4222-8222-222222222222";
let server: http.Server;
let base = "";
let clock = new Date("2026-07-01T16:00:00Z");
const store = new MemoryNotificationStore(() => clock);
let outreachRows: Partial<OutreachStateRpcRow>[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(createOfficeNotificationsRouter(store));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  store.reset();
  store.addPatient({ patientId: P1, providerId: "p1" });
  outreachRows = [];
  mocks.scope.mockReset().mockResolvedValue({ kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "staff", actorKind: "provider" } });
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string) => {
    if (path.startsWith("/rest/v1/patients?")) {
      const params = new URLSearchParams(path.split("?")[1]);
      const id = params.get("id")!.replace("eq.", "");
      const provider = params.get("provider_id")!.replace("eq.", "");
      return { status: 200, json: id === P1 && provider === "p1" ? [{ id: P1 }] : [], contentRange: null };
    }
    if (method === "POST" && path === "/rest/v1/rpc/provider_outreach_states") return { status: 200, json: outreachRows, contentRange: null };
    throw new Error(`unexpected ${method} ${path}`);
  });
});
const get = (path: string) => fetch(base + path, { headers: { authorization: "Bearer staff" } });

describe("GET /office/patients/:id/notifications", () => {
  it("enforces office scope and answers unknown and foreign ids identically", async () => {
    mocks.scope.mockResolvedValueOnce({ kind: "error", status: 403, message: "Not your office." });
    expect((await get(`/office/patients/${P1}/notifications`)).status).toBe(403);
    const foreign = await get(`/office/patients/${FOREIGN}/notifications`);
    const unknown = await get(`/office/patients/00000000-0000-4000-8000-000000000000/notifications`);
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    // No outbox reads happened for the miss.
    expect(mocks.admin.mock.calls.filter(([, path]) => path.includes("provider_outreach_states"))).toHaveLength(0);
  });

  it("derives a chronological event timeline per notification", async () => {
    const { row } = await store.enqueue({ patientId: P1, kind: "coach_outreach", category: "coach_outreach", title: "A note from your coach", body: "Body", data: {} });
    clock = new Date("2026-07-01T16:00:30Z");
    await store.insertAttempts([
      { notification_id: row.id, patient_id: P1, attempt: 1, token_id: null, ticket_id: null, outcome: "request_failed", error_code: "HTTP_503", error_message: "Expo push outage" },
    ]);
    clock = new Date("2026-07-01T16:01:30Z");
    await store.insertAttempts([
      { notification_id: row.id, patient_id: P1, attempt: 2, token_id: null, ticket_id: "tk-1", outcome: "ticket_ok", error_code: null, error_message: null },
    ]);
    clock = new Date("2026-07-02T02:00:00Z");
    await store.updateNotification(row.id, {
      status: "opened", attempts: 2, sent_at: "2026-07-01T16:01:30.000Z", delivered_at: "2026-07-01T16:20:00.000Z",
      opened_at: "2026-07-01T17:00:00.000Z", engaged_at: "2026-07-01T17:05:00.000Z", finalized_at: "2026-07-01T17:00:00.000Z",
    });
    const { row: quiet } = await store.enqueue({ patientId: P1, kind: "check_in_reminder", category: "check_in_reminders", title: "Check-in", body: "Time to weigh in", data: {}, dedupeKey: "q" });
    await store.updateNotification(quiet.id, { status: "suppressed", suppression_reason: "quiet_hours", finalized_at: "2026-07-02T03:00:00.000Z" });
    const { row: off } = await store.enqueue({ patientId: P1, kind: "office_reminder", category: "office_reminders", title: "Office", body: "Appointment", data: {}, dedupeKey: "o" });
    await store.updateNotification(off.id, { status: "opted_out", suppression_reason: "category_off", finalized_at: "2026-07-02T04:00:00.000Z" });

    const res = await get(`/office/patients/${P1}/notifications`);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await res.json() as any;
    expect(body.patientId).toBe(P1);
    expect(body.outreach.state).toBe("none");
    expect(body.notifications.map((n: { id: string }) => n.id)).toEqual([off.id, quiet.id, row.id]);

    const outreach = body.notifications[2];
    expect(outreach).toMatchObject({ status: "opened", attempts: 2, nextAttemptAt: null, lastError: null });
    expect(outreach.events.map((e: { kind: string }) => e.kind)).toEqual(["queued", "attempt_failed", "sent", "delivered", "opened", "engaged"]);
    expect(outreach.events[1].detail).toBe("HTTP_503: Expo push outage");
    expect(body.notifications[1].events.map((e: { kind: string; detail: string | null }) => [e.kind, e.detail])).toEqual([
      ["queued", null],
      ["suppressed", "Quiet hours covered the whole send window"],
    ]);
    expect(body.notifications[0].events.at(-1)).toMatchObject({ kind: "opted_out", detail: "Patient turned this category off" });
  });

  it("exposes the roster chip state alongside the timeline", async () => {
    outreachRows = [{ patient_id: P1, eligible: true, crossed_on_key: "2026-06-20", nudge_last_crossing_key: "2026-06-20", nudge_engaged: false, nudge_opt_out: false, notification_id: "n1", notification_status: "sent", evaluated_at: "2026-07-01T00:00:00Z", nudge_last_sent_key: "2026-06-21" }];
    const body = await (await get(`/office/patients/${P1}/notifications`)).json() as { outreach: unknown };
    expect(body.outreach).toMatchObject({ state: "sent_awaiting", delivery: "sent", crossedOnKey: "2026-06-20", lastSentKey: "2026-06-21", notificationId: "n1" });
  });
});

describe("outreachRosterDto", () => {
  const row = (overrides: Partial<OutreachStateRpcRow>): OutreachStateRpcRow => ({
    patient_id: P1, eligible: true, crossed_on_key: "2026-06-20", evaluated_at: "2026-07-01T00:00:00Z", decision: "send",
    nudge_opt_out: false, nudge_engaged: false, nudge_last_sent_key: "2026-06-21", nudge_last_crossing_key: "2026-06-20",
    notification_id: "n1", notification_status: "delivered", notification_updated_at: "2026-06-21T00:00:00Z", notification_suppression_reason: null, ...overrides,
  });
  it("maps every chip state", () => {
    expect(outreachRosterDto(undefined).state).toBe("none");
    expect(outreachRosterDto(row({ eligible: false })).state).toBe("none");
    expect(outreachRosterDto(row({ nudge_last_crossing_key: null, notification_id: null, notification_status: null })).state).toBe("eligible");
    // Cooldown: eligible but the stamped crossing is an older episode.
    expect(outreachRosterDto(row({ nudge_last_crossing_key: "2026-05-01" }))).toMatchObject({ state: "eligible", delivery: null });
    expect(outreachRosterDto(row({}))).toMatchObject({ state: "sent_awaiting", delivery: "delivered" });
    expect(outreachRosterDto(row({ nudge_engaged: true })).state).toBe("engaged");
    expect(outreachRosterDto(row({ nudge_opt_out: true })).state).toBe("opted_out");
    expect(outreachRosterDto(row({ nudge_opt_out: true, eligible: false })).state).toBe("none");
    expect(outreachRosterDto(row({ notification_status: "suppressed", notification_suppression_reason: "no_device" }))).toMatchObject({
      state: "sent_awaiting", delivery: "suppressed", deliveryDetail: "No registered device",
    });
  });
});
