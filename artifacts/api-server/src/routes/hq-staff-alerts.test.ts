import express from "express";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: vi.fn(() => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === "Bearer hq-allowed") next();
    else res.status(403).json({ error: "Forbidden." });
  }),
}));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: vi.fn(async () => ({ status: 200, json: [
    { id: "new", provider_id: "office-1", channel: "push", email: null, status: "suppressed", suppression_reason: "no_device", last_error: null, scheduled_at: "2026-10-11T12:00:00Z", sent_at: null, finalized_at: "2026-10-11T12:00:01Z", data: { digestDate: "2026-10-11", flaggedCount: 2 }, providers: { provider_name: "Office One" } },
    { id: "old", provider_id: "office-2", channel: "email", email: "staff@example.com", status: "sent", suppression_reason: null, last_error: null, scheduled_at: "2026-10-10T12:00:00Z", sent_at: "2026-10-10T12:00:01Z", finalized_at: "2026-10-10T12:00:01Z", data: { digestDate: "2026-10-10", flaggedCount: 1 }, providers: { provider_name: "Office Two" } },
  ] })),
}));
import router from "./hq-staff-alerts";
let server: http.Server; let base = "";
beforeAll(async () => {
  const app = express(); app.use(router); server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
describe("HQ staff alert deliveries", () => {
  it("requires HQ permission", async () => {
    expect((await fetch(`${base}/hq/staff-alerts/deliveries`)).status).toBe(403);
  });
  it("returns newest first with suppression detail", async () => {
    const response = await fetch(`${base}/hq/staff-alerts/deliveries`, { headers: { Authorization: "Bearer hq-allowed" } });
    const body = await response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.map((item) => item.id)).toEqual(["new", "old"]);
    expect(body.items[0]).toMatchObject({ officeName: "Office One", suppressionReason: "no_device", suppressionDetail: "no_device", digestDate: "2026-10-11", flaggedCount: 2 });
  });
});