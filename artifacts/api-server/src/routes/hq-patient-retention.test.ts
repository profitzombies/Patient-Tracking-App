import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), staff: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
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
import router, { assembleRetention, retentionPointRowDto, type RetentionPointRow, type RetentionResult } from "./hq-patient-retention";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string) { return fetch(base + path, { headers: { authorization: "Bearer t" } }); }
const hq = (departmentRole = "admin") => ({ userId: "u-hq", role: "hq_admin", departmentRole });

function row(providerId: string, asOf: string, counts: Partial<RetentionPointRow> = {}, extra: Partial<RetentionPointRow> = {}): Record<string, unknown> {
  return {
    provider_id: providerId, office_name: `${providerId} office`, provider_name: `Dr ${providerId}`,
    first_onboarded_on: "2026-01-15", as_of: asOf,
    onboarded: 0, active: 0, buying: 0, inactive: 0, inactive_30_60: 0, inactive_60_90: 0, inactive_90_plus: 0,
    ...counts, ...extra,
  };
}

beforeEach(() => { mocks.admin.mockReset(); mocks.staff.mockReset(); mocks.staff.mockReturnValue(hq()); });

describe("GET /hq/patient-retention", () => {
  it("rejects bad ranges before touching the database, and gates on HQ analytics access", async () => {
    expect((await call("/hq/patient-retention?start=2026-09-01")).status).toBe(400);
    expect((await call("/hq/patient-retention?start=2026-09-18&end=2026-09-01")).status).toBe(400);
    expect((await call("/hq/patient-retention?start=2025-01-01&end=2026-09-18")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.staff.mockReturnValue(hq("support"));
    expect((await call("/hq/patient-retention?start=2026-09-01&end=2026-09-18")).status).toBe(403);
    mocks.staff.mockReturnValue(null);
    expect((await call("/hq/patient-retention?start=2026-09-01&end=2026-09-18")).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("asks the database for every weekly period end (plus the range end) and sums offices into the network", async () => {
    // 30-day range → 7-day buckets walked back from the range end (the first one clamped to the start).
    mocks.admin.mockImplementation(async (method: string, path: string, body: Record<string, unknown>) => {
      if (method === "GET") {
        // The network view also asks which office is the App Review office and drops it.
        expect(path).toBe("/rest/v1/providers?app_review=is.true&select=provider_id&limit=50");
        return response([{ provider_id: "review" }]);
      }
      expect(path).toBe("/rest/v1/rpc/patient_retention_points");
      expect(body.p_provider_id).toBeNull();
      const dates = body.p_dates as string[];
      expect(dates).toEqual(["2026-08-21", "2026-08-28", "2026-09-04", "2026-09-11", "2026-09-18"]);
      const rows: Record<string, unknown>[] = [];
      for (const date of dates) {
        rows.push(row("a", date, { onboarded: 10, active: 7, buying: 4, inactive: 3, inactive_30_60: 1, inactive_60_90: 1, inactive_90_plus: 1 }));
        rows.push(row("b", date, { onboarded: 20, active: 12, buying: 5, inactive: 8, inactive_30_60: 4, inactive_60_90: 2, inactive_90_plus: 2 }));
        // The App Review office's sample patients would otherwise inflate the network.
        rows.push(row("review", date, { onboarded: 99, active: 99, buying: 99 }));
        // Enabled office with no onboarded patient yet: unavailable, never zero.
        rows.push(row("c", date, {}, { first_onboarded_on: null }));
        // Office whose first patient arrives after the range: unavailable too.
        rows.push(row("d", date, {}, { first_onboarded_on: "2026-10-01" }));
      }
      return response(rows);
    });
    const res = await call("/hq/patient-retention?start=2026-08-20&end=2026-09-18");
    expect(res.status).toBe(200);
    const json = (await res.json()) as RetentionResult;
    expect(json.period).toBe("week");
    expect(json.office).toBeNull();
    expect(json.range).toEqual({ start: "2026-08-20", end: "2026-09-18" });
    expect(json.network.available).toBe(true);
    expect(json.network.firstOnboardedDate).toBe("2026-01-15");
    expect(json.network.counts).toEqual({
      onboarded: 30, active: 19, buying: 9, inactive: 11, activePct: 63.3, buyingPct: 30,
      inactiveTiers: { days30to60: 5, days60to90: 3, days90plus: 3 },
    });
    expect(json.network.series.map((p) => [p.periodStart, p.periodEnd])).toEqual([
      ["2026-08-20", "2026-08-21"], ["2026-08-22", "2026-08-28"], ["2026-08-29", "2026-09-04"], ["2026-09-05", "2026-09-11"], ["2026-09-12", "2026-09-18"],
    ]);
    expect(json.network.series[4]).toMatchObject({ onboarded: 30, active: 19, buying: 9, inactive: 11 });
    expect(json.offices.map((o) => [o.providerId, o.available])).toEqual([
      ["a", true], ["b", true], ["c", false], ["d", false],
    ]);
    expect(json.offices[0].counts).toMatchObject({ onboarded: 10, activePct: 70, buyingPct: 40 });
    expect(json.offices[0].series).toHaveLength(5);
    expect(json.offices[2]).toMatchObject({ firstOnboardedDate: null, counts: null, series: [] });
    expect(json.offices[3]).toMatchObject({ firstOnboardedDate: "2026-10-01", counts: null, series: [] });
  });

  it("switches to calendar months for long ranges and narrows to one enabled office", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string, body?: Record<string, unknown>) => {
      if (method === "GET") {
        expect(path).toContain("/rest/v1/providers?provider_id=eq.live-1&access_disabled=is.false");
        return response([{ provider_id: "live-1", office_name: "Solo Clinic", provider_name: "Dr Solo" }]);
      }
      expect(body?.p_provider_id).toBe("live-1");
      const dates = body?.p_dates as string[];
      expect(dates).toEqual(["2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-18"]);
      // The office's first patient was onboarded in May: earlier months carry no point.
      return response(dates.map((date) => row("live-1", date, { onboarded: date >= "2026-05-31" ? 5 : 0, active: date >= "2026-05-31" ? 3 : 0, inactive: date >= "2026-05-31" ? 2 : 0, inactive_30_60: date >= "2026-05-31" ? 2 : 0 }, { first_onboarded_on: "2026-05-10", office_name: "Solo Clinic" })));
    });
    const res = await call("/hq/patient-retention?start=2026-03-15&end=2026-09-18&office=live-1");
    expect(res.status).toBe(200);
    const json = (await res.json()) as RetentionResult;
    expect(json.period).toBe("month");
    expect(json.office).toEqual({ id: "live-1", name: "Solo Clinic" });
    expect(json.offices).toHaveLength(1);
    expect(json.offices[0].series.map((p) => p.periodEnd)).toEqual(["2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-18"]);
    expect(json.offices[0].series[0]).toMatchObject({ periodStart: "2026-05-01", periodEnd: "2026-05-31", onboarded: 5 });
    expect(json.network.counts).toEqual(json.offices[0].counts);
    expect(json.network.series).toEqual(json.offices[0].series);
  });

  it("answers 404 for unknown, disabled or malformed offices and 502 when the database fails", async () => {
    mocks.admin.mockResolvedValueOnce(response([]));
    expect((await call("/hq/patient-retention?start=2026-09-01&end=2026-09-18&office=live-missing")).status).toBe(404);
    expect((await call("/hq/patient-retention?start=2026-09-01&end=2026-09-18&office=" + encodeURIComponent("bad id!"))).status).toBe(404);
    mocks.admin.mockResolvedValueOnce(response({ message: "boom" }, 500));
    const failed = await call("/hq/patient-retention?start=2026-09-01&end=2026-09-18");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Could not load patient retention right now." });
  });

  it("reports the whole network as unavailable (null counts) when no office has an onboarded patient", () => {
    const rows = [row("a", "2026-09-18", {}, { first_onboarded_on: null })].map(retentionPointRowDto);
    const result = assembleRetention({ range: { start: "2026-09-12", end: "2026-09-18" }, asOf: "2026-09-18T12:00:00.000Z", office: null, rows });
    expect(result.network).toEqual({ firstOnboardedDate: null, available: false, counts: null, series: [] });
    expect(result.offices[0].counts).toBeNull();
    // Percentages are null, not 0, when nobody is onboarded yet — even for an available office.
    const fresh = assembleRetention({
      range: { start: "2026-09-12", end: "2026-09-18" }, asOf: "x", office: null,
      rows: [row("a", "2026-09-18", {}, { first_onboarded_on: "2026-09-18" })].map(retentionPointRowDto),
    });
    expect(fresh.offices[0].counts).toMatchObject({ onboarded: 0, activePct: null, buyingPct: null });
  });
});
