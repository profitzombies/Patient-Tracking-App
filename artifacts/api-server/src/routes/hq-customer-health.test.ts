import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import router, { assembleCustomerHealth, officeHealthRowDto, type CustomerHealthResult } from "./hq-customer-health";

let server: http.Server; let base = "";
beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); await new Promise<void>(r => { server = app.listen(0, () => r()); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
afterAll(() => server.close());
function response(json: unknown, status = 200) { return { status, json, contentRange: null }; }
async function call(path: string) { return fetch(base + path, { headers: { authorization: "Bearer t" } }); }
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
    mocks.admin.mockResolvedValueOnce(response([]));
    expect((await call("/hq/customer-health")).status).toBe(200);
  });

  it("calls the aggregate as of today, drops offboarding offices, and returns ranked rows, counts, attention and definitions", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string, body: Record<string, unknown>) => {
      expect(method).toBe("POST");
      expect(path).toBe("/rest/v1/rpc/office_customer_health");
      expect(body.p_as_of).toBe("2026-10-09");
      return response([
        row("a", { last_paid_order_at: ago(5), active_subscribers: "10", app_users: 25, active_app_users_30d: 25, staff_enrolled: 3 }),
        row("b", { last_paid_order_at: ago(75), app_users: 10, active_app_users_30d: 2, active_app_users_prior_30d: 6 }),
        row("c", { offboarding_status: "offboarding", last_paid_order_at: ago(1) }),
        row("d", { offboarding_status: "offboarded", access_disabled: true }),
        row("e", { created_at: ago(10) }),
        row("f", { last_paid_order_at: ago(500), cancelling_subscriptions: 2, active_subscribers: 2 }),
      ]);
    });
    const res = await call("/hq/customer-health");
    expect(res.status).toBe(200);
    const json = (await res.json()) as CustomerHealthResult;
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
