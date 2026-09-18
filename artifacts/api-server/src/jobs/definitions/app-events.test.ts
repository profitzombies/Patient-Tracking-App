import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));

import { BACKFILL_BATCH, appEventsBackfillJob, appEventsRollupJob, backfillAppEvents, rollupAppEvents } from "./app-events";
import type { JobContext } from "../types";

const NOW = new Date("2026-09-18T12:00:00Z");

function ctx(dryRun = false) {
  const counts: Record<string, number> = {};
  const failures: string[] = [];
  const c: JobContext = {
    dryRun,
    now: NOW,
    tally: (k, by = 1) => { counts[k] = (counts[k] ?? 0) + by; },
    failItem: (item) => { failures.push(item); },
    leaseLost: false,
    checkpoint: () => undefined,
    log: () => undefined,
  };
  return { c, counts, failures };
}

describe("app-events rollup job", () => {
  beforeEach(() => { mocks.admin.mockReset(); });

  it("runs every 15 minutes under a lease and passes the run instant and dry-run flag to the database", async () => {
    expect(appEventsRollupJob.intervalMs).toBe(15 * 60_000);
    expect(appEventsRollupJob.leaseSeconds).toBeGreaterThan(60);
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ days_rolled: 2, events_rolled: "1450", days_finalized: 1, dirty_remaining: 0 }] });
    const { c, counts } = ctx();
    await expect(rollupAppEvents(c)).resolves.toEqual({ daysRolled: 2, eventsRolled: 1450, daysFinalized: 1, dirtyRemaining: 0 });
    expect(mocks.admin).toHaveBeenCalledWith("POST", "/rest/v1/rpc/patient_app_events_rollup", { p_now: NOW.toISOString(), p_dry_run: false });
    expect(counts).toEqual({ daysRolled: 2, eventsRolled: 1450, daysFinalized: 1, dirtyRemaining: 0 });
  });

  it("dry runs report would-counts and hand the flag to the database so nothing is written", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 200, json: [{ days_rolled: 3, events_rolled: 9, days_finalized: 2, dirty_remaining: 3 }] });
    const { c, counts } = ctx(true);
    await appEventsRollupJob.run(c);
    expect(mocks.admin.mock.calls[0][2]).toEqual({ p_now: NOW.toISOString(), p_dry_run: true });
    expect(counts).toEqual({ wouldRollDays: 3, wouldRollEvents: 9, wouldFinalizeDays: 2, dirtyRemaining: 3 });
  });

  it("fails the run loudly when the database refuses", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 500, json: { message: "boom" } });
    await expect(rollupAppEvents(ctx().c)).rejects.toThrow("app event rollup failed (500)");
  });
});

describe("app-events backfill job", () => {
  beforeEach(() => { mocks.admin.mockReset(); });

  it("is on-demand only, stops each feature at its first live event, and pages until a short batch", async () => {
    expect(appEventsBackfillJob.intervalMs).toBeNull();
    const backfillCalls: Array<Record<string, unknown>> = [];
    mocks.admin.mockImplementation(async (_method: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("patient_app_event_bounds")) {
        return { status: 200, json: [{ first_live_at: body.p_feature === "food_log" ? "2026-09-18T09:00:00Z" : null }] };
      }
      backfillCalls.push(body);
      if (body.p_feature === "food_log") {
        const nth = backfillCalls.filter((c) => c.p_feature === "food_log").length;
        return { status: 200, json: nth === 1 ? BACKFILL_BATCH : 7 };
      }
      if (body.p_feature === "order") return { status: 503, json: null };
      return { status: 200, json: 0 };
    });
    const { c, counts, failures } = ctx();
    await backfillAppEvents(c);
    const food = backfillCalls.filter((call) => call.p_feature === "food_log");
    expect(food).toHaveLength(2);
    expect(food[0]).toEqual({ p_feature: "food_log", p_before: "2026-09-18T09:00:00Z", p_limit: BACKFILL_BATCH, p_dry_run: false });
    // A feature without a live event yet is bounded by the run instant.
    expect(backfillCalls.find((call) => call.p_feature === "weigh_in")?.p_before).toBe(NOW.toISOString());
    expect(counts.inserted).toBe(BACKFILL_BATCH + 7);
    expect(counts.inserted_food_log).toBe(BACKFILL_BATCH + 7);
    expect(failures).toEqual(["order"]);
    // Every dataset is attempted, including the ones after the failure.
    expect(new Set(backfillCalls.map((call) => call.p_feature)).size).toBe(9);
  });

  it("dry runs probe each feature once with the flag set", async () => {
    mocks.admin.mockImplementation(async (_method: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith("patient_app_event_bounds")) return { status: 200, json: [{ first_live_at: null }] };
      return { status: 200, json: body.p_feature === "coach_message" ? BACKFILL_BATCH : 3 };
    });
    const { c, counts } = ctx(true);
    await backfillAppEvents(c);
    const calls = mocks.admin.mock.calls.filter(([, path]) => String(path).endsWith("patient_app_events_backfill"));
    expect(calls).toHaveLength(9);
    expect(calls.every(([, , body]) => (body as { p_dry_run: boolean }).p_dry_run)).toBe(true);
    expect(counts.wouldInsert).toBe(BACKFILL_BATCH + 8 * 3);
    expect(counts.inserted).toBeUndefined();
  });
});
