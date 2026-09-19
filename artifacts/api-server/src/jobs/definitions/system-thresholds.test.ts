import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));

import type { JobContext } from "../types";
import type { LatencyFamilyDto } from "../../system/performance";
import { buildThresholdNotifications, runSystemThresholds, systemThresholdsJob, thresholdDedupeKey } from "./system-thresholds";

const NOW = new Date("2026-09-18T12:15:00Z");
const MB = 1024 * 1024;

function family(name: string, p95Ms: number, requests = 60): LatencyFamilyDto {
  return { family: name, streaming: false, requests, errors: 0, dbShare: 1, aiShare: 0, meanMs: p95Ms / 2, p50Ms: p95Ms / 2, p95Ms, maxMs: p95Ms * 2, level: "ok" };
}

function ctx(dryRun = false) {
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const tallies: Record<string, number> = {};
  const failures: string[] = [];
  const context: JobContext = {
    dryRun,
    now: NOW,
    tally: (key: string, by: number = 1) => { tallies[key] = (tallies[key] ?? 0) + by; },
    failItem: (item: string) => { failures.push(item); },
    log: (event: string, detail?: Record<string, unknown>) => { logs.push({ event, detail }); },
    checkpoint: () => undefined,
    leaseLost: false,
  };
  return { context, logs, tallies, failures };
}

const recipients = [
  { auth_user_id: "u1", email: "one@example.com", display_name: "One Admin" },
  { auth_user_id: "u2", email: null, display_name: null },
];

const readers = {
  latency: async () => ({
    lastHour: { since: "h", families: [family("office/roster", 4_500), family("health", 20), family("patient/diary", 9_000, 2)] },
    lastDay: { since: "d", families: [] },
  }),
  slowStatements: async () => ({ statsResetAt: null, byTotal: [], byMean: [] }),
  growth: async () => null,
  warehousePoll: async () => null,
  coldArchive: async () => null,
};

describe("system-thresholds job", () => {
  beforeEach(() => mocks.admin.mockReset());

  it("queues one email per finding and recipient with a per-metric, level, and day dedupe key", async () => {
    mocks.admin.mockResolvedValue({ status: 201, json: [{ id: "n1" }] });
    const { context, tallies, logs } = ctx();
    await runSystemThresholds(context, { readers, recipients: async () => recipients });
    expect(logs[0]).toMatchObject({ event: "system_thresholds", detail: { level: "red" } });
    expect(tallies).toMatchObject({ findings: 1, redFindings: 1, alertsQueued: 1 });
    const [method, path, rows, prefer] = mocks.admin.mock.calls[0]!;
    expect([method, path, prefer]).toEqual(["POST", "/rest/v1/staff_notifications?on_conflict=dedupe_key", "resolution=ignore-duplicates,return=representation"]);
    expect(rows).toEqual([
      expect.objectContaining({
        provider_id: null,
        auth_user_id: "u1",
        channel: "email",
        email: "one@example.com",
        kind: "system_threshold",
        category: "staff_alerts",
        title: "Red: Slow route office/roster",
        dedupe_key: "system_threshold:p95_latency:office/roster:red:2026-09-18:u1:email",
        expires_at: "2026-09-19T12:15:00.000Z",
        data: expect.objectContaining({ metric: "p95_latency", level: "red", family: "office/roster", value: 4_500, limit: 4_000, recipientName: "One Admin" }),
      }),
    ]);
  });

  it("never queues a push row and skips recipients without an email", () => {
    const rows = buildThresholdNotifications({
      now: NOW,
      recipients,
      findings: [{ metric: "db_growth", level: "amber", family: null, value: 300 * MB, limit: 250 * MB, message: "Database grew 300.0 MB in a day." }],
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.channel === "email")).toBe(true);
    expect(thresholdDedupeKey({ metric: "db_growth", level: "amber", family: null, value: 0, limit: 0, message: "" }, "2026-09-18", "u1")).toBe("system_threshold:db_growth:-:amber:2026-09-18:u1:email");
  });

  it("queues nothing when every metric is within limits", async () => {
    const { context, tallies } = ctx();
    await runSystemThresholds(context, {
      readers: { ...readers, latency: async () => ({ lastHour: { since: "h", families: [family("office/roster", 400)] }, lastDay: { since: "d", families: [] } }) },
      recipients: async () => { throw new Error("recipients must not be read"); },
    });
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(tallies).toEqual({ findings: 0, redFindings: 0 });
  });

  it("dry runs evaluate and count but queue nothing", async () => {
    const { context, tallies } = ctx(true);
    await runSystemThresholds(context, { readers, recipients: async () => recipients });
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(tallies).toMatchObject({ findings: 1, alertsWouldQueue: 1 });
  });

  it("records an unreadable section as an item failure and still evaluates the rest", async () => {
    mocks.admin.mockResolvedValue({ status: 201, json: [{ id: "n1" }] });
    const { context, failures, tallies } = ctx();
    await runSystemThresholds(context, {
      readers: { ...readers, growth: async () => { throw new Error("snapshots unavailable"); } },
      recipients: async () => recipients,
    });
    expect(failures).toEqual(["growth"]);
    expect(tallies.alertsQueued).toBe(1);
  });

  it("raises a red HQ alert when the warehouse status feed has not synced for over the limit", async () => {
    mocks.admin.mockResolvedValue({ status: 201, json: [{ id: "n1" }] });
    const { context, tallies } = ctx();
    await runSystemThresholds(context, {
      readers: {
        ...readers, latency: async () => ({ lastHour: { since: "h", families: [] }, lastDay: { since: "d", families: [] } }),
        warehousePoll: async () => ({ lastSuccessAt: "2026-09-18T09:00:00.000Z", lastPollAt: "2026-09-18T12:00:00.000Z", stalledAfterMinutes: 60, lastError: "HTTP 503" }),
      },
      recipients: async () => recipients,
    });
    expect(tallies).toMatchObject({ findings: 1, redFindings: 1, alertsQueued: 1 });
    const rows = mocks.admin.mock.calls[0]![2] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      title: "Red: Warehouse status feed stalled",
      dedupe_key: "system_threshold:warehouse_poll:-:red:2026-09-18:u1:email",
      data: expect.objectContaining({ metric: "warehouse_poll", limit: 60, message: expect.stringContaining("Last error: HTTP 503") }),
    });
  });

  it("raises a red HQ alert when the cold archive job keeps failing, and stays quiet while HQ has the archive off", async () => {
    mocks.admin.mockResolvedValue({ status: 201, json: [{ id: "n1" }] });
    const quietLatency = async () => ({ lastHour: { since: "h", families: [] }, lastDay: { since: "d", families: [] } });
    const failing = { enabled: true, storageConfigured: true, consecutiveFailures: 2, daysPending: 4, lastError: "storage returned 503" };
    const off = ctx();
    await runSystemThresholds(off.context, {
      readers: { ...readers, latency: quietLatency, coldArchive: async () => ({ ...failing, enabled: false }) },
      recipients: async () => { throw new Error("recipients must not be read"); },
    });
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(off.tallies).toEqual({ findings: 0, redFindings: 0 });

    const { context, tallies } = ctx();
    await runSystemThresholds(context, { readers: { ...readers, latency: quietLatency, coldArchive: async () => failing }, recipients: async () => recipients });
    expect(tallies).toMatchObject({ findings: 1, redFindings: 1, alertsQueued: 1 });
    const rows = mocks.admin.mock.calls[0]![2] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      dedupe_key: "system_threshold:cold_archive:-:red:2026-09-18:u1:email",
      data: expect.objectContaining({ metric: "cold_archive", level: "red", value: 2, limit: 2, message: expect.stringContaining("4 days pending. Last error: storage returned 503") }),
    });
    expect(rows[0]!.title).toBe("Red: Cold archive failing");
  });

  it("runs every 15 minutes", () => {
    expect(systemThresholdsJob).toMatchObject({ name: "system-thresholds", intervalMs: 900_000 });
  });
});
