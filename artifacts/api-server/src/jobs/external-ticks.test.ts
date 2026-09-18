import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));

import {
  EXTERNAL_TICK_STALE_MS,
  createMemoryExternalTickStore,
  externalTickStatus,
  recordExternalTick,
  supabaseExternalTickStore,
  toExternalTriggerHealth,
} from "./external-ticks";

const NOW = new Date("2026-09-18T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const priorEnv = { jobs: process.env.JOBS_DISABLED, notifications: process.env.NOTIFICATIONS_DISABLED };

beforeEach(() => {
  mocks.admin.mockReset();
  delete process.env.JOBS_DISABLED;
  delete process.env.NOTIFICATIONS_DISABLED;
});
afterEach(() => {
  if (priorEnv.jobs === undefined) delete process.env.JOBS_DISABLED; else process.env.JOBS_DISABLED = priorEnv.jobs;
  if (priorEnv.notifications === undefined) delete process.env.NOTIFICATIONS_DISABLED; else process.env.NOTIFICATIONS_DISABLED = priorEnv.notifications;
});

describe("externalTickStatus", () => {
  it("is never without a tick, ok up to exactly five minutes, stale after", () => {
    expect(EXTERNAL_TICK_STALE_MS).toBe(300_000);
    expect(externalTickStatus(null, NOW)).toBe("never");
    expect(externalTickStatus(ago(0), NOW)).toBe("ok");
    expect(externalTickStatus(ago(300_000), NOW)).toBe("ok");
    expect(externalTickStatus(ago(300_001), NOW)).toBe("stale");
    expect(externalTickStatus("not a date", NOW)).toBe("never");
    expect(externalTickStatus(ago(10_000), NOW, 5_000)).toBe("stale");
  });
});

describe("toExternalTriggerHealth", () => {
  it("always lists both kinds in order, filling missing ones as never, and reports this process's timer flags", () => {
    const health = toExternalTriggerHealth(
      [{ kind: "notifications", lastAt: ago(60_000), owner: "api-1", lastResult: "succeeded", summary: { outboxSent: 2 }, error: null }],
      NOW,
    );
    expect(health.staleAfterMs).toBe(300_000);
    expect(health.inProcessTimers).toEqual({ jobs: true, notifications: true });
    expect(health.ticks).toEqual([
      { kind: "jobs", status: "never", lastAt: null, owner: null, lastResult: null, summary: null, error: null },
      { kind: "notifications", status: "ok", lastAt: ago(60_000), owner: "api-1", lastResult: "succeeded", summary: { outboxSent: 2 }, error: null },
    ]);
    process.env.JOBS_DISABLED = "1";
    process.env.NOTIFICATIONS_DISABLED = "true";
    expect(toExternalTriggerHealth([], NOW).inProcessTimers).toEqual({ jobs: false, notifications: false });
    process.env.NOTIFICATIONS_DISABLED = "0";
    expect(toExternalTriggerHealth([], NOW).inProcessTimers).toEqual({ jobs: false, notifications: true });
  });
});

describe("supabaseExternalTickStore", () => {
  it("upserts one row per kind with merge-duplicates and bounded owner/error text", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 201, json: null });
    await supabaseExternalTickStore.record({ kind: "jobs", at: NOW, owner: "x".repeat(200), result: "failed", summary: { jobsRan: 0 }, error: "e".repeat(600) });
    expect(mocks.admin).toHaveBeenCalledTimes(1);
    const [method, path, body, prefer] = mocks.admin.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect(method).toBe("POST");
    expect(path).toBe("/rest/v1/system_external_ticks?on_conflict=kind");
    expect(prefer).toBe("resolution=merge-duplicates,return=minimal");
    expect(body).toMatchObject({ kind: "jobs", last_at: NOW.toISOString(), status: "failed", summary: { jobsRan: 0 }, updated_at: NOW.toISOString() });
    expect((body.owner as string).length).toBe(160);
    expect((body.error as string).length).toBe(500);
    mocks.admin.mockResolvedValueOnce({ status: 201, json: null });
    await supabaseExternalTickStore.record({ kind: "notifications", at: NOW, owner: "api", result: "succeeded", summary: {}, error: null });
    expect((mocks.admin.mock.calls[1][2] as Record<string, unknown>).error).toBeNull();
  });

  it("throws on a non-2xx write or an unreadable list, and maps rows back to records", async () => {
    mocks.admin.mockResolvedValueOnce({ status: 500, json: { message: "boom" } });
    await expect(supabaseExternalTickStore.record({ kind: "jobs", at: NOW, owner: "api", result: "succeeded", summary: {}, error: null })).rejects.toThrow(/500/);
    mocks.admin.mockResolvedValueOnce({ status: 200, json: { not: "an array" } });
    await expect(supabaseExternalTickStore.list()).rejects.toThrow(/read failed/);
    mocks.admin.mockResolvedValueOnce({
      status: 200,
      json: [{ kind: "jobs", last_at: NOW.toISOString(), owner: "api-1", status: "succeeded", summary: { jobsRan: 3, junk: "x" }, error: null }],
    });
    const rows = await supabaseExternalTickStore.list();
    expect(mocks.admin).toHaveBeenLastCalledWith("GET", "/rest/v1/system_external_ticks?select=kind,last_at,owner,status,summary,error&order=kind.asc");
    expect(rows).toEqual([{ kind: "jobs", lastAt: NOW.toISOString(), owner: "api-1", lastResult: "succeeded", summary: { jobsRan: 3 }, error: null }]);
  });
});

describe("recordExternalTick", () => {
  it("never throws: reports false when the store fails and true when it lands", async () => {
    const failing = { record: async () => { throw new Error("ledger down"); }, list: async () => [] };
    await expect(recordExternalTick(failing, { kind: "jobs", at: NOW, owner: "api", result: "succeeded", summary: {}, error: null })).resolves.toBe(false);
    const memory = createMemoryExternalTickStore();
    await expect(recordExternalTick(memory, { kind: "jobs", at: NOW, owner: "api", result: "succeeded", summary: { jobsRan: 1 }, error: null })).resolves.toBe(true);
    await recordExternalTick(memory, { kind: "jobs", at: new Date(NOW.getTime() + 1), owner: "api-2", result: "failed", summary: {}, error: "x" });
    expect(memory.rows.size).toBe(1);
    expect(memory.rows.get("jobs")).toMatchObject({ owner: "api-2", lastResult: "failed" });
    expect((await memory.list()).map((r) => r.kind)).toEqual(["jobs"]);
  });
});
