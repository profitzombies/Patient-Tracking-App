import { afterEach, describe, expect, it, vi } from "vitest";
import { LATENCY_BUCKETS_MS, bucketIndex } from "../lib/request-metrics";
import { assembleGrowth, latencyFamilyFromRow, readPerformance, type SnapshotRow } from "./performance";
import { evaluateThresholds, levelFor, thresholdConfig, worstLevel } from "./thresholds";

const MB = 1024 * 1024;

function buckets(...durations: number[]): number[] {
  const out = LATENCY_BUCKETS_MS.map(() => 0);
  for (const duration of durations) out[bucketIndex(duration)] += 1;
  return out;
}

describe("thresholds", () => {
  afterEach(() => {
    delete process.env.DB_GROWTH_AMBER_MB;
    delete process.env.LATENCY_MIN_REQUESTS;
  });

  it("levels a value against amber and red limits, treating null as ok", () => {
    expect(levelFor(null, 10, 20)).toBe("ok");
    expect(levelFor(9, 10, 20)).toBe("ok");
    expect(levelFor(10, 10, 20)).toBe("amber");
    expect(levelFor(25, 10, 20)).toBe("red");
  });

  it("reads env knobs with a blank-check and reports the effective config", () => {
    process.env.DB_GROWTH_AMBER_MB = "";
    expect(thresholdConfig().dbGrowth.amberBytesPerDay).toBe(250 * MB);
    process.env.DB_GROWTH_AMBER_MB = "10";
    expect(thresholdConfig().dbGrowth.amberBytesPerDay).toBe(10 * MB);
  });

  it("flags slow families over the hour, skips thin samples, and uses the streaming budget for streams", () => {
    const findings = evaluateThresholds({
      latencyLastHour: [
        { family: "hq/system-health", requests: 40, p95Ms: 1_800 },
        { family: "patient/diary", requests: 3, p95Ms: 9_000 },
        { family: "coach/chat", requests: 40, p95Ms: 12_000 },
        { family: "office/roster", requests: 40, p95Ms: 5_000 },
      ],
      growth: null,
    });
    expect(findings.map((finding) => [finding.family, finding.level])).toEqual([
      ["office/roster", "red"],
      ["hq/system-health", "amber"],
    ]);
    expect(findings[1]?.message).toContain("1500 ms amber limit");
    expect(worstLevel(findings)).toBe("red");
  });

  it("flags database and storage growth per day", () => {
    const findings = evaluateThresholds({
      latencyLastHour: [],
      growth: { databaseBytesPerDay: 300 * MB, storageBytesPerDay: 11 * 1024 * MB },
    });
    expect(findings.map((finding) => [finding.metric, finding.level])).toEqual([
      ["storage_growth", "red"],
      ["db_growth", "amber"],
    ]);
    expect(findings[1]?.message).toBe("Database grew 300.0 MB in a day, above the 250.0 MB per day amber limit.");
    expect(evaluateThresholds({ latencyLastHour: [], growth: { databaseBytesPerDay: null, storageBytesPerDay: -5 * MB } })).toEqual([]);
  });
});

describe("latencyFamilyFromRow", () => {
  it("sums shares and estimates quantiles from the merged buckets", () => {
    const dto = latencyFamilyFromRow({
      route_family: "office/roster",
      requests: "4",
      errors: "1",
      db_requests: "4",
      ai_requests: "0",
      total_ms: 6_400,
      max_ms: 4_500,
      buckets: buckets(200, 300, 1_400, 4_500).map(String),
    });
    expect(dto.requests).toBe(4);
    expect(dto.dbShare).toBe(1);
    expect(dto.aiShare).toBe(0);
    expect(dto.meanMs).toBe(1_600);
    expect(dto.p95Ms).toBeGreaterThanOrEqual(2_500);
    expect(dto.level).toBe("amber");
    expect(dto.streaming).toBe(false);
  });
});

describe("assembleGrowth", () => {
  const rows: SnapshotRow[] = [
    { snapshot_date: "2026-09-17", kind: "database", name: "database", total_bytes: 800 * MB, table_bytes: null, index_bytes: null, row_estimate: null, object_count: null },
    { snapshot_date: "2026-09-17", kind: "storage_total", name: "storage", total_bytes: 40 * 1024 * MB, table_bytes: null, index_bytes: null, row_estimate: null, object_count: 1000 },
    { snapshot_date: "2026-09-17", kind: "table", name: "public.approved_foods", total_bytes: 90 * MB, table_bytes: 60 * MB, index_bytes: 30 * MB, row_estimate: 129_000, object_count: null },
    { snapshot_date: "2026-09-17", kind: "storage", name: "/objects/patient-media/", total_bytes: 30 * 1024 * MB, table_bytes: null, index_bytes: null, row_estimate: null, object_count: 900 },
    { snapshot_date: "2026-09-18", kind: "database", name: "database", total_bytes: String(1100 * MB), table_bytes: null, index_bytes: null, row_estimate: null, object_count: null },
    { snapshot_date: "2026-09-18", kind: "storage_total", name: "storage", total_bytes: 41 * 1024 * MB, table_bytes: null, index_bytes: null, row_estimate: null, object_count: 1010 },
    { snapshot_date: "2026-09-18", kind: "table", name: "public.approved_foods", total_bytes: 95 * MB, table_bytes: 62 * MB, index_bytes: 33 * MB, row_estimate: 130_000, object_count: null },
    { snapshot_date: "2026-09-18", kind: "table", name: "public.new_table", total_bytes: 1 * MB, table_bytes: 1 * MB, index_bytes: 0, row_estimate: 10, object_count: null },
    { snapshot_date: "2026-09-18", kind: "storage", name: "/objects/patient-media/", total_bytes: 31 * 1024 * MB, table_bytes: null, index_bytes: null, row_estimate: null, object_count: 910 },
  ];

  it("computes the daily delta against the previous snapshot and levels it", () => {
    const growth = assembleGrowth(rows, thresholdConfig());
    expect(growth?.latestDate).toBe("2026-09-18");
    expect(growth?.previousDate).toBe("2026-09-17");
    expect(growth?.database).toEqual({ bytes: 1100 * MB, previousBytes: 800 * MB, deltaBytes: 300 * MB, deltaPercent: 37.5, bytesPerDay: 300 * MB, level: "amber" });
    expect(growth?.storage.deltaBytes).toBe(1024 * MB);
    expect(growth?.storage.level).toBe("ok");
    expect(growth?.tables).toEqual([
      { name: "public.approved_foods", totalBytes: 95 * MB, tableBytes: 62 * MB, indexBytes: 33 * MB, rowEstimate: 130_000, deltaBytes: 5 * MB },
      { name: "public.new_table", totalBytes: 1 * MB, tableBytes: 1 * MB, indexBytes: 0, rowEstimate: 10, deltaBytes: null },
    ]);
    expect(growth?.storagePrefixes[0]).toEqual({ name: "/objects/patient-media/", bytes: 31 * 1024 * MB, objectCount: 910, deltaBytes: 1024 * MB });
    expect(growth?.history.map((point) => point.date)).toEqual(["2026-09-17", "2026-09-18"]);
  });

  it("normalises the delta to one day when snapshots are further apart", () => {
    const spaced = rows.map((row) => (row.snapshot_date === "2026-09-17" ? { ...row, snapshot_date: "2026-09-15" } : row));
    const growth = assembleGrowth(spaced, thresholdConfig());
    expect(growth?.database.deltaBytes).toBe(300 * MB);
    expect(growth?.database.bytesPerDay).toBe(100 * MB);
    expect(growth?.database.level).toBe("ok");
  });

  it("is honest with a single snapshot (no delta, no level) and null without any", () => {
    const growth = assembleGrowth(rows.filter((row) => row.snapshot_date === "2026-09-18"), thresholdConfig());
    expect(growth?.previousDate).toBeNull();
    expect(growth?.database.deltaBytes).toBeNull();
    expect(growth?.database.level).toBe("ok");
    expect(assembleGrowth([], thresholdConfig())).toBeNull();
  });
});

describe("readPerformance", () => {
  it("keeps the other sections when one reader fails and evaluates thresholds from what loaded", async () => {
    const onError = vi.fn();
    const result = await readPerformance(new Date("2026-09-18T12:00:00Z"), {
      latency: async () => ({
        lastHour: { since: "x", families: [{ family: "office/roster", streaming: false, requests: 50, errors: 0, dbShare: 1, aiShare: 0, meanMs: 900, p50Ms: 700, p95Ms: 5_000, maxMs: 6_000, level: "red" }] },
        lastDay: { since: "y", families: [] },
      }),
      slowStatements: async () => {
        throw new Error("stats unavailable");
      },
      growth: async () => null,
      onError,
    });
    expect(result.slowStatements).toBeNull();
    expect(result.growth).toBeNull();
    expect(onError).toHaveBeenCalledWith("slowStatements", expect.any(Error));
    expect(result.thresholds.level).toBe("red");
    expect(result.thresholds.findings).toHaveLength(1);
    expect(result.thresholds.config.latency.defaultAmberMs).toBe(1_500);
  });
});
