import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), listObjects: vi.fn() }));
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: mocks.admin }));
vi.mock("../../lib/objectStorage", () => ({ objectStorage: { listObjects: mocks.listObjects } }));

import { RECONCILE_PREFIXES } from "./reconcile-storage";
import { buildSnapshotRows, dataGrowthSnapshotJob, runDataGrowthSnapshot } from "./data-growth-snapshot";
import type { JobContext } from "../types";

const MB = 1024 * 1024;
const RELATIONS = [
  { schema_name: "public", table_name: "approved_foods", total_bytes: "94371840", table_bytes: "62914560", index_bytes: "31457280", toast_bytes: "0", row_estimate: "129000", database_bytes: "914358272" },
  { schema_name: "public", table_name: "diary_entries", total_bytes: 40 * MB, table_bytes: 30 * MB, index_bytes: 10 * MB, toast_bytes: 0, row_estimate: 50_000, database_bytes: "914358272" },
];

function ctx(dryRun = false) {
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const tallies: Record<string, number> = {};
  const failures: string[] = [];
  const context: JobContext = {
    dryRun,
    now: new Date("2026-09-18T03:00:00Z"),
    tally: (key: string, by: number = 1) => { tallies[key] = (tallies[key] ?? 0) + by; },
    failItem: (item: string) => { failures.push(item); },
    log: (event: string, detail?: Record<string, unknown>) => { logs.push({ event, detail }); },
    checkpoint: () => undefined,
    leaseLost: false,
  };
  return { context, logs, tallies, failures };
}

describe("buildSnapshotRows", () => {
  it("emits one database row, one row per table, one per storage prefix, and the storage total", () => {
    const rows = buildSnapshotRows({
      date: "2026-09-18",
      capturedAt: "2026-09-18T03:00:00.000Z",
      relations: RELATIONS,
      storage: [{ prefix: "/objects/a/", bytes: 10 * MB, objects: 4 }, { prefix: "/objects/b/", bytes: 5 * MB, objects: 1 }],
    });
    expect(rows.map((row) => [row.kind, row.name, row.total_bytes])).toEqual([
      ["database", "database", 914358272],
      ["table", "public.approved_foods", 94371840],
      ["table", "public.diary_entries", 40 * MB],
      ["storage", "/objects/a/", 10 * MB],
      ["storage", "/objects/b/", 5 * MB],
      ["storage_total", "storage", 15 * MB],
    ]);
    expect(rows[1]).toMatchObject({ table_bytes: 62914560, index_bytes: 31457280, toast_bytes: 0, row_estimate: 129000, object_count: null, snapshot_date: "2026-09-18" });
    expect(rows[5]).toMatchObject({ object_count: 5 });
  });
});

describe("data-growth-snapshot job", () => {
  beforeEach(() => {
    mocks.admin.mockReset();
    mocks.listObjects.mockReset();
    mocks.listObjects.mockImplementation(async (prefix: string) => [{ path: `${prefix}x`, sizeBytes: 2 * MB }, { path: `${prefix}y`, sizeBytes: 1 * MB }]);
  });

  it("upserts today's rows and trims snapshots past 400 days and request metrics past a week", async () => {
    mocks.admin.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/rest/v1/rpc/hq_relation_sizes")) return { status: 200, json: RELATIONS };
      if (method === "DELETE") return { status: 200, json: [{}, {}] };
      return { status: 201, json: null };
    });
    const { context, tallies, failures } = ctx();
    await runDataGrowthSnapshot(context);
    expect(failures).toEqual([]);
    const upsert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && String(path).startsWith("/rest/v1/system_size_snapshots"));
    expect(upsert?.[1]).toBe("/rest/v1/system_size_snapshots?on_conflict=snapshot_date,kind,name");
    expect(upsert?.[3]).toBe("resolution=merge-duplicates,return=minimal");
    const rows = upsert?.[2] as Array<{ kind: string; total_bytes: number; object_count: number | null }>;
    expect(rows).toHaveLength(1 + RELATIONS.length + RECONCILE_PREFIXES.length + 1);
    const total = rows.find((row) => row.kind === "storage_total");
    expect(total).toMatchObject({ total_bytes: 3 * MB * RECONCILE_PREFIXES.length, object_count: 2 * RECONCILE_PREFIXES.length });
    const deletes = mocks.admin.mock.calls.filter(([method]) => method === "DELETE").map(([, path]) => String(path));
    expect(deletes).toEqual([
      "/rest/v1/system_size_snapshots?snapshot_date=lt.2025-08-14",
      `/rest/v1/api_request_metrics?bucket_start=lt.${encodeURIComponent("2026-09-11T03:00:00.000Z")}`,
    ]);
    expect(tallies).toMatchObject({ tablesMeasured: 2, storagePrefixesMeasured: RECONCILE_PREFIXES.length, rowsWritten: rows.length, snapshotsTrimmed: 2, requestMetricRowsTrimmed: 2 });
  });

  it("dry runs measure and log but write and delete nothing", async () => {
    mocks.admin.mockResolvedValue({ status: 200, json: RELATIONS });
    const { context, logs, tallies } = ctx(true);
    await runDataGrowthSnapshot(context);
    expect(mocks.admin.mock.calls.map(([method]) => method)).toEqual(["POST"]);
    expect(logs[0]).toMatchObject({ event: "data_growth_snapshot", detail: { dryRun: true, tables: 2, databaseBytes: 914358272 } });
    expect(tallies.rowsWouldWrite).toBeGreaterThan(0);
    expect(tallies.rowsWritten).toBeUndefined();
  });

  it("fails an unlistable prefix as an item and withholds the storage total for the day", async () => {
    mocks.listObjects.mockImplementation(async (prefix: string) => {
      if (prefix === RECONCILE_PREFIXES[0]) throw new Error("listing refused");
      return [{ path: `${prefix}x`, sizeBytes: MB }];
    });
    mocks.admin.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith("/rest/v1/rpc/hq_relation_sizes")) return { status: 200, json: RELATIONS };
      return { status: method === "DELETE" ? 200 : 201, json: [] };
    });
    const { context, failures } = ctx();
    await runDataGrowthSnapshot(context);
    expect(failures).toEqual([RECONCILE_PREFIXES[0]]);
    const upsert = mocks.admin.mock.calls.find(([method, path]) => method === "POST" && String(path).startsWith("/rest/v1/system_size_snapshots"));
    const kinds = (upsert?.[2] as Array<{ kind: string }>).map((row) => row.kind);
    expect(kinds).not.toContain("storage_total");
    expect(kinds.filter((kind) => kind === "storage")).toHaveLength(RECONCILE_PREFIXES.length - 1);
  });

  it("fails the run when table sizes cannot be read", async () => {
    mocks.admin.mockResolvedValue({ status: 500, json: null });
    await expect(runDataGrowthSnapshot(ctx().context)).rejects.toThrow(/relation sizes read failed \(500\)/);
  });

  it("runs daily", () => {
    expect(dataGrowthSnapshotJob).toMatchObject({ name: "data-growth-snapshot", intervalMs: 86_400_000 });
  });
});
