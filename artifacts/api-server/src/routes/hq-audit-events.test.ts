import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/staff-auth", () => ({
  requireHqPermission: () => (req: express.Request, res: express.Response, next: express.NextFunction) => req.headers.authorization === "Bearer lower" ? res.status(403).json({ error: "denied" }) : next(),
}));
import router from "./hq-audit-events";
let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
describe("HQ audit events", () => {
  it("requires audit permission", async () => {
    expect((await fetch(`${base}/hq/audit-events`, { headers: { authorization: "Bearer lower" } })).status).toBe(403);
  });
  it("filters, includes the to date, paginates/counts, and strips metadata", async () => {
    mocks.admin.mockReset().mockResolvedValue({ status: 200, contentRange: "0-1/2", json: [
      { id: 4, occurred_at: "2026-01-02T23:59:59Z", action: "provider_account_updated", actor_user_id: "a", actor_kind: "hq", provider_id: "p1", target_kind: "provider_account", target_id: "p1", request_id: "r", metadata: { reason: "logging_lapsed", token: "leak", clinical: { notes: "leak" } } },
      { id: 5, occurred_at: "2026-01-02T23:59:59Z", action: "future_unapproved_action", actor_kind: "system", metadata: {} },
    ] });
    const res = await fetch(`${base}/hq/audit-events?provider=p1&action=provider_account_updated&from=2026-01-01&to=2026-01-02&limit=1&offset=0`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(200);
    const [, path, , prefer] = mocks.admin.mock.calls[0];
    expect(path).toContain("provider_id=eq.p1"); expect(path).toContain("action=in.("); expect(path).toContain("action=eq.provider_account_updated"); expect(path).toContain(encodeURIComponent("2026-01-03T00:00:00.000Z")); expect(prefer).toBe("count=exact");
    const body = await res.json() as { total: number; events: Array<{ metadata: Record<string, unknown> }> };
    expect(body.total).toBe(2); expect(body.events).toHaveLength(1); expect(body.events[0].metadata).toEqual({ reason: "logging_lapsed" });
    expect((await fetch(`${base}/hq/audit-events?action=future_unapproved_action`, { headers: { authorization: "Bearer admin" } })).status).toBe(400);
  });
});