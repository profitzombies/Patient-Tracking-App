import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(), audit: vi.fn(), scope: vi.fn(), staff: vi.fn(), signed: vi.fn(), drain: vi.fn(), signal: vi.fn(),
}));
vi.mock("../jobs/scheduler", () => ({ signalJob: mocks.signal }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin, fetchAuthUser: vi.fn() }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));
vi.mock("../lib/admin-audit", () => ({ recordAdminAuditEvent: mocks.audit }));
vi.mock("../lib/objectStorage", () => ({ objectStorage: { signedDownloadURL: mocks.signed } }));
vi.mock("../exports/worker", () => ({ drainQueuedExports: mocks.drain }));
/** Financial and HQ-office kinds freeze the Test/Live identity at request time. */
vi.mock("../billing/mode-state", () => ({
  getBillingModeStatus: async () => ({ mode: "test", platformAccountId: "acct_TestPlatform", version: 1 }),
}));
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
  expires_at: new Date(Date.now() + 3_600_000).toISOString(), download_count: 0, last_downloaded_at: null, parts: null, cancel_requested_at: null, ...overrides,
});
const PATIENT_ID = "55555555-5555-4555-8555-555555555555";
const recordParts = [
  { part: 1, fileName: "thinnr_patient-record_ann-lee_2026-09-06_part-01-of-02.zip", objectPath: `/objects/exports/${JOB_ID}/record-part-01-66666666-6666-4666-8666-666666666666.zip`, sizeBytes: 10, fileCount: 20 },
  { part: 2, fileName: "thinnr_patient-record_ann-lee_2026-09-06_part-02-of-02.zip", objectPath: `/objects/exports/${JOB_ID}/record-part-02-77777777-7777-4777-8777-777777777777.zip`, sizeBytes: 20, fileCount: 3 },
];
const recordRow = (overrides: Record<string, unknown> = {}) => jobRow({
  kind: "patient_record", requested_by: "office-user", requester_kind: "provider", requester_role: null, provider_id: "p1",
  params: { officeName: "One", patientId: PATIENT_ID, patientName: "Ann Lee", omitted: 1 }, file_name: "thinnr_patient-record_ann-lee_2026-09-06.zip",
  object_path: recordParts[0].objectPath, size_bytes: 30, row_count: 23, parts: recordParts, ...overrides,
});

/** Route the PostgREST calls the request handler makes by path prefix. */
function adminScript(handlers: { pending?: unknown[]; inserted?: Record<string, unknown>; job?: Record<string, unknown> | null; exportLinkHours?: number; patient?: Record<string, unknown> | null; counts?: { office: number; network: number; tombstones: number }; snapshots?: unknown[] }) {
  mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: unknown, prefer?: string) => {
    if (method === "GET" && prefer === "count=exact") {
      const counts = handlers.counts ?? { office: 3, network: 12, tombstones: 1 };
      const total = path.startsWith("/rest/v1/patient_tombstones") ? counts.tombstones : path.includes("provider_id=eq.") ? counts.office : counts.network;
      return { status: 200, json: [], contentRange: `0-0/${total}` };
    }
    if (method === "GET" && path.startsWith("/rest/v1/system_size_snapshots")) return response(handlers.snapshots ?? []);
    if (path.startsWith("/rest/v1/hq_organization_settings")) {
      if (handlers.exportLinkHours === undefined) throw new Error("policy unavailable");
      return response([{ export_link_hours: handlers.exportLinkHours, version: 1 }]);
    }
    if (path.startsWith("/rest/v1/data_exports?requested_by=") && path.includes("status=in.(queued,running)")) return response(handlers.pending ?? []);
    if (method === "GET" && path.startsWith("/rest/v1/patients?id=eq.")) {
      if (handlers.patient === null) return response([]);
      return response([{ id: PATIENT_ID, first_name: "Ann", last_name: "Lee", name: null, ...(handlers.patient ?? {}) }]);
    }
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
  mocks.signal.mockReset();
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
  describe("a patient's full record", () => {
    it("lets an office owner request it for a patient of their office, audited against the patient", async () => {
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue(officeScope);
      adminScript({});
      const res = await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID });
      expect(res.status).toBe(202);
      const body = await res.json() as { job: { scope: { patientId: string; patientName: string }; fileName: string; parts: unknown; progress: unknown } };
      expect(body.job.scope).toMatchObject({ patientId: PATIENT_ID, patientName: "Ann Lee" });
      expect(body.job.fileName).toMatch(/^thinnr_patient-record_ann-lee_\d{4}-\d{2}-\d{2}\.zip$/);
      expect(body.job.parts).toBeNull();
      const lookup = mocks.admin.mock.calls.find(([, path]) => String(path).startsWith("/rest/v1/patients?id=eq."))!;
      expect(lookup[1]).toContain(`id=eq.${PATIENT_ID}`);
      expect(lookup[1]).toContain("provider_id=eq.p1");
      expect(lookup[1]).not.toContain("activation_status");
      const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
      expect(insert[2]).toMatchObject({ kind: "patient_record", provider_id: "p1", params: { officeName: "One", patientId: PATIENT_ID, patientName: "Ann Lee" } });
      expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: "patient_record_export_requested", targetKind: "patient", targetId: PATIENT_ID, providerId: "p1",
        metadata: expect.objectContaining({ kind: "patient_record", exportId: JOB_ID }),
      }));
      expect(mocks.drain).toHaveBeenCalled();
    });
    it("admits admins but refuses office staff with a specific message and no database work", async () => {
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue({ ...officeScope, scope: { ...officeScope.scope, actorKind: "team_member", officeRole: "staff" } });
      adminScript({});
      const denied = await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID });
      expect(denied.status).toBe(403);
      expect((await denied.json() as { error: string }).error).toContain("owners and admins");
      expect(mocks.admin.mock.calls.some(([method]) => method === "POST")).toBe(false);
      expect(mocks.audit).not.toHaveBeenCalled();
      mocks.scope.mockResolvedValue({ ...officeScope, scope: { ...officeScope.scope, actorKind: "team_member", officeRole: "admin" } });
      expect((await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID })).status).toBe(202);
    });
    it("needs a patient id, and answers 404 when the patient is not in the office", async () => {
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue(officeScope);
      adminScript({});
      expect((await call("/exports", "POST", { kind: "patient_record" })).status).toBe(400);
      expect((await call("/exports", "POST", { kind: "patient_record", patientId: "not-a-uuid" })).status).toBe(400);
      adminScript({ patient: null });
      const missing = await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID });
      expect(missing.status).toBe(404);
      expect(mocks.admin.mock.calls.some(([method]) => method === "POST")).toBe(false);
    });
    it("makes HQ name the office and hold provider_manage there", async () => {
      mocks.staff.mockReturnValue(hq("admin"));
      adminScript({});
      expect((await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID })).status).toBe(400);
      mocks.scope.mockResolvedValue({ kind: "ok", scope: { ...officeScope.scope, actorUserId: "hq-user", actorKind: "hq" } });
      const res = await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID, office: "acct-p1" });
      expect(res.status).toBe(202);
      expect(mocks.scope.mock.calls[0][0]).toMatchObject({ explicitOfficeId: "acct-p1", hqPermission: "provider_manage" });
      const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
      expect(insert[2]).toMatchObject({ requester_kind: "hq", provider_id: "p1", params: { patientId: PATIENT_ID } });
      mocks.staff.mockReturnValue(hq("clinical"));
      expect((await call("/exports", "POST", { kind: "patient_record", patientId: PATIENT_ID, office: "acct-p1" })).status).toBe(403);
    });
    it("lists one patient's record exports for the patient page, still pinned to the caller", async () => {
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue(officeScope);
      adminScript({ job: recordRow() });
      const json = await (await call(`/exports?patient=${PATIENT_ID}`)).json() as { jobs: Array<{ parts: unknown[]; omittedFiles: number; scope: { patientName: string } }>; available: Array<{ kind: string; needsPatient: boolean }> };
      const list = mocks.admin.mock.calls.find(([, path]) => String(path).includes("order=created_at.desc"))!;
      expect(list[1]).toContain("requested_by=eq.office-user");
      expect(list[1]).toContain(`params->>patientId=eq.${PATIENT_ID}`);
      expect(json.jobs[0].parts).toHaveLength(2);
      expect(json.jobs[0].omittedFiles).toBe(1);
      expect(json.jobs[0].scope.patientName).toBe("Ann Lee");
      expect(json.available.find((k) => k.kind === "patient_record")?.needsPatient).toBe(true);
    });
  });
  describe("an entire office record (HQ bundle)", () => {
    const hqScope = { kind: "ok", scope: { ...officeScope.scope, actorUserId: "hq-user", actorKind: "hq" } };
    it("queues a bundle for HQ provider managers with a build allowance, audits it against the office, and wakes the bundle job", async () => {
      mocks.staff.mockReturnValue(hq("admin"));
      mocks.scope.mockResolvedValue(hqScope);
      adminScript({});
      const before = Date.now();
      const res = await call("/exports", "POST", { kind: "office_bundle", office: "acct-p1", includeTombstones: true });
      expect(res.status).toBe(202);
      const body = await res.json() as { job: { kind: string; fileName: string; includeTombstones: boolean; progress: { stage: string; patientsDone: number | null; bytesWritten: number } } };
      expect(body.job.kind).toBe("office_bundle");
      expect(body.job.fileName).toMatch(/^thinnr_office-bundle_test_acct-testplatform_one_\d{4}-\d{2}-\d{2}\.zip$/);
      expect(body.job.includeTombstones).toBe(true);
      expect(body.job.progress).toMatchObject({ stage: "collecting", patientsDone: null, bytesWritten: 0 });
      expect(mocks.scope.mock.calls[0][0]).toMatchObject({ explicitOfficeId: "acct-p1", hqPermission: "provider_manage" });
      const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
      const row = insert[2] as { kind: string; provider_id: string; requester_kind: string; params: Record<string, unknown>; expires_at: string };
      expect(row).toMatchObject({ kind: "office_bundle", provider_id: "p1", requester_kind: "hq", params: { officeName: "One", includeTombstones: true } });
      // Seven days to build, not the 48h link policy; the job re-stamps expiry when ready.
      expect(Date.parse(row.expires_at) - before).toBeGreaterThan(6.9 * 86_400_000);
      expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: "office_bundle_export_requested", targetKind: "data_export", targetId: JOB_ID, providerId: "p1",
        metadata: expect.objectContaining({ kind: "office_bundle", office: "p1", exportId: JOB_ID, includeTombstones: true, patients: 3 }),
      }));
      expect(mocks.signal).toHaveBeenCalledWith("office-bundle-export");
      expect(mocks.drain).not.toHaveBeenCalled();
    });
    it("refuses office users (owners included) and HQ without provider_manage, and needs an explicit office", async () => {
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue(officeScope);
      adminScript({});
      const owner = await call("/exports", "POST", { kind: "office_bundle" });
      expect(owner.status).toBe(403);
      expect(mocks.admin.mock.calls.some(([method]) => method === "POST")).toBe(false);
      expect(mocks.audit).not.toHaveBeenCalled();
      expect((await call("/exports/office-bundle/estimate?office=acct-p1")).status).toBe(403);
      mocks.staff.mockReturnValue(hq("clinical"));
      mocks.scope.mockResolvedValue(hqScope);
      expect((await call("/exports", "POST", { kind: "office_bundle", office: "acct-p1" })).status).toBe(403);
      expect((await call("/exports/office-bundle/estimate?office=acct-p1")).status).toBe(403);
      mocks.staff.mockReturnValue(hq("admin"));
      expect((await call("/exports", "POST", { kind: "office_bundle" })).status).toBe(400);
      expect((await call("/exports/office-bundle/estimate")).status).toBe(400);
      expect(mocks.signal).not.toHaveBeenCalled();
      const list = await (await call("/exports")).json() as { available: Array<{ kind: string; needsOffice: boolean }> };
      expect(list.available.find((k) => k.kind === "office_bundle")).toMatchObject({ needsOffice: true });
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue(officeScope);
      const officeRes = await call("/exports");
      expect(officeRes.status).toBe(200);
      const officeList = await officeRes.json() as { available: Array<{ kind: string }> };
      expect(officeList.available.some((k) => k.kind === "office_bundle")).toBe(false);
    });
    it("estimates patient count, tombstones, and the office's share of the latest size snapshot", async () => {
      mocks.staff.mockReturnValue(hq("admin"));
      mocks.scope.mockResolvedValue(hqScope);
      adminScript({
        counts: { office: 3, network: 12, tombstones: 2 },
        snapshots: [
          { snapshot_date: "2026-09-18", kind: "storage_total", total_bytes: "4000" },
          { snapshot_date: "2026-09-18", kind: "database", total_bytes: 800 },
          { snapshot_date: "2026-09-17", kind: "database", total_bytes: 700 },
        ],
      });
      const res = await call("/exports/office-bundle/estimate?office=acct-p1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        office: { id: "p1", name: "One" }, patientCount: 3, tombstoneCount: 2, estimatedBytes: 1200, snapshotDate: "2026-09-18",
      });
      adminScript({ counts: { office: 3, network: 12, tombstones: 0 }, snapshots: [] });
      expect(await (await call("/exports/office-bundle/estimate?office=acct-p1")).json()).toMatchObject({ estimatedBytes: null, snapshotDate: null });
    });
    it("reports bundle progress from the job state and audits part downloads against the office", async () => {
      const parts = [1, 2].map((part) => ({ part, fileName: `thinnr_office-bundle_one_2026-09-06_part-00${part}.zip`, objectPath: `/objects/exports/${JOB_ID}/part-0${part}-66666666-6666-4666-8666-66666666666${part}.zip`, sizeBytes: 10 * part, fileCount: 4, sha256: "ab".repeat(32) }));
      const bundleRow = (overrides: Record<string, unknown> = {}) => jobRow({
        kind: "office_bundle", provider_id: "p1", params: { officeName: "One", includeTombstones: false, bundle: { stage: "patients", patientsDone: 2, patientsTotal: 3, bytesWritten: 30, omittedFiles: 1 } },
        file_name: "thinnr_office-bundle_one_2026-09-06.zip", object_path: parts[0].objectPath, parts, ...overrides,
      });
      const running = exportJobDto(bundleRow({ status: "running", object_path: null }), Date.parse("2026-01-01T00:00:00Z"));
      expect(running.progress).toEqual({ stage: "patients", partsDone: 2, partsTotal: null, patientsDone: 2, patientsTotal: 3, bytesWritten: 30 });
      expect(running.omittedFiles).toBe(1);
      expect(running.includeTombstones).toBe(false);
      mocks.staff.mockReturnValue(hq("admin"));
      adminScript({ job: bundleRow() });
      mocks.signed.mockResolvedValue("https://signed.example/part2");
      const res = await call(`/exports/${JOB_ID}/download-url?part=2`);
      expect(res.status).toBe(200);
      expect(mocks.signed).toHaveBeenCalledWith(parts[1].objectPath, 300);
      expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: "office_bundle_export_downloaded", providerId: "p1", targetKind: "data_export", targetId: JOB_ID,
        metadata: expect.objectContaining({ office: "p1", exportId: JOB_ID, part: 2, parts: 2 }),
      }));
    });
  });
  describe("app payments reports (what offices pay THINNR)", () => {
    const KINDS = [
      { kind: "app_payments_offices" },
      { kind: "app_payments_forecast", start: "2026-10-01", end: "2027-09-30" },
      { kind: "app_payments_transactions", start: "2026-01-01", end: "2026-09-30" },
    ];
    it("queues every kind network-wide for HQ financial readers, frozen to the Test/Live identity, even if an office is named", async () => {
      mocks.staff.mockReturnValue(hq("admin"));
      for (const body of KINDS) {
        adminScript({});
        const res = await call("/exports", "POST", { ...body, office: "acct-p1" });
        expect(res.status).toBe(202);
        const insert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && path === "/rest/v1/data_exports")!;
        const row = insert[2] as { kind: string; provider_id: string | null; requester_kind: string; params: Record<string, unknown> };
        expect(row).toMatchObject({ kind: body.kind, provider_id: null, requester_kind: "hq" });
        expect(row.params.billingIdentity).toEqual(expect.objectContaining({ mode: "test", platformAccountId: "acct_TestPlatform" }));
        if (body.start) expect(row.params).toMatchObject({ start: body.start, end: body.end });
        const job = (await res.json() as { job: { fileName: string } }).job;
        expect(job.fileName).toMatch(new RegExp(`^thinnr_${body.kind.replace(/_/g, "-")}_test_acct-testplatform_all-offices`));
      }
      // No office scope was ever resolved: these reports always cover every office.
      expect(mocks.scope).not.toHaveBeenCalled();
    });
    it("needs a range for the forecast and transactions reports", async () => {
      mocks.staff.mockReturnValue(hq("admin"));
      adminScript({});
      expect((await call("/exports", "POST", { kind: "app_payments_forecast" })).status).toBe(400);
      expect((await call("/exports", "POST", { kind: "app_payments_transactions" })).status).toBe(400);
    });
    it("refuses office owners and HQ without financial_read, and only lists the kinds for HQ financial readers", async () => {
      mocks.staff.mockReturnValue(null);
      mocks.scope.mockResolvedValue(officeScope);
      adminScript({});
      for (const body of KINDS) expect((await call("/exports", "POST", body)).status).toBe(403);
      const officeList = await (await call("/exports")).json() as { available: Array<{ kind: string }> };
      expect(officeList.available.some((k) => k.kind.startsWith("app_payments_"))).toBe(false);
      mocks.staff.mockReturnValue(hq("clinical"));
      for (const body of KINDS) expect((await call("/exports", "POST", body)).status).toBe(403);
      expect(mocks.admin.mock.calls.some(([method]) => method === "POST")).toBe(false);
      const admin = availableKinds({ kind: "hq", userId: "h", identity: { userId: "h", role: "hq_admin", departmentRole: "admin" } });
      expect(admin.filter((k) => k.kind.startsWith("app_payments_"))).toEqual([
        expect.objectContaining({ kind: "app_payments_offices", ranged: false, needsOffice: false }),
        expect.objectContaining({ kind: "app_payments_forecast", ranged: true, needsOffice: false }),
        expect.objectContaining({ kind: "app_payments_transactions", ranged: true, needsOffice: false }),
      ]);
    });
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
  it("signs the requested part of a multi-part record, audits it against the patient, and 404s unknown parts", async () => {
    mocks.staff.mockReturnValue(null);
    mocks.scope.mockResolvedValue(officeScope);
    adminScript({ job: recordRow() });
    mocks.signed.mockReset().mockResolvedValue("https://storage.example/part");
    const second = await call(`/exports/${JOB_ID}/download-url?part=2`);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ fileName: recordParts[1].fileName, part: 2 });
    expect(mocks.signed).toHaveBeenCalledWith(recordParts[1].objectPath, 300);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "patient_record_export_downloaded", targetKind: "patient", targetId: PATIENT_ID, providerId: "p1",
      metadata: { kind: "patient_record", exportId: JOB_ID, part: 2, parts: 2 },
    }));
    // No ?part= means part 1.
    const first = await call(`/exports/${JOB_ID}/download-url`);
    expect(await first.json()).toMatchObject({ fileName: recordParts[0].fileName, part: 1 });
    expect(mocks.signed).toHaveBeenLastCalledWith(recordParts[0].objectPath, 300);
    expect((await call(`/exports/${JOB_ID}/download-url?part=3`)).status).toBe(404);
    expect((await call(`/exports/${JOB_ID}/download-url?part=x`)).status).toBe(404);
    // CSV jobs have no parts: only part 1 exists.
    adminScript({});
    mocks.staff.mockReturnValue(hq("admin"));
    expect((await call(`/exports/${JOB_ID}/download-url?part=2`)).status).toBe(404);
    expect(mocks.signed).toHaveBeenCalledTimes(2);
    mocks.signed.mockReset();
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

describe("cancelling exports", () => {
  /** A live-ish row: PATCHes apply their filters and body to the one row the GETs return. */
  function liveRow(initial: Record<string, unknown>) {
    let row: Record<string, unknown> = { ...initial };
    const patches: Array<{ path: string; body: Record<string, unknown> }> = [];
    mocks.admin.mockReset().mockImplementation(async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.startsWith(`/rest/v1/data_exports?id=eq.${JOB_ID}`)) {
        return response(path.includes(`requested_by=eq.${row.requested_by}`) ? [row] : []);
      }
      if (method === "PATCH" && path.startsWith(`/rest/v1/data_exports?id=eq.${JOB_ID}`)) {
        patches.push({ path, body: body as Record<string, unknown> });
        const status = /status=eq\.([a-z]+)/.exec(path)?.[1];
        if (status && row.status !== status) return response([]);
        if (path.includes("cancel_requested_at=is.null") && row.cancel_requested_at) return response([]);
        row = { ...row, ...(body as Record<string, unknown>) };
        return response([row]);
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    return { patches, current: () => row };
  }
  it("flips a queued record export straight to cancelled and audits it against the patient with the export id", async () => {
    mocks.staff.mockReturnValue(null);
    mocks.scope.mockResolvedValue(officeScope);
    const live = liveRow(recordRow({ status: "queued", object_path: null, parts: null, size_bytes: null, row_count: null, completed_at: null }));
    const res = await call(`/exports/${JOB_ID}/cancel`, "POST");
    expect(res.status).toBe(200);
    const body = await res.json() as { job: { status: string; cancelRequested: boolean; downloadable: boolean; progress: unknown } };
    expect(body.job).toMatchObject({ status: "cancelled", cancelRequested: false, downloadable: false, progress: null });
    expect(live.current()).toMatchObject({ status: "cancelled" });
    expect(live.patches).toHaveLength(1);
    expect(live.patches[0].path).toContain("status=eq.queued");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "patient_record_export_cancelled", actorKind: "provider", targetKind: "patient", targetId: PATIENT_ID, providerId: "p1",
      metadata: { kind: "patient_record", office: "p1", exportId: JOB_ID, wasRunning: false },
    }));
    // Nothing in the audit row names the patient.
    expect(JSON.stringify(mocks.audit.mock.calls[0][0])).not.toContain("Ann");
    // No fresh code is needed to STOP data leaving the office.
    expect(gate.calls).toBe(0);
  });
  it("asks the worker to stop a running job (cancelRequested until it confirms) and is idempotent", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    const live = liveRow(jobRow({ status: "running", object_path: null, completed_at: null }));
    const res = await call(`/exports/${JOB_ID}/cancel`, "POST");
    expect(res.status).toBe(200);
    expect((await res.json() as { job: { status: string; cancelRequested: boolean } }).job).toMatchObject({ status: "running", cancelRequested: true });
    expect(live.current().status).toBe("running");
    expect(typeof live.current().cancel_requested_at).toBe("string");
    expect(live.patches.map((patch) => patch.path)).toEqual([expect.stringContaining("status=eq.running&cancel_requested_at=is.null")]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "data_export_cancelled", actorKind: "hq", targetKind: "data_export", targetId: JOB_ID,
      metadata: { kind: "office_comparison", office: "all", wasRunning: true },
    }));
    // A second click while the worker unwinds: same answer, no second stamp, no second audit row.
    const again = await call(`/exports/${JOB_ID}/cancel`, "POST");
    expect(again.status).toBe(200);
    expect((await again.json() as { job: { cancelRequested: boolean } }).job.cancelRequested).toBe(true);
    expect(live.patches.filter((patch) => patch.body.cancel_requested_at && !patch.body.status)).toHaveLength(2);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
  it("refuses to cancel finished, failed, or expired jobs, and hides other people's jobs", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    for (const [row, message] of [
      [jobRow(), "already finished"],
      [jobRow({ status: "failed", object_path: null }), "no longer running"],
      [jobRow({ status: "expired", object_path: null }), "no longer running"],
      [jobRow({ status: "cancelled", object_path: null }), "no longer running"],
    ] as Array<[Record<string, unknown>, string]>) {
      const live = liveRow(row);
      const res = await call(`/exports/${JOB_ID}/cancel`, "POST");
      expect(res.status).toBe(409);
      expect((await res.json() as { error: string }).error).toContain(message);
      expect(live.patches).toHaveLength(0);
    }
    liveRow(jobRow({ status: "queued", requested_by: "someone-else" }));
    expect((await call(`/exports/${JOB_ID}/cancel`, "POST")).status).toBe(404);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("loses the race gracefully: a job that finished between the read and the cancel answers 409, unaudited", async () => {
    mocks.staff.mockReturnValue(hq("admin"));
    let reads = 0;
    mocks.admin.mockReset().mockImplementation(async (method: string, path: string) => {
      if (method === "GET") { reads += 1; return response([jobRow(reads === 1 ? { status: "running", object_path: null } : {})]); }
      if (method === "PATCH") return response([]);
      throw new Error(`unexpected ${method} ${path}`);
    });
    const res = await call(`/exports/${JOB_ID}/cancel`, "POST");
    expect(res.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("job DTO and kind menu", () => {
  it("reports a ready job past its expiry as expired and not downloadable", () => {
    const dto = exportJobDto(jobRow({ expires_at: "2026-09-01T00:00:00Z" }), Date.parse("2026-09-02T00:00:00Z"));
    expect(dto.status).toBe("expired");
    expect(dto.downloadable).toBe(false);
    expect(exportJobDto(jobRow(), Date.parse("2026-01-01T00:00:00Z")).downloadable).toBe(true);
  });
  it("reports parts and progress for a record job", () => {
    const ready = exportJobDto(recordRow(), Date.parse("2026-01-01T00:00:00Z"));
    expect(ready.parts).toEqual(recordParts.map(({ part, fileName, sizeBytes, fileCount }) => ({ part, fileName, sizeBytes, fileCount })));
    expect(ready.progress).toBeNull();
    const running = exportJobDto(recordRow({ status: "running", object_path: null, parts: null, params: { patientId: PATIENT_ID, progress: { stage: "writing", partsDone: 1, partsTotal: 3 } } }), Date.parse("2026-01-01T00:00:00Z"));
    expect(running.cancelRequested).toBe(false);
    const stopping = exportJobDto(recordRow({ status: "running", object_path: null, parts: null, cancel_requested_at: "2026-01-01T00:00:00Z" }), Date.parse("2026-01-01T00:00:00Z"));
    expect(stopping).toMatchObject({ status: "running", cancelRequested: true });
    const cancelled = exportJobDto(recordRow({ status: "cancelled", object_path: null, parts: null, cancel_requested_at: "2026-01-01T00:00:00Z" }), Date.parse("2026-01-01T00:00:00Z"));
    expect(cancelled).toMatchObject({ status: "cancelled", cancelRequested: false, downloadable: false, parts: null, progress: null, error: null });
    // A cancelled row past its expiry reads as expired, like failed rows do.
    expect(exportJobDto(recordRow({ status: "cancelled", object_path: null, parts: null, expires_at: "2025-12-01T00:00:00Z" }), Date.parse("2026-01-01T00:00:00Z")).status).toBe("expired");
    expect(running.progress).toEqual({ stage: "writing", partsDone: 1, partsTotal: 3, patientsDone: null, patientsTotal: null, bytesWritten: null });
    expect(running.parts).toBeNull();
    expect(exportJobDto(jobRow(), Date.parse("2026-01-01T00:00:00Z")).parts).toBeNull();
  });
  it("offers office staff everything except the directory, and flags HQ patient activity as office-bound", () => {
    const office = availableKinds({ kind: "office", userId: "o", actorKind: "team_member", providerId: "p1", officeName: "One", officeRole: "admin" });
    expect(office.map((k) => k.kind)).toEqual([
      "office_comparison", "patient_activity", "audit_events", "training_completion",
      "billing_transactions", "billing_subscriptions", "billing_payouts", "patient_record",
    ]);
    expect(office.every((k) => !k.needsOffice)).toBe(true);
    expect(office.find((k) => k.kind === "patient_record")?.needsPatient).toBe(true);
    const staff = availableKinds({ kind: "office", userId: "o", actorKind: "team_member", providerId: "p1", officeName: "One", officeRole: "staff" });
    expect(staff.some((k) => k.kind === "patient_record")).toBe(false);
    const admin = availableKinds({ kind: "hq", userId: "h", identity: { userId: "h", role: "hq_admin", departmentRole: "super_admin" } });
    expect(admin.find((k) => k.kind === "patient_activity")?.needsOffice).toBe(true);
    expect(admin.find((k) => k.kind === "patient_record")).toMatchObject({ needsOffice: true, needsPatient: true });
    const clinical = availableKinds({ kind: "hq", userId: "h", identity: { userId: "h", role: "hq_admin", departmentRole: "clinical" } });
    expect(clinical.some((k) => k.kind === "patient_record")).toBe(false);
    expect(admin.find((k) => k.kind === "provider_directory")?.ranged).toBe(false);
  });
});
