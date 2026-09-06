import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), scope: vi.fn(), staff: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../auth/office-scope", () => ({ resolveOfficeScope: mocks.scope }));
vi.mock("../lib/staff-auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/staff-auth")>("../lib/staff-auth");
  return {
    ...actual,
    requireHqPermission: (permission: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const identity = mocks.staff(req.headers.authorization);
      if (!identity) { res.status(401).json({ error: "Sign in to continue." }); return; }
      if (!actual.hasHqPermission(identity, permission as never)) { res.status(403).json({ error: "no" }); return; }
      res.locals.staff = identity; next();
    },
  };
});
import router, { officeRollupDto, parseRange } from "./operational-rollups";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string) { return fetch(base + path, { headers: { authorization: "Bearer t" } }); }

const rollupRow = (overrides: Record<string, unknown> = {}) => ({
  provider_id: "p1", office_name: "One", provider_name: "Dr One", first_patient_date: "2026-09-01",
  total_patients: 3, active_patients: 2, enrollments: 3, engaged: 1, needs_attention: 1, inactive: 0, invited: 1,
  logging_lapsed: 1, check_ins_overdue: 0, logging_patients: 1, check_in_patients: 2, avg_pounds_lost: null, ...overrides,
});
const dailyRow = (provider_id: string, date: string, engaged_patients: number) => ({ provider_id, date, active_patients: 2, engaged_patients, enrollments: 0, check_ins: 0 });

describe("range parsing", () => {
  it("accepts real calendar ranges up to a year and rejects the rest", () => {
    expect(parseRange({ start: "2026-08-01", end: "2026-09-06" })).toEqual({ start: "2026-08-01", end: "2026-09-06" });
    expect(parseRange({ start: "2026-09-06", end: "2026-08-01" })).toBeNull();
    expect(parseRange({ start: "2026-02-30", end: "2026-03-01" })).toBeNull();
    expect(parseRange({ start: "2025-01-01", end: "2026-01-02" })).toBeNull();
    expect(parseRange({ start: "2025-01-01", end: "2026-01-01" })).not.toBeNull();
    expect(parseRange({})).toBeNull();
  });
});

describe("office rollup mapping", () => {
  it("marks a range that predates the office's first patient unavailable (metrics null, never zero)", () => {
    const dto = officeRollupDto(rollupRow({ total_patients: 0, active_patients: 0 }), { start: "2026-07-01", end: "2026-07-31" });
    expect(dto.available).toBe(false);
    expect(dto.metrics).toBeNull();
  });
  it("treats an office with no patients at all as unavailable", () => {
    const dto = officeRollupDto(rollupRow({ first_patient_date: null }), { start: "2026-07-01", end: "2026-09-06" });
    expect(dto.available).toBe(false);
  });
  it("derives adherence percentages from active patients and keeps null averages null", () => {
    const dto = officeRollupDto(rollupRow(), { start: "2026-08-08", end: "2026-09-06" });
    expect(dto.available).toBe(true);
    expect(dto.metrics).toMatchObject({ checkInAdherencePct: 100, loggingAdherencePct: 50, avgPoundsLost: null, needsAttention: 1 });
    expect(officeRollupDto(rollupRow({ active_patients: 0, check_in_patients: 0 }), { start: "2026-08-08", end: "2026-09-06" }).metrics?.checkInAdherencePct).toBeNull();
  });
});

describe("HQ office comparison", () => {
  it("requires analytics_read", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "support" });
    expect((await call("/hq/office-comparison?start=2026-08-01&end=2026-09-06")).status).toBe(403);
  });
  it("validates the range before any RPC", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset();
    expect((await call("/hq/office-comparison?start=2026-09-06&end=2026-08-01")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("returns one row per office with its series trimmed to the days it has data for", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "clinical" });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("nonfinancial_office_rollup")) {
        expect(body).toEqual({ p_provider_id: null, p_start: "2026-08-30", p_end: "2026-09-02" });
        return response([rollupRow(), rollupRow({ provider_id: "p2", office_name: "Two", first_patient_date: null, total_patients: 0 })]);
      }
      if (path.endsWith("nonfinancial_office_daily")) {
        return response([dailyRow("p1", "2026-08-30", 0), dailyRow("p1", "2026-08-31", 0), dailyRow("p1", "2026-09-01", 1), dailyRow("p1", "2026-09-02", 2), dailyRow("p2", "2026-08-30", 0)]);
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = await call("/hq/office-comparison?start=2026-08-30&end=2026-09-02");
    expect(res.status).toBe(200);
    const json = await res.json() as { offices: Array<{ providerId: string; available: boolean; metrics: unknown; series: Array<{ date: string; engagedPatients: number }> }> };
    expect(json.offices).toHaveLength(2);
    expect(json.offices[0].series.map((p) => p.date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(json.offices[0].series[1].engagedPatients).toBe(2);
    expect(json.offices[1]).toMatchObject({ providerId: "p2", available: false, metrics: null, series: [] });
  });
  it("maps RPC failures to 502", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockResolvedValue(response({}, 500));
    expect((await call("/hq/office-comparison?start=2026-08-30&end=2026-09-02")).status).toBe(502);
  });
});

describe("office analytics", () => {
  it("scopes through resolveOfficeScope with provider_read and pins the RPC to that office", async () => {
    mocks.scope.mockReset().mockResolvedValue({ kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "a", actorKind: "provider" } });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      expect(body.p_provider_id).toBe("p1");
      if (path.endsWith("nonfinancial_office_rollup")) return response([rollupRow()]);
      return response([dailyRow("p1", "2026-09-01", 1)]);
    });
    const res = await call("/office/analytics?start=2026-09-01&end=2026-09-01&office=ignored");
    expect(res.status).toBe(200);
    const json = await res.json() as { office: { providerId: string }; available: boolean; metrics: { engaged: number }; series: unknown[] };
    expect(json.office.providerId).toBe("p1");
    expect(json.available).toBe(true);
    expect(json.metrics.engaged).toBe(1);
    expect(json.series).toHaveLength(1);
    expect(mocks.scope.mock.calls[0][0]).toMatchObject({ hqPermission: "provider_read", explicitOfficeId: "ignored" });
  });
  it("passes scope denials straight through", async () => {
    mocks.scope.mockResolvedValue({ kind: "denied", status: 403, message: "This office's account is locked. Contact THINNR support." });
    const res = await call("/office/analytics?start=2026-09-01&end=2026-09-01");
    expect(res.status).toBe(403);
  });
  it("reports a pre-dataset range as unavailable rather than zeros", async () => {
    mocks.scope.mockResolvedValue({ kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "a", actorKind: "provider" } });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string) =>
      path.endsWith("nonfinancial_office_rollup") ? response([rollupRow({ total_patients: 0, active_patients: 0, enrollments: 0 })]) : response([dailyRow("p1", "2026-07-01", 0)]));
    const json = await (await call("/office/analytics?start=2026-07-01&end=2026-07-01")).json() as { available: boolean; metrics: unknown; series: unknown[] };
    expect(json).toMatchObject({ available: false, metrics: null, series: [] });
  });
});
