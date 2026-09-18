import { describe, expect, it, vi } from "vitest";
import {
  LATENCY_BUCKETS_MS,
  RequestMetricsRecorder,
  bucketIndex,
  createMetricsFlusher,
  estimateQuantile,
  isSlowRequest,
  latencyBudget,
  routeFamily,
  routeLabel,
} from "./request-metrics";

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);

describe("route labels and families", () => {
  it("uses the matched route pattern under its mount path, so ids never fan out", () => {
    const label = routeLabel({ route: { path: "/hq/system-health/jobs/:name/run" }, baseUrl: "/api", originalUrl: "/api/hq/system-health/jobs/retention/run", method: "POST" } as never);
    expect(label).toBe("/api/hq/system-health/jobs/:name/run");
    expect(routeFamily(label)).toBe("hq/system-health");
  });

  it("stops the family before the first parameter and after two segments", () => {
    expect(routeFamily("/api/patient/diary/:day")).toBe("patient/diary");
    expect(routeFamily("/api/patient/:patientId/photos")).toBe("patient");
    expect(routeFamily("/api/coach/chat")).toBe("coach/chat");
    expect(routeFamily("/api/health")).toBe("health");
    expect(routeFamily("/api/office/roster/activity")).toBe("office/roster");
  });

  it("normalises unmatched paths and caps their depth", () => {
    const label = routeLabel({ route: undefined, baseUrl: "", originalUrl: "/api/nope/8f0c1a2b-1111-2222-3333-444455556666/x/y/z/w?q=1", method: "GET" } as never);
    expect(label).toBe("unmatched:/api/nope/:id/x");
    expect(routeFamily(label)).toBe("unmatched");
    expect(routeLabel({ route: undefined, baseUrl: "", originalUrl: "/api/x", method: "OPTIONS" } as never)).toBe("preflight");
    expect(routeFamily("preflight")).toBe("preflight");
  });
});

describe("latency budgets", () => {
  it("gives streaming families a wider budget and flags slow requests against it", () => {
    expect(latencyBudget("hq/system-health")).toEqual({ amberMs: 1_500, redMs: 4_000 });
    expect(latencyBudget("coach/chat").amberMs).toBeGreaterThan(latencyBudget("hq/system-health").redMs);
    expect(isSlowRequest("hq/system-health", 1_600)).toBe(true);
    expect(isSlowRequest("coach/chat", 1_600)).toBe(false);
    expect(isSlowRequest("hq/system-health", 200)).toBe(false);
  });
});

describe("histogram", () => {
  it("places durations in the first bucket whose bound they do not exceed", () => {
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(5)).toBe(0);
    expect(bucketIndex(5.1)).toBe(1);
    expect(bucketIndex(1_000)).toBe(7);
    expect(bucketIndex(10_000_000)).toBe(LATENCY_BUCKETS_MS.length - 1);
  });

  it("estimates quantiles by interpolating inside the holding bucket", () => {
    const buckets = LATENCY_BUCKETS_MS.map(() => 0);
    buckets[bucketIndex(30)] = 10; // 25–50 ms
    buckets[bucketIndex(2_000)] = 10; // 1000–2500 ms
    expect(estimateQuantile(buckets, 0.5)).toBe(48.8);
    expect(estimateQuantile(buckets, 0.95)).toBe(2_275);
    expect(estimateQuantile(LATENCY_BUCKETS_MS.map(() => 0), 0.5)).toBeNull();
  });

  it("reports the open-ended bucket as its lower bound", () => {
    const buckets = LATENCY_BUCKETS_MS.map(() => 0);
    buckets[LATENCY_BUCKETS_MS.length - 1] = 3;
    expect(estimateQuantile(buckets, 0.95)).toBe(60_000);
  });
});

describe("RequestMetricsRecorder", () => {
  it("aggregates per minute and family, and drains only closed minutes", () => {
    const recorder = new RequestMetricsRecorder("host:1:abc");
    recorder.record({ family: "hq/system-health", status: 200, durationMs: 120, flags: { db: true, ai: false }, at: T0 + 1_000 });
    recorder.record({ family: "hq/system-health", status: 502, durationMs: 3_000, flags: { db: true, ai: true }, at: T0 + 2_000 });
    recorder.record({ family: "coach/chat", status: 200, durationMs: 12_000, flags: { db: false, ai: true }, at: T0 + 61_000 });
    expect(recorder.drain(T0 + 61_500)).toEqual([
      {
        bucket_start: new Date(T0).toISOString(),
        instance: "host:1:abc",
        route_family: "hq/system-health",
        requests: 2,
        errors: 1,
        db_requests: 2,
        ai_requests: 1,
        total_ms: 3_120,
        max_ms: 3_000,
        buckets: LATENCY_BUCKETS_MS.map((_, index) => (index === bucketIndex(120) || index === bucketIndex(3_000) ? 1 : 0)),
      },
    ]);
    expect(recorder.pendingMinutes).toBe(1);
    expect(recorder.drain(T0 + 61_500, true)).toHaveLength(1);
    expect(recorder.pendingMinutes).toBe(0);
  });
});

describe("createMetricsFlusher", () => {
  it("flushes closed minutes on poke after a rollover, holds failed rows once, then drops them", async () => {
    vi.useFakeTimers();
    try {
      let now = T0 + 5_000;
      const recorder = new RequestMetricsRecorder("i");
      const sink = vi.fn<(rows: unknown[]) => Promise<void>>();
      const flusher = createMetricsFlusher(recorder, { sink, now: () => now, intervalMs: 3_600_000 });
      recorder.record({ family: "health", status: 200, durationMs: 3, flags: { db: false, ai: false }, at: now });
      flusher.poke();
      expect(sink).not.toHaveBeenCalled(); // same minute: nothing closed yet

      now = T0 + 65_000;
      sink.mockRejectedValueOnce(new Error("db down"));
      flusher.poke();
      await vi.advanceTimersByTimeAsync(0);
      expect(sink).toHaveBeenCalledTimes(1);
      expect((sink.mock.calls[0]?.[0] as unknown[]).length).toBe(1);

      // Next flush retries the held row together with the new closed minute.
      recorder.record({ family: "health", status: 200, durationMs: 4, flags: { db: false, ai: false }, at: now });
      now = T0 + 125_000;
      sink.mockRejectedValueOnce(new Error("still down"));
      await flusher.flush();
      expect(sink).toHaveBeenCalledTimes(2);
      expect((sink.mock.calls[1]?.[0] as unknown[]).length).toBe(2);

      // Third flush: the twice-failed row is gone; only the once-failed fresh row remains.
      sink.mockResolvedValueOnce(undefined);
      await flusher.flush();
      expect((sink.mock.calls[2]?.[0] as unknown[]).length).toBe(1);
      flusher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes the open minute only on a final flush", async () => {
    const now = T0 + 10_000;
    const recorder = new RequestMetricsRecorder("i");
    const sink = vi.fn<(rows: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
    const flusher = createMetricsFlusher(recorder, { sink, now: () => now, intervalMs: 3_600_000 });
    recorder.record({ family: "health", status: 200, durationMs: 3, flags: { db: false, ai: false }, at: now });
    await flusher.flush();
    expect(sink).not.toHaveBeenCalled();
    await flusher.flush(true);
    expect(sink).toHaveBeenCalledTimes(1);
    flusher.stop();
  });
});
