import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), audit: vi.fn(), scope: vi.fn() }));
const { admin, audit, scope } = mocks;
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
import router from "./office-operations";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
const okScope = { kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "a1", actorKind: "provider" } };
function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string, method = "GET", body?: unknown) { return fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }

describe("office operations", () => {
  it("validates trend range before any scope/RPC and returns RPC snake_case points", async () => {
    scope.mockReset(); admin.mockReset();
    expect((await call("/office/engagement-trends?start=2026-02-30&end=2026-03-01")).status).toBe(400);
    expect(scope).not.toHaveBeenCalled();
    scope.mockResolvedValue(okScope); admin.mockResolvedValue(response([{ date: "2026-01-01", active_patients: 0, engaged_patients: 0, meal_logs: 0, check_ins: 0 }]));
    const json = await (await call("/office/engagement-trends?start=2026-01-01&end=2026-01-01")).json() as { points: Array<Record<string, unknown>> };
    expect(json.points[0]).toMatchObject({ active_patients: 0, engaged_patients: 0 });
    expect(admin.mock.calls[0][1]).toBe("/rest/v1/rpc/provider_engagement_daily");
  });
  it("maps trend RPC failures to 502 and scopes provider read", async () => {
    scope.mockResolvedValue(okScope); admin.mockResolvedValue(response({}, 500));
    expect((await call("/office/engagement-trends?start=2026-01-01&end=2026-01-01")).status).toBe(502);
    expect(scope.mock.calls[scope.mock.calls.length - 1][0].hqPermission).toBe("provider_read");
  });
  it("gives a cross-office patient the neutral follow-up 404", async () => {
    scope.mockResolvedValue(okScope); admin.mockResolvedValue(response([]));
    const res = await call("/office/patients/other/follow-ups/logging_lapsed", "PUT", { status: "open" });
    expect(res.status).toBe(404); expect(await res.json()).toEqual({ error: "No patient record found for this office." });
  });
  it("persists an idempotent resolved row and audits it", async () => {
    scope.mockResolvedValue(okScope); admin.mockReset(); audit.mockReset().mockResolvedValue(undefined);
    admin.mockResolvedValueOnce(response([{ id: "patient" }])).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([{ reason: "logging_lapsed", status: "resolved", created_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-01T00:00:00Z" }]));
    const res = await call("/office/patients/patient/follow-ups/logging_lapsed", "PUT", { status: "resolved" });
    expect(res.status).toBe(200); expect(admin.mock.calls[3][0]).toBe("POST"); expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "patient_follow_up_resolved" }));
  });
});