import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), scope: vi.fn(), staff: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../auth/office-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/office-scope")>()),
  resolveOfficeScope: mocks.scope,
}));
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

const usageRow = (overrides: Record<string, unknown> = {}) => ({
  provider_id: "p1", office_name: "One", provider_name: "Dr One", first_patient_date: "2026-09-01",
  activated_patients: 10, activated_patients_now: 12, active_now: 1, active_today: 3,
  weekly_active_today: 6, monthly_active_today: 9, weekly_active: 5, monthly_active: 8, ...overrides,
});
const usageDay = (provider_id: string, date: string, weekly_active: number, monthly_active: number) => ({ provider_id, date, weekly_active, monthly_active });

describe("HQ app usage", () => {
  const RANGE = "start=2026-08-30&end=2026-09-02";
  it("is denied to Support and Content (same gate as the office comparison)", async () => {
    for (const departmentRole of ["support", "content"]) {
      mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole });
      mocks.admin.mockReset();
      expect((await call(`/hq/app-usage?${RANGE}`)).status).toBe(403);
      expect(mocks.admin).not.toHaveBeenCalled();
    }
    mocks.staff.mockReturnValue(null);
    expect((await call(`/hq/app-usage?${RANGE}`)).status).toBe(401);
  });
  it("validates the range before any RPC", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset();
    expect((await call("/hq/app-usage?start=2026-09-06&end=2026-08-01")).status).toBe(400);
    expect((await call("/hq/app-usage")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("sums per-office distinct counts into network figures, shares, and a trimmed network series", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "clinical" });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("patient_app_usage_offices")) {
        expect(body).toMatchObject({ p_start: "2026-08-30", p_end: "2026-09-02" });
        expect(typeof body.p_at).toBe("string");
        return response([
          usageRow(),
          usageRow({ provider_id: "p2", office_name: "Two", first_patient_date: "2026-08-31", activated_patients: 4, activated_patients_now: 4, active_now: 0, active_today: 1, weekly_active_today: 2, monthly_active_today: 3, weekly_active: 1, monthly_active: 2 }),
          usageRow({ provider_id: "p3", office_name: "Empty", first_patient_date: null, activated_patients: 0, activated_patients_now: 0, active_now: 0, active_today: 0, weekly_active_today: 0, monthly_active_today: 0, weekly_active: 0, monthly_active: 0 }),
        ]);
      }
      if (path.endsWith("patient_app_usage_daily")) {
        expect(body).toEqual({ p_start: "2026-08-30", p_end: "2026-09-02" });
        return response([
          usageDay("p1", "2026-08-30", 0, 0), usageDay("p1", "2026-08-31", 0, 0), usageDay("p1", "2026-09-01", 4, 6), usageDay("p1", "2026-09-02", 5, 8),
          usageDay("p2", "2026-08-30", 0, 0), usageDay("p2", "2026-08-31", 1, 1), usageDay("p2", "2026-09-01", 1, 2), usageDay("p2", "2026-09-02", 1, 2),
          usageDay("p3", "2026-08-30", 0, 0), usageDay("p3", "2026-08-31", 0, 0), usageDay("p3", "2026-09-01", 0, 0), usageDay("p3", "2026-09-02", 0, 0),
        ]);
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = await call(`/hq/app-usage?${RANGE}`);
    expect(res.status).toBe(200);
    const json = await res.json() as {
      network: Record<string, unknown> & { atRangeEnd: Record<string, unknown>; series: Array<{ date: string; weeklyActive: number; monthlyActive: number }> };
      offices: Array<{ providerId: string; available: boolean; metrics: Record<string, unknown> | null; series: Array<{ date: string }> }>;
    };
    expect(json.network).toMatchObject({
      firstPatientDate: "2026-08-31", available: true,
      activatedPatients: 16, activeNow: 1, activeToday: 4, weeklyActive: 8, monthlyActive: 12,
      activeNowSharePct: 6.3, activeTodaySharePct: 25, weeklySharePct: 50, monthlySharePct: 75,
    });
    expect(json.network.atRangeEnd).toEqual({ activatedPatients: 14, weeklyActive: 6, monthlyActive: 10, weeklySharePct: 42.9, monthlySharePct: 71.4 });
    expect(json.network.series).toEqual([
      { date: "2026-08-31", weeklyActive: 1, monthlyActive: 1 },
      { date: "2026-09-01", weeklyActive: 5, monthlyActive: 8 },
      { date: "2026-09-02", weeklyActive: 6, monthlyActive: 10 },
    ]);
    expect(json.offices).toHaveLength(3);
    expect(json.offices[0]).toMatchObject({ providerId: "p1", available: true, metrics: { activatedPatients: 10, weeklyActive: 5, monthlyActive: 8, weeklySharePct: 50, monthlySharePct: 80 } });
    expect(json.offices[0].series.map((p) => p.date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(json.offices[2]).toMatchObject({ providerId: "p3", available: false, metrics: null, series: [] });
  });
  it("reports a range that predates every office as unavailable rather than zero", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith("patient_app_usage_offices")) return response([usageRow({ first_patient_date: "2026-09-10", weekly_active: 0, monthly_active: 0 })]);
      return response([usageDay("p1", "2026-08-30", 0, 0)]);
    });
    const json = await (await call(`/hq/app-usage?${RANGE}`)).json() as { network: { available: boolean; atRangeEnd: { weeklySharePct: number | null } }; offices: Array<{ available: boolean; metrics: unknown }> };
    expect(json.network.available).toBe(false);
    expect(json.network.atRangeEnd.weeklySharePct).toBeNull();
    expect(json.offices[0]).toMatchObject({ available: false, metrics: null });
  });
  it("maps RPC failures to 502", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockResolvedValue(response({}, 500));
    expect((await call(`/hq/app-usage?${RANGE}`)).status).toBe(502);
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

describe("overview inbox block", () => {
  const overviewRow = { provider_count: 1, total_patients: 3, active_patients: 2, enrollments_30d: 1, engaged_7d: 1, needs_attention: 0, inactive: 0, invited: 1, watchlist: 0, logging_lapsed: 0, check_ins_overdue: 0, avg_pounds_lost: null };
  const inboxRow = { open_threads: 4, waiting_threads: 2, closed_threads: 9, unanswered_threads: 3, avg_response_minutes: "18.5", open_escalations: 1 };
  it("includes office inbox metrics from the office-pinned inbox RPC", async () => {
    mocks.scope.mockReset().mockResolvedValue({ kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "a", actorKind: "provider" } });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("nonfinancial_operational_rollup")) return response([overviewRow]);
      if (path.startsWith("/rest/v1/hq_organization_settings")) return response([{ conversation_auto_close_days: 14, version: 1 }]);
      if (path.endsWith("patient_chat_inbox_metrics")) { expect(body).toMatchObject({ p_provider_id: "p1", p_auto_close_before: expect.any(String) }); return response([inboxRow]); }
      throw new Error(`unexpected ${path}`);
    });
    const json = await (await call("/office/overview")).json() as { metrics: { totalPatients: number; inbox: Record<string, unknown> } };
    expect(json.metrics.totalPatients).toBe(3);
    expect(json.metrics.inbox).toEqual({ openThreads: 4, waitingOnPatient: 2, closedThreads: 9, unanswered: 3, avgResponseMinutes: 18.5, openEscalations: 1 });
  });
  it("rolls the whole fleet's inbox into the HQ overview", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("nonfinancial_operational_rollup")) return response([overviewRow]);
      if (path.startsWith("/rest/v1/hq_organization_settings")) return response([{ conversation_auto_close_days: 14, version: 1 }]);
      if (path.endsWith("patient_chat_inbox_metrics")) { expect(body).toMatchObject({ p_provider_id: null, p_auto_close_before: expect.any(String) }); return response([{ ...inboxRow, avg_response_minutes: null }]); }
      throw new Error(`unexpected ${path}`);
    });
    const json = await (await call("/hq/overview")).json() as { metrics: { inbox: { avgResponseMinutes: number | null; openThreads: number } } };
    expect(json.metrics.inbox).toMatchObject({ openThreads: 4, avgResponseMinutes: null });
  });
  it("fails the overview loudly when the inbox RPC is down instead of serving zeros", async () => {
    mocks.scope.mockReset().mockResolvedValue({ kind: "ok", scope: { providerId: "p1", officeName: "One", actorUserId: "a", actorKind: "provider" } });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string) => {
      if (path.endsWith("nonfinancial_operational_rollup")) return response([overviewRow]);
      if (path.startsWith("/rest/v1/hq_organization_settings")) return response([{ conversation_auto_close_days: 14, version: 1 }]);
      return response({}, 500);
    });
    expect((await call("/office/overview")).status).toBe(502);
  });
});

describe("HQ app usage insights", () => {
  const RANGE = "start=2026-09-07&end=2026-09-13"; // Mon..Sun
  const OFFICE = "live-4f2c9a1b0d3e";
  const bucket = (local_day: string, local_hour: number, events: number, patients = 1) => ({ local_day, local_hour, events, patients });

  it("is denied to Support and Content and validates range + dataset before any RPC", async () => {
    for (const departmentRole of ["support", "content"]) {
      mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole });
      mocks.admin.mockReset();
      expect((await call(`/hq/app-usage-insights?dataset=food_log&${RANGE}`)).status).toBe(403);
      expect(mocks.admin).not.toHaveBeenCalled();
    }
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset();
    expect((await call(`/hq/app-usage-insights?dataset=food_log&start=2026-09-13&end=2026-09-07`)).status).toBe(400);
    expect((await call(`/hq/app-usage-insights?dataset=screen_taps&${RANGE}`)).status).toBe(400);
    expect((await call(`/hq/app-usage-insights?${RANGE}`)).status).toBe(400);
    expect((await call(`/hq/app-usage-insights?dataset=food_log&${RANGE}&office=${encodeURIComponent("bad id/with spaces")}`)).status).toBe(404);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("queries the current and the same-length previous period and assembles series, heatmap, tiles and changes", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "clinical" });
    const calls: Array<Record<string, unknown>> = [];
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("patient_app_event_insights")) {
        calls.push(body);
        expect(body).toMatchObject({ p_feature: "food_log", p_provider_id: null });
        if (body.p_start === "2026-09-07") {
          return response([
            bucket("2026-09-08", 12, 10, 4), bucket("2026-09-08", 13, 6, 3), bucket("2026-09-08", 14, 2, 1),
            bucket("2026-09-10", 19, 14, 7), bucket("2026-09-12", -1, 8, 2),
          ]);
        }
        expect(body).toMatchObject({ p_start: "2026-08-31", p_end: "2026-09-06" });
        return response([bucket("2026-09-01", 12, 20, 5)]);
      }
      if (path.endsWith("patient_app_event_bounds")) {
        expect(body).toEqual({ p_feature: "food_log", p_provider_id: null });
        return response([{ first_day: "2026-08-01", first_hourly_day: "2026-09-08", first_live_at: "2026-09-08T12:00:00Z" }]);
      }
      throw new Error(`unexpected ${path}`);
    });
    const res = await call(`/hq/app-usage-insights?dataset=food_log&${RANGE}`);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, any>;
    expect(calls).toHaveLength(2);
    expect(json.range).toEqual({ start: "2026-09-07", end: "2026-09-13" });
    expect(json.previousRange).toEqual({ start: "2026-08-31", end: "2026-09-06" });
    expect(json.office).toBeNull();
    expect(json.totals).toEqual({ current: 40, previous: 20, changePct: 100, patientDays: 17 });
    expect(json.current).toHaveLength(7);
    expect(json.current[1]).toEqual({ date: "2026-09-08", count: 18 });
    expect(json.current[5]).toEqual({ date: "2026-09-12", count: 8 });
    expect(json.previous).toHaveLength(7);
    expect(json.previous[1]).toEqual({ date: "2026-09-01", count: 20 });
    expect(json.heatmap).toHaveLength(168);
    // Thursday 7pm is the single busiest cell; the day-only Saturday row is not in the heatmap.
    expect(json.peak).toEqual({ weekday: 4, hour: 19, count: 14 });
    expect(json.heatmap.filter((c: { count: number }) => c.count > 0).map((c: { weekday: number; hour: number }) => `${c.weekday}:${c.hour}`)).toEqual(["2:12", "2:13", "2:14", "4:19"]);
    expect(json.tiles.peakWindow).toEqual({ weekday: 2, startHour: 12, endHour: 14, count: 18 });
    expect(json.tiles.bestDay).toEqual({ weekday: 2, count: 18, sharePct: 45 });
    expect(json.tiles.busiestHour).toEqual({ hour: 19, count: 14, sharePct: 44 });
    expect(json.tiles.weekendSharePct).toBe(20);
    expect(json.hourly.since).toBe("2026-09-08");
    expect(json.hourly.complete).toBe(false);
    const kinds = json.changes.map((c: { kind: string }) => c.kind);
    expect(kinds).toEqual(["trend", "day", "window", "tracking"]);
    expect(json.changes[0].text).toBe("Food logs are up 100% vs the previous 7 days (40 vs 20).");
    expect(json.changes[1].text).toBe("Tuesdays are the strongest day with 45% of food logs.");
    expect(json.changes[2].text).toBe("Busiest window: Tue 12–3pm in patients' local time (18 food logs).");
    expect(json.changes[3].text).toContain("started Sep 8, 2026");
  });

  it("scopes every RPC to an enabled office and answers 404 for unknown or disabled ones", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.startsWith("/rest/v1/providers?")) {
        expect(path).toContain(`provider_id=eq.${OFFICE}`);
        expect(path).toContain("access_disabled=is.false");
        return response(path.includes(OFFICE) && !disabled ? [{ provider_id: OFFICE, office_name: "Lakeside", provider_name: "Dr L" }] : []);
      }
      expect(body.p_provider_id).toBe(OFFICE);
      if (path.endsWith("patient_app_event_bounds")) return response([{ first_day: null, first_hourly_day: null, first_live_at: null }]);
      return response([]);
    });
    let disabled = true;
    expect((await call(`/hq/app-usage-insights?dataset=order&${RANGE}&office=${OFFICE}`)).status).toBe(404);
    disabled = false;
    const res = await call(`/hq/app-usage-insights?dataset=order&${RANGE}&office=${OFFICE}`);
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, any>;
    expect(json.office).toEqual({ id: OFFICE, name: "Lakeside" });
    expect(json.totals).toEqual({ current: 0, previous: 0, changePct: null, patientDays: 0 });
    expect(json.peak).toBeNull();
    expect(json.tiles).toEqual({ peakWindow: null, bestDay: null, busiestHour: null, weekendSharePct: null });
    expect(json.changes.map((c: { kind: string }) => c.kind)).toEqual(["quiet", "tracking"]);
    expect(json.changes[0].text).toBe("No orders were recorded in this range for Lakeside.");
  });

  it("accepts legacy text provider ids and looks them up exactly", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    const LEGACY = "acct-p1";
    const providerLookups: string[] = [];
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      if (path.startsWith("/rest/v1/providers?")) {
        providerLookups.push(path);
        return response([{ provider_id: LEGACY, office_name: "Legacy Clinic", provider_name: "Dr P" }]);
      }
      expect(body.p_provider_id).toBe(LEGACY);
      if (path.endsWith("patient_app_event_bounds")) return response([{ first_day: null, first_hourly_day: null, first_live_at: null }]);
      return response([]);
    });
    const res = await call(`/hq/app-usage-insights?dataset=weigh_in&${RANGE}&office=${LEGACY}`);
    expect(res.status).toBe(200);
    expect(providerLookups).toEqual([expect.stringContaining(`provider_id=eq.${LEGACY}&access_disabled=is.false`)]);
    expect(((await res.json()) as Record<string, any>).office).toEqual({ id: LEGACY, name: "Legacy Clinic" });
  });

  it("answers 502 when the database refuses instead of showing zeroes", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockResolvedValue(response({}, 500));
    expect((await call(`/hq/app-usage-insights?dataset=app_open&${RANGE}`)).status).toBe(502);
  });
});

describe("office app usage insights", () => {
  const RANGE = "start=2026-09-07&end=2026-09-13"; // Mon..Sun
  const OFFICE = "live-4f2c9a1b0d3e";
  const bucket = (local_day: string, local_hour: number, events: number, patients = 1) => ({ local_day, local_hour, events, patients });
  const okScope = (providerId = OFFICE) => ({ kind: "ok", scope: { providerId, officeName: "Lakeside", actorUserId: "a", actorKind: "provider" } });

  it("validates range + dataset before resolving scope or touching the database", async () => {
    mocks.scope.mockReset();
    mocks.admin.mockReset();
    expect((await call(`/office/app-usage-insights?dataset=food_log&start=2026-09-13&end=2026-09-07`)).status).toBe(400);
    expect((await call(`/office/app-usage-insights?dataset=screen_taps&${RANGE}`)).status).toBe(400);
    expect((await call(`/office/app-usage-insights?${RANGE}`)).status).toBe(400);
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("pins every RPC to the resolved office and never consults a provider lookup", async () => {
    mocks.scope.mockReset().mockResolvedValue(okScope());
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path.endsWith("patient_app_event_insights")) {
        expect(body.p_provider_id).toBe(OFFICE);
        if (body.p_start === "2026-09-07") return response([bucket("2026-09-08", 12, 10, 4), bucket("2026-09-10", 19, 14, 7), bucket("2026-09-12", -1, 8, 2)]);
        expect(body).toMatchObject({ p_start: "2026-08-31", p_end: "2026-09-06" });
        return response([bucket("2026-09-01", 12, 16, 5)]);
      }
      if (path.endsWith("patient_app_event_bounds")) {
        expect(body).toEqual({ p_feature: "food_log", p_provider_id: OFFICE });
        return response([{ first_day: "2026-08-01", first_hourly_day: "2026-09-08", first_live_at: "2026-09-08T12:00:00Z" }]);
      }
      throw new Error(`unexpected ${path}`);
    });
    // `office=` is forwarded to the resolver verbatim; the resolver, not the route, decides whether it counts.
    const res = await call(`/office/app-usage-insights?dataset=food_log&${RANGE}&office=${OFFICE}`);
    expect(res.status).toBe(200);
    expect(mocks.scope.mock.calls[0][0]).toMatchObject({ hqPermission: "provider_read", explicitOfficeId: OFFICE, requireUnlocked: false });
    expect(calls.map((c) => c.path.split("/").pop())).toEqual(expect.arrayContaining(["patient_app_event_insights", "patient_app_event_bounds"]));
    expect(calls.some((c) => c.path.startsWith("/rest/v1/providers?"))).toBe(false);
    const json = await res.json() as Record<string, any>;
    expect(json.office).toEqual({ id: OFFICE, name: "Lakeside" });
    expect(json.range).toEqual({ start: "2026-09-07", end: "2026-09-13" });
    expect(json.previousRange).toEqual({ start: "2026-08-31", end: "2026-09-06" });
    expect(json.totals).toEqual({ current: 32, previous: 16, changePct: 100, patientDays: 13 });
    expect(json.peak).toEqual({ weekday: 4, hour: 19, count: 14 });
    expect(json.heatmap).toHaveLength(168);
    expect(json.hourly.since).toBe("2026-09-08");
    expect(json.changes[0].text).toBe("Food logs are up 100% vs the previous 7 days (32 vs 16).");
  });

  it("uses the member's own office when provider staff send no office param", async () => {
    mocks.scope.mockReset().mockResolvedValue(okScope("live-own"));
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      expect(body.p_provider_id).toBe("live-own");
      if (path.endsWith("patient_app_event_bounds")) return response([{ first_day: null, first_hourly_day: null, first_live_at: null }]);
      return response([]);
    });
    const res = await call(`/office/app-usage-insights?dataset=order&${RANGE}`);
    expect(res.status).toBe(200);
    expect(mocks.scope.mock.calls[0][0]).toMatchObject({ explicitOfficeId: null });
    const json = await res.json() as Record<string, any>;
    expect(json.office).toEqual({ id: "live-own", name: "Lakeside" });
    expect(json.changes[0].text).toBe("No orders were recorded in this range for Lakeside.");
  });

  it("passes scope denials straight through without touching the database", async () => {
    mocks.admin.mockReset();
    for (const denied of [
      { kind: "denied", status: 400, message: "Choose an office before managing its patients.", code: "office_required" },
      { kind: "denied", status: 403, message: "This office's account is locked. Contact THINNR support." },
      { kind: "denied", status: 404, message: "Office not found." },
    ]) {
      mocks.scope.mockReset().mockResolvedValue(denied);
      expect((await call(`/office/app-usage-insights?dataset=app_open&${RANGE}`)).status).toBe(denied.status);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("answers 502 when the database refuses instead of showing zeroes", async () => {
    mocks.scope.mockReset().mockResolvedValue(okScope());
    mocks.admin.mockReset().mockResolvedValue(response({}, 500));
    expect((await call(`/office/app-usage-insights?dataset=app_open&${RANGE}`)).status).toBe(502);
  });
});
