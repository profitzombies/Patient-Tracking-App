/**
 * Patient-facing push routes over HTTP against the in-memory store: token
 * lifecycle (register, replace, account switch, sign-out), status, open
 * tracking, and the authenticated internal scheduler trigger.
 */
import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolvePatient: vi.fn(), tick: vi.fn() }));
vi.mock("../lib/patient-auth", () => ({ resolvePatient: mocks.resolvePatient }));
vi.mock("../notifications/worker", () => ({ runScheduledTick: mocks.tick }));

import { MemoryNotificationStore } from "../notifications/memory-store";
import { createPatientNotificationsRouter } from "./patient-notifications";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const DEVICE = "install-0001-abcdef";

let server: http.Server;
let base = "";
let store: MemoryNotificationStore;

beforeAll(async () => {
  store = new MemoryNotificationStore();
  const app = express();
  app.use(express.json());
  app.use(createPatientNotificationsRouter(store));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  store.reset();
  store.addPatient({ patientId: P1, providerId: "prov-1" });
  store.addPatient({ patientId: P2, providerId: "prov-1" });
  mocks.resolvePatient.mockReset().mockResolvedValue({ ok: true, patientId: P1, authUserId: "u1" });
  mocks.tick.mockReset().mockResolvedValue({ outbox: { claimed: 0 }, outreach: null });
  delete process.env.NOTIFICATIONS_INTERNAL_TOKEN;
});

async function call(path: string, method = "GET", body?: unknown, token: string | null = "patient-jwt") {
  return fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const activeTokens = (patientId: string) => [...store.tokens.values()].filter((t) => t.patient_id === patientId && !t.disabled_at);

describe("device registration", () => {
  it("rejects unauthenticated and malformed registrations", async () => {
    mocks.resolvePatient.mockResolvedValueOnce({ ok: false, status: 401, error: "Sign in first." });
    expect((await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "ios" })).status).toBe(401);
    expect((await call("/patient-notifications/device", "PUT", { token: "abc", deviceId: DEVICE, platform: "ios" })).status).toBe(400);
    expect((await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: "short", platform: "ios" })).status).toBe(400);
    expect((await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "web" })).status).toBe(400);
    expect(store.tokens.size).toBe(0);
  });

  it("registers idempotently and replaces an older token on the same device", async () => {
    let res = await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "ios" });
    expect(res.status).toBe(200);
    const first = await res.json() as { ok: boolean; retired: number; tokenId: string };
    expect(first).toMatchObject({ ok: true, retired: 0 });
    // Same token again on app start: same row refreshed, nothing retired.
    res = await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "ios" });
    expect((await res.json() as { tokenId: string }).tokenId).toBe(first.tokenId);
    expect(activeTokens(P1)).toHaveLength(1);
    // Token rotation on the same install retires the old one.
    res = await call("/patient-notifications/device", "PUT", { token: TOKEN_B, deviceId: DEVICE, platform: "ios" });
    expect((await res.json() as { retired: number }).retired).toBe(1);
    expect(activeTokens(P1).map((t) => t.token)).toEqual([TOKEN_B]);
    expect(store.tokens.get(first.tokenId)).toMatchObject({ disabled_reason: "replaced" });

    const status = await (await call(`/patient-notifications/status?deviceId=${DEVICE}`)).json();
    expect(status).toEqual({ activeDevices: 1, thisDevice: true });
    expect(await (await call("/patient-notifications/status?deviceId=other-device-99")).json()).toEqual({ activeDevices: 1, thisDevice: false });
  });

  it("an account switch on one phone retires the previous account's registration", async () => {
    await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "android" });
    mocks.resolvePatient.mockResolvedValue({ ok: true, patientId: P2, authUserId: "u2" });
    const res = await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "android" });
    expect((await res.json() as { retired: number }).retired).toBe(1);
    expect(activeTokens(P1)).toHaveLength(0);
    expect(activeTokens(P2)).toHaveLength(1);
    expect([...store.tokens.values()].find((t) => t.patient_id === P1)).toMatchObject({ disabled_reason: "account_switch" });
  });

  it("sign-out retires this device only; without a device id it retires every device", async () => {
    await call("/patient-notifications/device", "PUT", { token: TOKEN_A, deviceId: DEVICE, platform: "ios" });
    await call("/patient-notifications/device", "PUT", { token: TOKEN_B, deviceId: "tablet-install-0002", platform: "ios" });
    let res = await call("/patient-notifications/device", "DELETE", { deviceId: DEVICE, reason: "signed_out" });
    expect(await res.json()).toEqual({ ok: true, retired: 1 });
    expect(activeTokens(P1).map((t) => t.device_id)).toEqual(["tablet-install-0002"]);
    res = await call("/patient-notifications/device", "DELETE", {});
    expect(await res.json()).toEqual({ ok: true, retired: 1 });
    expect(activeTokens(P1)).toHaveLength(0);
    expect([...store.tokens.values()].every((t) => t.disabled_reason === "signed_out")).toBe(true);
  });
});

describe("open tracking", () => {
  it("records the open once, only for the owner, and never for unknown ids", async () => {
    const { row } = await store.enqueue({ patientId: P1, kind: "coach_outreach", category: "coach_outreach", title: "t", body: "b", data: {} });
    await store.updateNotification(row.id, { status: "sent", sent_at: "2026-07-01T16:00:00.000Z" });
    expect((await call("/patient-notifications/not-a-uuid/opened", "POST", {})).status).toBe(404);
    expect((await call(`/patient-notifications/${P2}/opened`, "POST", {})).status).toBe(404);

    mocks.resolvePatient.mockResolvedValueOnce({ ok: true, patientId: P2, authUserId: "u2" });
    expect((await call(`/patient-notifications/${row.id}/opened`, "POST", {})).status).toBe(404);
    expect(store.notifications.get(row.id)!.status).toBe("sent");

    let res = await call(`/patient-notifications/${row.id}/opened`, "POST", {});
    expect(res.status).toBe(200);
    const first = await res.json() as { status: string; openedAt: string };
    expect(first.status).toBe("opened");
    const after = store.notifications.get(row.id)!;
    expect(after).toMatchObject({ status: "opened", opened_at: first.openedAt, delivered_at: first.openedAt });
    expect(after.finalized_at).not.toBeNull();

    res = await call(`/patient-notifications/${row.id}/opened`, "POST", {});
    expect(await res.json()).toEqual({ ok: true, status: "opened", openedAt: first.openedAt });
  });
});

describe("internal tick trigger", () => {
  it("is invisible until a token is configured, then requires the exact bearer", async () => {
    expect((await call("/internal/notifications/tick", "POST", {}, "anything")).status).toBe(404);
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "scheduler-secret";
    expect((await call("/internal/notifications/tick", "POST", {}, null)).status).toBe(401);
    expect((await call("/internal/notifications/tick", "POST", {}, "scheduler-secre")).status).toBe(401);
    expect((await call("/internal/notifications/tick", "POST", {}, "scheduler-secret-1")).status).toBe(401);
    expect(mocks.tick).not.toHaveBeenCalled();
    const res = await call("/internal/notifications/tick", "POST", { outreach: true }, "scheduler-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outbox: { claimed: 0 }, outreach: null });
    expect(mocks.tick).toHaveBeenCalledWith(expect.objectContaining({ outreach: true, store }));
  });

  it("answers 500 without leaking when the tick throws", async () => {
    process.env.NOTIFICATIONS_INTERNAL_TOKEN = "scheduler-secret";
    mocks.tick.mockRejectedValueOnce(new Error("db down"));
    const res = await call("/internal/notifications/tick", "POST", {}, "scheduler-secret");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Tick failed." });
  });
});
