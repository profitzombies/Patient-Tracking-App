import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), staff: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../lib/org-policy", () => ({ loadOrgPolicy: async () => ({ defaultTimezone: "America/New_York" }) }));
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
    requireStaff: () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const identity = mocks.staff(req.headers.authorization);
      if (!identity) { res.status(401).json({ error: "Sign in to continue." }); return; }
      res.locals.staff = identity; next();
    },
  };
});
import router, { assembleCustomerHealth, officeHealthRowDto, type CustomerHealthResult } from "./hq-customer-health";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string, init: RequestInit = {}) { return fetch(base + path, { ...init, headers: { authorization: "Bearer t", "content-type": "application/json", ...(init.headers ?? {}) } }); }
const SNAPSHOTS = "/rest/v1/office_customer_health_weekly_snapshots";
const REVIEW_OFFICES = "/rest/v1/providers?app_review=is.true";
/** Routes the facts RPC, the App Review flag read and the two weekly snapshot reads (last week W40, this week W41 around 2026-10-09). */
function serve(
  facts: Record<string, unknown>[],
  snapshots: Record<string, Array<{ provider_id: string; score: number }>> = {},
  reviewOffices: string[] = [],
) {
  mocks.admin.mockImplementation(async (method: string, path: string) => {
    if (path.startsWith(SNAPSHOTS)) {
      expect(method).toBe("GET");
      const week = /iso_week=eq\.([^&]+)/.exec(path)?.[1] ?? "";
      return response(snapshots[decodeURIComponent(week)] ?? []);
    }
    if (path.startsWith(REVIEW_OFFICES)) {
      expect(method).toBe("GET");
      return response(reviewOffices.map((provider_id) => ({ provider_id })));
    }
    expect(method).toBe("POST");
    expect(path).toBe("/rest/v1/rpc/office_customer_health");
    return response(facts);
  });
}
const hq = (departmentRole = "admin") => ({ userId: "u-hq", role: "hq_admin", departmentRole });

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-09T15:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function row(providerId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_id: providerId, office_name: `${providerId} office`, provider_name: `Dr ${providerId}`,
    access_disabled: false, offboarding_status: "active", created_at: ago(400),
    last_paid_order_at: null, active_subscribers: 0, cancelling_subscriptions: 0,
    app_users: 0, active_app_users_30d: 0, active_app_users_prior_30d: 0, staff_enrolled: 0,
    ...extra,
  };
}

beforeEach(() => {
  mocks.admin.mockReset(); mocks.staff.mockReset(); mocks.staff.mockReturnValue(hq());
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("GET /hq/customer-health", () => {
  it("gates on HQ analytics access before any service-role call", async () => {
    mocks.staff.mockReturnValue(hq("support"));
    expect((await call("/hq/customer-health")).status).toBe(403);
    mocks.staff.mockReturnValue(hq("content"));
    expect((await call("/hq/customer-health")).status).toBe(403);
    mocks.staff.mockReturnValue(null);
    expect((await call("/hq/customer-health")).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    // Clinical holds analytics_read, exactly like Patient retention / App usage.
    mocks.staff.mockReturnValue(hq("clinical"));
    serve([]);
    expect((await call("/hq/customer-health")).status).toBe(200);
  });

  it("calls the aggregate as of today, drops offboarding offices, and returns ranked rows, counts, attention and definitions", async () => {
    serve([
      row("a", { last_paid_order_at: ago(5), active_subscribers: "10", app_users: 25, active_app_users_30d: 25, staff_enrolled: 3 }),
      row("b", { last_paid_order_at: ago(75), app_users: 10, active_app_users_30d: 2, active_app_users_prior_30d: 6 }),
      row("c", { offboarding_status: "offboarding", last_paid_order_at: ago(1) }),
      row("d", { offboarding_status: "offboarded", access_disabled: true }),
      row("e", { created_at: ago(10) }),
      row("f", { last_paid_order_at: ago(500), cancelling_subscriptions: 2, active_subscribers: 2 }),
    ]);
    const res = await call("/hq/customer-health");
    expect(res.status).toBe(200);
    const rpc = mocks.admin.mock.calls.find((c) => c[1] === "/rest/v1/rpc/office_customer_health");
    expect((rpc?.[2] as Record<string, unknown>).p_as_of).toBe("2026-10-09");
    const json = (await res.json()) as CustomerHealthResult;
    // No weekly snapshot yet: every change is null (the page shows an em dash).
    expect(json.priorSnapshotWeek).toBeNull();
    expect(json.offices.every((o) => o.priorWeekScore === null && o.scoreChange === null)).toBe(true);
    expect(json.generatedAt).toBe("2026-10-09T15:00:00.000Z");
    expect(json.offices.map((o) => o.providerId)).toEqual(["a", "b", "f", "e"]);
    expect(json.offices[0]).toMatchObject({ rank: 1, score: 100, band: "healthy", bucket: "active", isNew: false, activeSubscribers: 10, flags: [] });
    expect(json.offices[0].lastOrderDate).toBe(ago(5).slice(0, 10));
    expect(json.offices[0].daysSinceLastOrder).toBe(5);
    expect(json.offices[1]).toMatchObject({ rank: 2, bucket: "active", band: "watch" });
    expect(json.offices[1].flags.map((f) => f.kind)).toEqual(["leavingActive", "activeUsersDrop"]);
    expect(json.offices[1].flags[0].reason).toBe("Last order 75 days ago — about to leave Active (90-day mark).");
    // f earns 3 points from its two subscribers; e (New, nothing yet) is an honest 0.
    expect(json.offices[2]).toMatchObject({ providerId: "f", rank: 3, score: 3, bucket: "quietOverYear", isNew: false });
    expect(json.offices[3]).toMatchObject({ providerId: "e", rank: 4, score: 0, bucket: "quietOverYear", isNew: true, lastOrderDate: null, daysSinceLastOrder: null, flags: [] });
    expect(json.bucketCounts).toEqual({ active: 2, quiet3to6: 0, quiet6to12: 0, quietOverYear: 2 });
    expect(json.bandCounts).toEqual({ healthy: 1, watch: 1, atRisk: 2 });
    expect(json.attention.map((o) => o.providerId)).toEqual(["f", "b"]);
    expect(json.attention[0].flags.map((f) => f.kind)).toEqual(["subscriptionsCancelling", "atRisk"]);
    expect(json.definitions).toMatchObject({
      weights: { recency: 40, subscribers: 15, appUsers: 15, activeAppUsers: 15, staff: 15 },
      targets: { subscribers: 10, appUsers: 25, staff: 3 },
      recencyFullDays: 30, recencyZeroDays: 365,
      bucketBounds: { active: 90, quiet3to6: 180, quiet6to12: 365 },
      bandThresholds: { healthy: 70, watch: 40 },
      newOfficeDays: 90,
    });
  });

  it("drops the flagged App Review office even though it is active, and fails loudly when the flag read fails", async () => {
    serve([row("a", { last_paid_order_at: ago(5) }), row("review", { last_paid_order_at: ago(1), active_subscribers: 4 })], {}, ["review"]);
    const res = await call("/hq/customer-health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as CustomerHealthResult;
    expect(json.offices.map((o) => o.providerId)).toEqual(["a"]);
    expect(json.bucketCounts.active).toBe(1);

    mocks.admin.mockImplementation(async (_method: string, path: string) =>
      path.startsWith(REVIEW_OFFICES) ? response({ message: "down" }, 500) : response([row("a")]),
    );
    expect((await call("/hq/customer-health")).status).toBeGreaterThanOrEqual(500);
  });

  it("adds each office's prior-week score and signed change from last ISO week's Monday snapshot", async () => {
    serve(
      [row("a", { last_paid_order_at: ago(5), active_subscribers: 10, app_users: 25, active_app_users_30d: 25, staff_enrolled: 3 }), row("b", { last_paid_order_at: ago(75) }), row("g")],
      { "2026-W40": [{ provider_id: "a", score: 88 }, { provider_id: "b", score: 40 }], "2026-W41": [{ provider_id: "a", score: 99 }] },
    );
    const json = (await (await call("/hq/customer-health")).json()) as CustomerHealthResult;
    expect(json.priorSnapshotWeek).toBe("2026-W40");
    const byId = Object.fromEntries(json.offices.map((o) => [o.providerId, o]));
    expect(byId.a).toMatchObject({ score: 100, priorWeekScore: 88, scoreChange: 12 });
    expect(byId.b.scoreChange).toBe(byId.b.score - 40);
    // An office with no snapshot last week stays unknown, not zero.
    expect(byId.g).toMatchObject({ priorWeekScore: null, scoreChange: null });
    expect(json.attention.find((o) => o.providerId === "b")?.priorWeekScore).toBe(40);
    // Only the snapshot reads for last week and (not needed here) this week; one RPC.
    expect(mocks.admin.mock.calls.filter((c) => String(c[1]).startsWith(SNAPSHOTS))).toHaveLength(1);
  });

  it("falls back to this week's snapshot during the first week after the job starts", async () => {
    serve([row("a", { last_paid_order_at: ago(5) })], { "2026-W41": [{ provider_id: "a", score: 50 }] });
    const json = (await (await call("/hq/customer-health")).json()) as CustomerHealthResult;
    expect(json.priorSnapshotWeek).toBe("2026-W41");
    expect(json.offices[0]).toMatchObject({ priorWeekScore: 50, scoreChange: json.offices[0].score - 50 });
  });

  it("answers 502 when the snapshot read fails rather than pretending there is no history", async () => {
    mocks.admin.mockImplementation(async (_method: string, path: string) => path.startsWith(SNAPSHOTS) ? response({ message: "boom" }, 500) : response([]));
    expect((await call("/hq/customer-health")).status).toBe(502);
  });

  it("answers 502 (never zeros) when the aggregate fails", async () => {
    mocks.admin.mockResolvedValueOnce(response({ message: "boom" }, 500));
    const failed = await call("/hq/customer-health");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "Could not load customer health right now." });
    mocks.admin.mockRejectedValueOnce(new Error("network"));
    expect((await call("/hq/customer-health")).status).toBe(502);
  });

  it("gives an office with no patients or orders honest zeros and no order on record", () => {
    const asOf = new Date("2026-10-09T12:00:00Z");
    const result = assembleCustomerHealth([officeHealthRowDto(row("solo", { created_at: "2025-01-01T00:00:00Z", office_name: null }))], asOf);
    expect(result.offices).toHaveLength(1);
    expect(result.offices[0]).toMatchObject({
      officeName: "Dr solo", score: 0, band: "atRisk", bucket: "quietOverYear", isNew: false,
      lastOrderDate: null, lastOrderAt: null, daysSinceLastOrder: null,
      activeSubscribers: 0, appUsers: 0, activeAppUsers30d: 0, staffEnrolled: 0,
    });
    expect(result.offices[0].flags.map((f) => f.kind)).toEqual(["atRisk"]);
    expect(assembleCustomerHealth([], asOf).offices).toEqual([]);
  });
});

describe("weekly summary email preference (personal)", () => {
  const PATH = "/hq/notification-preferences/weekly-customer-health";
  const PREFS = "/rest/v1/hq_member_notification_preferences";

  it("reads the caller's own row; absent = off; any active HQ membership may read", async () => {
    mocks.staff.mockReturnValue(hq("support"));
    mocks.admin.mockResolvedValueOnce(response([]));
    const off = await call(PATH);
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ enabled: false });
    const [method, path] = mocks.admin.mock.calls[0];
    expect(method).toBe("GET");
    expect(path).toContain(`${PREFS}?auth_user_id=eq.u-hq&kind=eq.weekly_customer_health_email`);
    mocks.admin.mockResolvedValueOnce(response([{ enabled: true }]));
    expect(await (await call(PATH)).json()).toEqual({ enabled: true });
  });

  it("requires a signed-in HQ member", async () => {
    mocks.staff.mockReturnValue(null);
    expect((await call(PATH)).status).toBe(401);
    expect((await call(PATH, { method: "PUT", body: JSON.stringify({ enabled: true }) })).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("upserts the caller's row on PUT, keyed by (auth_user_id, kind), and rejects non-boolean input", async () => {
    mocks.admin.mockResolvedValueOnce(response([{ auth_user_id: "u-hq", kind: "weekly_customer_health_email", enabled: true }]));
    const on = await call(PATH, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ enabled: true });
    const [method, path, body, prefer] = mocks.admin.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe(`${PREFS}?on_conflict=auth_user_id,kind`);
    expect(body).toEqual([expect.objectContaining({ auth_user_id: "u-hq", kind: "weekly_customer_health_email", enabled: true })]);
    expect(prefer).toContain("merge-duplicates");
    mocks.admin.mockResolvedValueOnce(response([{ enabled: false }]));
    expect(await (await call(PATH, { method: "PUT", body: JSON.stringify({ enabled: false }) })).json()).toEqual({ enabled: false });
    expect((await call(PATH, { method: "PUT", body: JSON.stringify({ enabled: "yes" }) })).status).toBe(400);
    expect((await call(PATH, { method: "PUT", body: JSON.stringify({}) })).status).toBe(400);
    expect(mocks.admin).toHaveBeenCalledTimes(2);
  });

  it("answers 502 when the preference write fails", async () => {
    mocks.admin.mockResolvedValueOnce(response({ message: "boom" }, 500));
    expect((await call(PATH, { method: "PUT", body: JSON.stringify({ enabled: true }) })).status).toBe(502);
  });
});
