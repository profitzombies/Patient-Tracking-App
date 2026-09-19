import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), audit: vi.fn(), scope: vi.fn(), staff: vi.fn(), signed: vi.fn(), drain: vi.fn(),
}));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin, fetchAuthUser: vi.fn() }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../lib/objectStorage", () => ({ objectStorage: { signedDownloadURL: mocks.signed } }));
vi.mock("../exports/worker", () => ({ drainQueuedExports: mocks.drain }));
vi.mock("../lib/staff-auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/staff-auth")>("../lib/staff-auth");
  return { ...actual, verifyStaffToken: (token: string) => Promise.resolve(mocks.staff(token)) };
});
/**
 * The fresh-code gate reads the session id claim of a real JWT and the
 * sign-in ledger; this suite's bearers are opaque fixtures, so the gate is
 * replaced by a switch (security.test.ts proves the real gate end to end).
 * `gate.fresh = false` makes every gated route answer 401 reauth_required.
 */
const gate = vi.hoisted(() => ({ fresh: true, calls: 0 }));
vi.mock("../auth/fresh-code", async () => {
  const actual = await vi.importActual<typeof import("../auth/fresh-code")>("../auth/fresh-code");
  return {
    ...actual,
    requireFreshCode: async (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) => {
      gate.calls += 1;
      if (gate.fresh) return true;
      res.status(401).json({ error: actual.REAUTH_REQUIRED_MESSAGE, code: actual.REAUTH_REQUIRED_CODE, windowMinutes: actual.FRESH_CODE_WINDOW_MINUTES });
      return false;
    },
  };
});
import router, { availableKinds, exportJobDto } from "./exports";
import { invalidateOrgPolicyCache } from "../lib/org-policy";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string, method = "GET", body?: unknown, token = "t") {
  return fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
}
const hq = (departmentRole: string) => ({ userId: "hq-user", role: "hq_admin", departmentRole });
const officeScope = { kind: "ok", scope: { providerId: "p1", officeName: "One", providerName: "Dr One", onboardingCode: null, actorUserId: "office-user", actorKind: "provider", officeRole: "owner", teamMemberId: null } };
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const jobRow = (overrides: Record<string, unknown> = {}) => ({
  id: JOB_ID, kind: "office_comparison", status: "ready", requested_by: "hq-user", requester_kind: "hq", requester_role: "admin",
  provider_id: null, params: { start: "2026-08-01", end: "2026-09-06" }, file_name: "thinnr_office-comparison_all-offices_2026-08-01_2026-09-06.csv",
  object_path: `/objects/exports/${JOB_ID}/export-22222222-2222-4222-8222-222222222222.csv`, size_bytes: 120, row_count: 1, error: null, attempts: 1,
  created_at: "2026-09-06T10:00:00Z", started_at: "2026-09-06T10:00:01Z", completed_at: "2026-09-06T10:00:02Z",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(), download_count: 0, last_downloaded_at: null, ...overrides,
});

/** Route the PostgREST calls the request handler makes by path prefix. */
function adminScript(handlers: { pending?: unknown[]; inserted?: Record<string, unknown>; job?: Record<string, unknown> | null; exportLinkHours?: number }) {
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: unknown) => {
    if (path.startsWith("/rest/v1/hq_organization_settings")) {
      if (handlers.exportLinkHours === undefined) throw new Error("policy unavailable");
      return response([{ export_link_hours: handlers.exportLinkHours, version: 1 }]);
    }
    if (path.startsWith("/rest/v1/data_exports?requested_by=") && path.includes("status=in.(queued,running)")) return response(handlers.pending ?? []);
    if (method === "POST" && path === "/rest/v1/data_exports") return response([{ ...jobRow({ status: "queued", object_path: null, completed_at: null }), ...(body as Record<string, unknown>), ...(handlers.inserted ?? {}) }], 201);
    if (method === "GET" && path.startsWith(`/rest/v1/data_exports?id=eq.${JOB_ID}`)) return response(handlers.job === null ? [] : [handlers.job ?? jobRow()]);
    if (method === "GET" && path.startsWith("/rest/v1/data_exports?requested_by=")) return response([handlers.job ?? jobRow()]);
    if (method === "PATCH") return response([]);
    throw new Error(`unexpected ${method} ${path}`);
  });
}

beforeEach(() => {
  gate.fresh = true;
  gate.calls = 0;
  invalidateOrgPolicyCache();
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.drain.mockReset().mockResolvedValue(0);
  mocks.scope.mockReset();
  mocks.staff.mockReset();
});

describe("requesting exports", () => {
  it("rejects anonymous callers before touching the database", async () => {
    mocks.admin.mockReset();
    expect((await call("/exports", "POST", { kind: "office_comparison", start: "2026-08-01", end: "2026-09-06" }, "")).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("validates kind and range before authorization", async () => {
    mocks.admin.mockReset();
    expect((await call("/exports", "POST", { kind: "nope" })).status).toBe(400);
    expect((await call("/exports", "POST", { kind: "audit_events", start: "2026-09-06", end: "2026-08-01" })).status).toBe(400);
    expect((await call("/exports", "POST", { kind: "audit_events" })).status).toBe(400);
    expect(mocks.staff).not.toHaveBeenCalled();
  });
  it("requires a fresh code for every export request, after authorization and before any job is written", async () => {
    mocks.staff.mockReturnValue(hq("clinical"));
    adminScript({});
    gate.fresh = false;
    const res = await call("/exports", "POST", { kind: "office_comparison", start: "2026-08-01", end: "2026-09-06" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "reauth_required", windowMinutes: 10 });
    expect(mocks.admin.mock.calls.some(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
    // A kind the caller may not request is refused before the gate is consulted.
    gate.calls = 0;
    mocks.staff.mockReturnValue(hq("content"));
    const denied = await call("/exports", "POST", { kind: "office_comparison", start: "2026-08-01", end: "2026-09-06" });
    expect(denied.status).toBe(403);
    expect(gate.calls).toBe(0);
  });

  it("queues a network-wide comparison for HQ analytics readers, audits it, and kicks the worker", async () => {
    mocks.staff.mockReturnValue(hq("clinical"));
    adminScript({});
    const res = await call("/exports", "POST", { kind: "office_comparison", start: "2026-08-01", end: "2026-09-06" });
    expect(res.status).toBe(202);
    const json = await res.json() as { job: { status: string; scope: { providerId: string | null }; range: { start: string } } };
    expect(json.job.status).toBe("queued");
    expect(json.job.scope.providerId).toBeNull();
    expect(json.job.range.start).toBe("2026-08-01");
    const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
    expect(insert[2]).toMatchObject({ kind: "office_comparison", requested_by: "hq-user", requester_kind: "hq", requester_role: "clinical", provider_id: null });
    expect(typeof (insert[2] as { expires_at: string }).expires_at).toBe("string");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "data_export_requested", actorKind: "hq", targetKind: "data_export", metadata: { kind: "office_comparison", office: "all" } }));
    expect(mocks.drain).toHaveBeenCalled();
  });
  it("keeps HQ patient-level rows behind provider_manage (aggregate-only otherwise)", async () => {
    mocks.staff.mockReturnValue(hq("clinical"));
    adminScript({});
    const res = await call("/exports", "POST", { kind: "patient_activity", office: "p1", start: "2026-08-01", end: "2026-09-06" });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toMatch(/aggregate/i);
    expect(mocks.admin.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
  it("requires HQ to name an office for patient activity and resolves it through the office scope", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    adminScript({});
    expect((await call("/exports", "POST", { kind: "patient_activity", start: "2026-08-01", end: "2026-09-06" })).status).toBe(400);
    mocks.scope.mockResolvedValue({ kind: "ok", scope: { ...officeScope.scope, actorUserId: "hq-user", actorKind: "hq" } });
    const res = await call("/exports", "POST", { kind: "patient_activity", office: "acct-p1", start: "2026-08-01", end: "2026-09-06" });
    expect(res.status).toBe(202);
    expect(mocks.scope.mock.calls[0][0]).toMatchObject({ explicitOfficeId: "acct-p1", hqPermission: "provider_manage" });
    const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
    expect(insert[2]).toMatchObject({ provider_id: "p1", params: { start: "2026-08-01", end: "2026-09-06", officeName: "One" } });
  });
  it("pins office staff to their own office even when they name another, and denies the directory", async () => {
    mocks.staff.mockReturnValue(null);
    mocks.scope.mockResolvedValue(officeScope);
    adminScript({});
    const res = await call("/exports", "POST", { kind: "patient_activity", office: "someone-else", start: "2026-08-01", end: "2026-09-06" });
    expect(res.status).toBe(202);
    const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
    expect(insert[2]).toMatchObject({ provider_id: "p1", requester_kind: "provider", requester_role: null, requested_by: "office-user" });
    expect(mocks.scope.mock.calls[0][0].explicitOfficeId).toBeNull();
    expect((await call("/exports", "POST", { kind: "provider_directory" })).status).toBe(403);
  });
  it("denies billing exports to office staff", async () => {
    mocks.staff.mockReturnValue(null);
    mocks.scope.mockResolvedValue({ ...officeScope, scope: { ...officeScope.scope, actorKind: "team_member", officeRole: "staff" } });
    adminScript({});
    const res = await call("/exports", "POST", {
      kind: "billing_transactions", start: "2026-08-01", end: "2026-09-06",
    });
    expect(res.status).toBe(403);
    expect(mocks.admin.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });
  it("denies support the comparison but allows the directory, and denies content everything but training", async () => {
    mocks.staff.mockReturnValue(hq("support"));
    adminScript({});
    expect((await call("/exports", "POST", { kind: "office_comparison", start: "2026-08-01", end: "2026-09-06" })).status).toBe(403);
    expect((await call("/exports", "POST", { kind: "provider_directory" })).status).toBe(202);
    mocks.staff.mockReturnValue(hq("content"));
    expect((await call("/exports", "POST", { kind: "audit_events", start: "2026-08-01", end: "2026-09-06" })).status).toBe(403);
    expect((await call("/exports", "POST", { kind: "training_completion", start: "2026-08-01", end: "2026-09-06" })).status).toBe(202);
  });
  it("keeps billing exports behind HQ financial_read", async () => {
    mocks.staff.mockReturnValue(hq("clinical"));
    adminScript({});
    const res = await call("/exports", "POST", {
      kind: "billing_payouts", start: "2026-08-01", end: "2026-09-06",
    });
    expect(res.status).toBe(403);
  });
  it("caps the per-requester backlog", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    adminScript({ pending: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }] });
    expect((await call("/exports", "POST", { kind: "provider_directory" })).status).toBe(429);
  });
  it("uses the organization's export link lifetime for new jobs and the list", async () => {
    mocks.staff.mockReturnValue(hq("clinical"));
    adminScript({ exportLinkHours: 48 });
    const before = Date.now();
    const res = await call("/exports", "POST", { kind: "office_comparison", start: "2026-08-01", end: "2026-09-06" });
    expect(res.status).toBe(202);
    const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
    const expiresAt = Date.parse((insert[2] as { expires_at: string }).expires_at);
    expect(expiresAt - before).toBeGreaterThanOrEqual(48 * 3_600_000 - 5_000);
    expect(expiresAt - before).toBeLessThanOrEqual(48 * 3_600_000 + 60_000);
    const json = await (await call("/exports")).json() as { ttlHours: number };
    expect(json.ttlHours).toBe(48);
  });
  it("lists only the caller's jobs and the kinds their role may request", async () => {
    mocks.staff.mockReturnValue(hq("clinical"));
    adminScript({});
    const json = await (await call("/exports")).json() as { jobs: unknown[]; available: Array<{ kind: string }>; ttlHours: number };
    expect(json.jobs).toHaveLength(1);
    expect(json.available.map((k) => k.kind)).toEqual(["office_comparison", "training_completion"]);
    expect(json.ttlHours).toBe(24);
    const list = mocks.admin.mock.calls.find(([, path]) => String(path).includes("order=created_at.desc"))!;
    expect(list[1]).toContain("requested_by=eq.hq-user");
  });
});

describe("downloading exports", () => {
  it("mints a short-lived signed link for the owner's ready job and audits the download", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    adminScript({});
    mocks.signed.mockReset().mockResolvedValue("https://storage.example/signed");
    const res = await call(`/exports/${JOB_ID}/download-url`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: "https://storage.example/signed", expiresInSeconds: 300 });
    expect(mocks.signed).toHaveBeenCalledWith(jobRow().object_path, 300);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "data_export_downloaded", targetId: JOB_ID }));
    const lookup = mocks.admin.mock.calls.find(([method, path]) => method === "GET" && String(path).includes("id=eq."))!;
    expect(lookup[1]).toContain("requested_by=eq.hq-user");
  });
  it("hides other people's jobs behind a neutral 404", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    adminScript({ job: null });
    expect((await call(`/exports/${JOB_ID}`)).status).toBe(404);
    expect((await call(`/exports/${JOB_ID}/download-url`)).status).toBe(404);
    expect(mocks.signed).not.toHaveBeenCalledTimes(2);
  });
  it("answers 409 while queued, 410 once expired, and never signs either", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    mocks.signed.mockReset();
    adminScript({ job: jobRow({ status: "queued", object_path: null }) });
    expect((await call(`/exports/${JOB_ID}/download-url`)).status).toBe(409);
    adminScript({ job: jobRow({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
    expect((await call(`/exports/${JOB_ID}/download-url`)).status).toBe(410);
    adminScript({ job: jobRow({ status: "expired", object_path: null }) });
    expect((await call(`/exports/${JOB_ID}/download-url`)).status).toBe(410);
    expect(mocks.signed).not.toHaveBeenCalled();
  });
});

describe("job DTO and kind menu", () => {
  it("reports a ready job past its expiry as expired and not downloadable", () => {
    const dto = exportJobDto(jobRow({ expires_at: "2026-09-01T00:00:00Z" }), Date.parse("2026-09-02T00:00:00Z"));
    expect(dto.status).toBe("expired");
    expect(dto.downloadable).toBe(false);
    expect(exportJobDto(jobRow(), Date.parse("2026-01-01T00:00:00Z")).downloadable).toBe(true);
  });
  it("offers office staff everything except the directory, and flags HQ patient activity as office-bound", () => {
    const office = availableKinds({ kind: "office", userId: "o", actorKind: "team_member", providerId: "p1", officeName: "One", officeRole: "admin" });
    expect(office.map((k) => k.kind)).toEqual([
      "office_comparison", "patient_activity", "audit_events", "training_completion",
      "billing_transactions", "billing_subscriptions", "billing_payouts",
    ]);
    expect(office.every((k) => !k.needsOffice)).toBe(true);
    const admin = availableKinds({ kind: "hq", userId: "h", identity: { userId: "h", role: "hq_admin", departmentRole: "super_admin" } });
    expect(admin.find((k) => k.kind === "patient_activity")?.needsOffice).toBe(true);
    expect(admin.find((k) => k.kind === "provider_directory")?.ranged).toBe(false);
  });
});
