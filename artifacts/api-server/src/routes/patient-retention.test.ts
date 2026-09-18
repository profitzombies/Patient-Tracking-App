/**
 * HQ patient retention route + pure assembly.
 *
 *  - sample dates: range start, week ends (short ranges) or month ends (long
 *    ranges), range end; the RPC request adds the day before the range;
 *  - assembly: per-office counts as of the range end, exact "new in range",
 *    shares, inactive = sum of tiers, network = sum of available offices,
 *    unavailable offices (no patient by range end) carry null metrics and an
 *    empty series, series trimmed to each office's first patient date;
 *  - route: same HQ gate as App usage (Support / Content denied, signed-out
 *    401), range validation before any RPC, 502 on RPC failure.
 */
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

import router from "./operational-rollups";
import { assembleRetention, requestDates, sampleDates, stepForRange, type RetentionRawRow } from "../lib/patient-retention";

let server: http.Server;
let base = "";
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string) { return fetch(base + path, { headers: { authorization: "Bearer t" } }); }

const raw = (provider_id: string, as_of: string, overrides: Partial<RetentionRawRow> = {}): RetentionRawRow => ({
  provider_id, office_name: provider_id === "p1" ? "One" : provider_id === "p2" ? "Two" : "Empty", provider_name: `Dr ${provider_id}`,
  first_patient_date: provider_id === "p3" ? null : "2026-06-01", as_of,
  onboarded: 0, active: 0, buying: 0, subscribed: 0, inactive_under_30: 0, inactive_30_60: 0, inactive_60_90: 0, inactive_90_plus: 0,
  ...overrides,
});

describe("sample dates", () => {
  it("uses week ends for short ranges and month ends for long ones, always bracketed by start and end", () => {
    // A boundary landing within half a step of the start is dropped (Jul 25 above, Jan 31 below).
    expect(stepForRange("2026-07-24", "2026-08-22")).toBe("week");
    expect(stepForRange("2026-01-01", "2026-08-22")).toBe("month");
    expect(sampleDates("2026-07-24", "2026-08-22")).toEqual({
      step: "week",
      dates: ["2026-07-24", "2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"],
    });
    expect(sampleDates("2026-01-25", "2026-08-22")).toEqual({
      step: "month",
      dates: ["2026-01-25", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-22"],
    });
    // A month-end range end is not duplicated.
    expect(sampleDates("2026-05-01", "2026-08-31").dates.filter((d) => d === "2026-08-31")).toHaveLength(1);
    // Single day.
    expect(sampleDates("2026-08-22", "2026-08-22").dates).toEqual(["2026-08-22"]);
    // A full year still fits the SQL cap.
    expect(sampleDates("2025-08-23", "2026-08-22").dates.length).toBeLessThanOrEqual(120);
  });
  it("asks the RPC for the day before the range too (exact new-in-range)", () => {
    expect(requestDates("2026-08-01", "2026-08-08")).toEqual(["2026-07-31", "2026-08-01", "2026-08-08"]);
  });
});

describe("assembly", () => {
  const range = { start: "2026-08-01", end: "2026-08-22" };
  const rows: RetentionRawRow[] = [];
  for (const as_of of ["2026-07-31", "2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"]) {
    rows.push(raw("p1", as_of, { onboarded: as_of === "2026-07-31" ? 8 : 10, active: 6, buying: 4, subscribed: 3, inactive_under_30: 1, inactive_30_60: 1, inactive_60_90: 1, inactive_90_plus: 1 }));
    rows.push(raw("p2", as_of, { first_patient_date: "2026-08-10", onboarded: as_of >= "2026-08-10" ? 4 : 0, active: as_of >= "2026-08-10" ? 3 : 0, buying: as_of >= "2026-08-10" ? 1 : 0, inactive_under_30: as_of >= "2026-08-10" ? 1 : 0 }));
    rows.push(raw("p3", as_of));
    rows.push(raw("p4", as_of, { office_name: "Future", first_patient_date: "2026-09-01" }));
  }
  const result = assembleRetention(range, rows, new Date("2026-08-22T12:00:00Z"));

  it("reports per-office counts as of the range end with exact new-in-range and shares", () => {
    const p1 = result.offices.find((o) => o.providerId === "p1")!;
    expect(p1.available).toBe(true);
    expect(p1.metrics).toEqual({
      onboarded: 10, newInRange: 2, active: 6, inactive: 4, buying: 4, subscribed: 3,
      inactiveUnder30: 1, inactive30to60: 1, inactive60to90: 1, inactive90plus: 1,
      activePct: 60, buyingPct: 40, inactivePct: 40,
    });
    expect(p1.series.map((p) => p.date)).toEqual(["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"]);
    expect(p1.series[3]).toEqual({ date: "2026-08-22", onboarded: 10, active: 6, buying: 4, inactive: 4 });
  });

  it("trims an office's series to its first patient date and marks patient-less / future offices unavailable", () => {
    const p2 = result.offices.find((o) => o.providerId === "p2")!;
    expect(p2.series.map((p) => p.date)).toEqual(["2026-08-15", "2026-08-22"]);
    expect(p2.metrics?.newInRange).toBe(4);
    const p3 = result.offices.find((o) => o.providerId === "p3")!;
    expect(p3).toMatchObject({ available: false, metrics: null, series: [], firstPatientDate: null });
    const p4 = result.offices.find((o) => o.providerId === "p4")!;
    expect(p4).toMatchObject({ available: false, metrics: null, series: [] });
    expect(result.offices.map((o) => o.officeName)).toEqual(["Empty", "Future", "One", "Two"]);
  });

  it("sums available offices into the network and samples weekly for a 22-day range", () => {
    expect(result.step).toBe("week");
    expect(result.network.available).toBe(true);
    expect(result.network.firstPatientDate).toBe("2026-06-01");
    expect(result.network.metrics).toMatchObject({ onboarded: 14, newInRange: 6, active: 9, buying: 5, inactive: 5, activePct: 64.3, buyingPct: 35.7 });
    expect(result.network.series.map((p) => [p.date, p.onboarded])).toEqual([["2026-08-01", 10], ["2026-08-08", 10], ["2026-08-15", 14], ["2026-08-22", 14]]);
    expect(result.asOf).toBe("2026-08-22T12:00:00.000Z");
  });

  it("is unavailable network-wide when no office has a patient by the range end", () => {
    const empty = assembleRetention(range, [raw("p3", "2026-08-22"), raw("p4", "2026-08-22", { first_patient_date: "2026-09-01" })], new Date());
    expect(empty.network).toMatchObject({ available: false, metrics: null, series: [], firstPatientDate: "2026-09-01" });
  });

  it("never lets shares divide by zero", () => {
    const zero = assembleRetention(range, requestDates(range.start, range.end).map((as_of) => raw("p1", as_of, { first_patient_date: "2026-08-01" })), new Date());
    expect(zero.offices[0].metrics).toMatchObject({ onboarded: 0, activePct: null, buyingPct: null, inactivePct: null });
  });
});

describe("GET /hq/patient-retention", () => {
  const RANGE = "start=2026-08-01&end=2026-08-22";
  it("is denied to Support and Content, 401 signed out", async () => {
    for (const departmentRole of ["support", "content"]) {
      mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole });
      mocks.admin.mockReset();
      expect((await call(`/hq/patient-retention?${RANGE}`)).status).toBe(403);
      expect(mocks.admin).not.toHaveBeenCalled();
    }
    mocks.staff.mockReturnValue(null);
    expect((await call(`/hq/patient-retention?${RANGE}`)).status).toBe(401);
  });
  it("validates the range before any RPC", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset();
    expect((await call("/hq/patient-retention?start=2026-09-06&end=2026-08-01")).status).toBe(400);
    expect((await call("/hq/patient-retention")).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("calls the RPC with the day-before + sample dates and returns the assembled payload", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "clinical" });
    mocks.admin.mockReset().mockImplementation(async (_m: string, path: string, body: Record<string, unknown>) => {
      expect(path.endsWith("patient_retention_offices")).toBe(true);
      expect(body).toEqual({ p_dates: ["2026-07-31", "2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22"] });
      return response((body.p_dates as string[]).map((as_of) => raw("p1", as_of, { onboarded: "12", active: "7", buying: "5", subscribed: "2", inactive_30_60: "5" })));
    });
    const res = await call(`/hq/patient-retention?${RANGE}`);
    expect(res.status).toBe(200);
    const json = await res.json() as { step: string; network: { metrics: Record<string, unknown> }; offices: Array<{ providerId: string; metrics: Record<string, unknown> }> };
    expect(json.step).toBe("week");
    expect(json.network.metrics).toMatchObject({ onboarded: 12, newInRange: 0, active: 7, inactive: 5, buying: 5, subscribed: 2, activePct: 58.3 });
    expect(json.offices[0].metrics).toMatchObject({ onboarded: 12, inactive30to60: 5 });
  });
  it("answers 502 when the RPC fails", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    mocks.admin.mockReset().mockResolvedValue(response({}, 500));
    expect((await call(`/hq/patient-retention?${RANGE}`)).status).toBe(502);
  });
  it("answers 502 (never zeroes) when the RPC payload is missing a date or a count", async () => {
    mocks.staff.mockReturnValue({ userId: "u", role: "hq_admin", departmentRole: "admin" });
    // A row for only the first requested date: the office's range-end tally is missing.
    mocks.admin.mockReset().mockImplementation(async (_m: string, _p: string, body: Record<string, unknown>) =>
      response([raw("p1", (body.p_dates as string[])[0], { onboarded: 12, active: 7, inactive_30_60: 5 })]));
    expect((await call(`/hq/patient-retention?${RANGE}`)).status).toBe(502);
    // Every date present, but a count column is null (e.g. a column renamed under us).
    mocks.admin.mockReset().mockImplementation(async (_m: string, _p: string, body: Record<string, unknown>) =>
      response((body.p_dates as string[]).map((as_of) => raw("p1", as_of, { onboarded: 12, active: null as unknown as number }))));
    expect((await call(`/hq/patient-retention?${RANGE}`)).status).toBe(502);
    // A row for a date nobody asked for.
    mocks.admin.mockReset().mockImplementation(async (_m: string, _p: string, body: Record<string, unknown>) =>
      response([...(body.p_dates as string[]).map((as_of) => raw("p1", as_of)), raw("p1", "2020-01-01")]));
    expect((await call(`/hq/patient-retention?${RANGE}`)).status).toBe(502);
  });
});
