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
describe("HQ audit name resolution", () => {
  it("adds actor, office, and target names from the lookup tables and keeps raw ids for HQ", async () => {
    mocks.admin.mockReset().mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/rest/v1/admin_audit_events")) {
        return { status: 200, contentRange: "0-2/3", json: [
          { id: 1, occurred_at: "2026-01-02T10:00:00Z", action: "office_team_deactivated", actor_user_id: "u-provider", actor_kind: "provider", provider_id: "p1", target_kind: "team_member", target_id: "tm-1", request_id: "r1", metadata: { role: "staff", status: "disabled" } },
          { id: 2, occurred_at: "2026-01-02T11:00:00Z", action: "knowledge_document_deleted", actor_user_id: "u-hq", actor_kind: "hq", provider_id: null, target_kind: "knowledge_document", target_id: "kd-1", request_id: null, metadata: { size: 1024, contentType: "application/pdf", body: "leak" } },
          { id: 3, occurred_at: "2026-01-02T12:00:00Z", action: "access_denied", actor_user_id: "u-gone", actor_kind: "team_member", provider_id: "p1", target_kind: "route", target_id: "GET /office/team", request_id: null, metadata: { reason: "permission", route: "/office/team", method: "GET", status: 403 } },
        ] };
      }
      if (path.startsWith("/rest/v1/hq_memberships")) return { status: 200, json: [{ auth_user_id: "u-hq", display_name: "Avery HQ" }] };
      if (path.startsWith("/rest/v1/providers?auth_user_id")) return { status: 200, json: [{ auth_user_id: "u-provider", provider_name: "Dr. Reyes" }] };
      if (path.startsWith("/rest/v1/team_members?auth_user_id")) return { status: 200, json: [] };
      if (path.startsWith("/rest/v1/providers?provider_id")) return { status: 200, json: [{ provider_id: "p1", provider_name: "Dr. Reyes", office_name: "Harbor Med Spa" }] };
      if (path.startsWith("/rest/v1/team_members?id")) return { status: 200, json: [{ id: "tm-1", name: "Sam Front Desk" }] };
      if (path.startsWith("/rest/v1/knowledge_documents?id")) return { status: 200, json: [{ id: "kd-1", title: "Program FAQ" }] };
      throw new Error(`unexpected lookup ${path}`);
    });
    const res = await fetch(`${base}/hq/audit-events`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<Record<string, unknown>> };
    expect(body.events.map((e) => [e.actorName, e.officeName, e.targetName])).toEqual([
      ["Dr. Reyes", "Harbor Med Spa", "Teammate: Sam Front Desk"],
      ["Avery HQ", null, "Knowledge document: Program FAQ"],
      // Unresolvable actors fall back to a kind label; routes are shown as-is.
      ["Office teammate", "Harbor Med Spa", "Protected route: GET /office/team"],
    ]);
    // HQ keeps the raw ids alongside the names, and the allowlist still strips stray keys.
    expect(body.events[0]).toMatchObject({ actorUserId: "u-provider", providerId: "p1", targetId: "tm-1" });
    expect(body.events[1].metadata).toEqual({ size: 1024, contentType: "application/pdf" });
    expect(body.events[2].metadata).toEqual({ reason: "permission", route: "/office/team", method: "GET", status: 403 });
  });

  it("still answers the page when a name lookup fails", async () => {
    mocks.admin.mockReset().mockImplementation(async (_method: string, path: string) => {
      if (path.startsWith("/rest/v1/admin_audit_events")) {
        return { status: 200, contentRange: "0-0/1", json: [
          { id: 1, occurred_at: "2026-01-02T10:00:00Z", action: "patient_note_added", actor_user_id: "u-x", actor_kind: "team_member", provider_id: "p1", target_kind: "patient", target_id: "pt-1", request_id: null, metadata: { noteId: "n-1" } },
        ] };
      }
      return { status: 500, json: null };
    });
    const res = await fetch(`${base}/hq/audit-events`, { headers: { authorization: "Bearer admin" } });
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<Record<string, unknown>> };
    expect(body.events[0]).toMatchObject({ actorName: "Office teammate", officeName: null, targetName: "Patient" });
  });
});
