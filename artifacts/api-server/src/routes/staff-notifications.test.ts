import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../auth/office-scope", () => ({
  resolveOfficeScope: vi.fn(async ({ authorization }: { authorization?: string }) => {
    const token = String(authorization ?? "").replace("Bearer ", "");
    if (token === "patient") return { kind: "denied", status: 403, message: "Office staff only." };
    if (!["owner", "member", "hq"].includes(token)) return { kind: "denied", status: 401, message: "Unauthorized." };
    return { kind: "ok", scope: { providerId: "office-1", actorUserId: `${token}-user`, actorKind: token === "hq" ? "hq" : token === "owner" ? "provider" : "team_member" } };
  }),
}));
import { MemoryStaffNotificationStore } from "../alerts/memory-store";
import { createStaffNotificationsRouter } from "./staff-notifications";
const store = new MemoryStaffNotificationStore();
let server: http.Server; let base = "";
async function call(method: string, token: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/staff-notifications/device`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(createStaffNotificationsRouter(store)); server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
describe("staff notification devices", () => {
  it.each(["owner", "member"])("registers and unregisters a %s device", async (token) => {
    const deviceId = `${token}-device-123`;
    const registered = await call("PUT", token, { token: `ExponentPushToken[${token}]`, deviceId, platform: "ios" });
    expect(registered.status).toBe(200); expect(registered.json.ok).toBe(true);
    const removed = await call("DELETE", token, { deviceId, reason: "signed_out" });
    expect(removed.status).toBe(200); expect(removed.json.retired).toBe(1);
  });
  it.each(["hq", "patient"])("rejects a %s bearer", async (token) => {
    expect((await call("PUT", token, { token: "ExponentPushToken[staff]", deviceId: "device-123", platform: "ios" })).status).toBe(403);
  });
  it("rejects an invalid Expo token", async () => {
    expect((await call("PUT", "owner", { token: "not-expo", deviceId: "device-123", platform: "ios" })).status).toBe(400);
  });
});