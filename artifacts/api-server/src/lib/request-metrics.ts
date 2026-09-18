/**
 * Request timing with stable route labels.
 *
 * Every API response gets a route label (the Express route pattern, so ids
 * never fan the label out) and a route family (the first two path segments,
 * e.g. `hq/system-health`, `patient/diary`, `coach/chat`). Durations land in
 * an in-process histogram per family per minute; closed minutes are flushed
 * to api_request_metrics as one row per (minute, instance, family). The HQ
 * read sums instance rows (hq_request_latency) and estimates p50/p95 from
 * the merged buckets, so the numbers hold across autoscale copies.
 *
 * The histogram boundaries are part of the stored row shape: change them
 * only by adding a new column, never by reinterpreting old rows.
 */
import type { Request } from "express";
import { envInt } from "./env";
import { logger } from "./logger";
import { supabaseAdmin } from "./supabase-admin";
import type { RequestDependencyFlags } from "./request-context";

/** Upper bounds in ms; the last bucket is open-ended. */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, Infinity] as const;

export const UNMATCHED_ROUTE = "unmatched";

/**
 * Families whose responses legitimately stay open for a long time — model
 * streams and photo reads — get a wider budget so their normal duration is
 * not logged as slow or shown red.
 */
export const STREAMING_FAMILIES = new Set([
  "coach/chat",
  "coach/photo",
  "coach/recipe",
  "coach/menu-scan",
  "coach/label-scan",
  "menu-scan",
  "label-scan",
  "support/chat",
  "staff/conversations",
  "internal/jobs",
  "internal/notifications",
  "training/videos",
]);

export interface LatencyBudget {
  amberMs: number;
  redMs: number;
}

/** Amber = worth a look; red = users are waiting. Env knobs blank-check before parsing. */
export function latencyBudget(family: string): LatencyBudget {
  if (STREAMING_FAMILIES.has(family)) {
    return { amberMs: envInt("LATENCY_STREAM_AMBER_MS", 20_000), redMs: envInt("LATENCY_STREAM_RED_MS", 45_000) };
  }
  return { amberMs: envInt("LATENCY_AMBER_MS", 1_500), redMs: envInt("LATENCY_RED_MS", 4_000) };
}

/** Requests slower than the family's amber budget log at warn level. */
export function isSlowRequest(family: string, durationMs: number): boolean {
  return durationMs > latencyBudget(family).amberMs;
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{20,})$/i;

/**
 * Stable label for a finished request: the matched Express route pattern
 * under its mount path (`/api/hq/system-health/jobs/:name/run`). Unmatched
 * requests (404s, preflights) are normalised by replacing id-looking
 * segments, so a scan of random paths cannot mint unbounded labels.
 */
export function routeLabel(req: Pick<Request, "route" | "baseUrl" | "originalUrl" | "method">): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === "string") return `${req.baseUrl ?? ""}${routePath}` || "/";
  if (req.method === "OPTIONS") return "preflight";
  const path = (req.originalUrl ?? "/").split("?")[0] ?? "/";
  const segments = path.split("/").filter(Boolean).map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment));
  return segments.length ? `${UNMATCHED_ROUTE}:/${segments.slice(0, 4).join("/")}` : `${UNMATCHED_ROUTE}:/`;
}

/**
 * Route family: first two labelled segments after `/api`, stopping before
 * a parameter (`/api/patient/diary/:day` → `patient/diary`,
 * `/api/coach/chat` → `coach/chat`, `/api/health` → `health`).
 */
export function routeFamily(label: string): string {
  if (label === "preflight") return "preflight";
  if (label.startsWith(`${UNMATCHED_ROUTE}:`)) return UNMATCHED_ROUTE;
  const segments = label.split("/").filter(Boolean);
  if (segments[0] === "api") segments.shift();
  const named: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(":") || named.length === 2) break;
    named.push(segment);
  }
  return named.length ? named.join("/") : "root";
}

export function bucketIndex(durationMs: number): number {
  for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
    if (durationMs <= LATENCY_BUCKETS_MS[index]!) return index;
  }
  return LATENCY_BUCKETS_MS.length - 1;
}

/**
 * Quantile estimate from bucket counts: linear interpolation inside the
 * bucket that holds the target rank. The open-ended last bucket reports its
 * lower bound (the true value is at least that). Null when there is no data.
 */
export function estimateQuantile(buckets: readonly number[], quantile: number): number | null {
  const total = buckets.reduce((sum, count) => sum + count, 0);
  if (total <= 0) return null;
  const target = Math.max(1, Math.ceil(total * quantile));
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const count = buckets[index] ?? 0;
    if (count <= 0) continue;
    if (seen + count >= target) {
      const lower = index === 0 ? 0 : LATENCY_BUCKETS_MS[index - 1]!;
      const upper = LATENCY_BUCKETS_MS[index]!;
      if (!Number.isFinite(upper)) return lower;
      const within = (target - seen - 0.5) / count;
      return Math.round((lower + (upper - lower) * within) * 10) / 10;
    }
    seen += count;
  }
  return null;
}

export interface MetricRow {
  bucket_start: string;
  instance: string;
  route_family: string;
  requests: number;
  errors: number;
  db_requests: number;
  ai_requests: number;
  total_ms: number;
  max_ms: number;
  buckets: number[];
}

interface Cell {
  requests: number;
  errors: number;
  db: number;
  ai: number;
  totalMs: number;
  maxMs: number;
  buckets: number[];
}

const MINUTE_MS = 60_000;

function minuteStart(at: number): number {
  return at - (at % MINUTE_MS);
}

/**
 * In-memory histogram for one process. `record` is synchronous and cheap;
 * `drain` hands back the closed minutes as rows and forgets them.
 */
export class RequestMetricsRecorder {
  private readonly minutes = new Map<number, Map<string, Cell>>();

  constructor(private readonly instance: string) {}

  record(input: { family: string; status: number; durationMs: number; flags: RequestDependencyFlags; at?: number }): void {
    const minute = minuteStart(input.at ?? Date.now());
    let cells = this.minutes.get(minute);
    if (!cells) {
      cells = new Map();
      this.minutes.set(minute, cells);
    }
    let cell = cells.get(input.family);
    if (!cell) {
      cell = { requests: 0, errors: 0, db: 0, ai: 0, totalMs: 0, maxMs: 0, buckets: LATENCY_BUCKETS_MS.map(() => 0) };
      cells.set(input.family, cell);
    }
    const duration = Math.max(0, input.durationMs);
    cell.requests += 1;
    if (input.status >= 500) cell.errors += 1;
    if (input.flags.db) cell.db += 1;
    if (input.flags.ai) cell.ai += 1;
    cell.totalMs += duration;
    cell.maxMs = Math.max(cell.maxMs, duration);
    cell.buckets[bucketIndex(duration)] += 1;
  }

  /** Rows for every minute that has ended by `now` (or every minute when `includeOpen`). */
  drain(now: number = Date.now(), includeOpen = false): MetricRow[] {
    const current = minuteStart(now);
    const rows: MetricRow[] = [];
    for (const [minute, cells] of [...this.minutes.entries()].sort((a, b) => a[0] - b[0])) {
      if (!includeOpen && minute >= current) continue;
      for (const [family, cell] of cells) {
        rows.push({
          bucket_start: new Date(minute).toISOString(),
          instance: this.instance,
          route_family: family,
          requests: cell.requests,
          errors: cell.errors,
          db_requests: cell.db,
          ai_requests: cell.ai,
          total_ms: Math.round(cell.totalMs * 10) / 10,
          max_ms: Math.round(cell.maxMs * 10) / 10,
          buckets: [...cell.buckets],
        });
      }
      this.minutes.delete(minute);
    }
    return rows;
  }

  get pendingMinutes(): number {
    return this.minutes.size;
  }
}

export type MetricsSink = (rows: MetricRow[]) => Promise<void>;

/** Default sink: one upsert per flush; a closed minute is complete, so replacing is exact. */
export const supabaseMetricsSink: MetricsSink = async (rows) => {
  const result = await supabaseAdmin(
    "POST",
    "/rest/v1/api_request_metrics?on_conflict=bucket_start,instance,route_family",
    rows,
    "resolution=merge-duplicates,return=minimal",
  );
  if (result.status >= 300) throw new Error(`request metrics flush failed (${result.status})`);
};

export interface MetricsFlusher {
  /** Flush closed minutes; `final` also flushes the open minute (shutdown). */
  flush(final?: boolean): Promise<void>;
  /** Called after each recorded request; flushes when a minute has rolled over. */
  poke(): void;
  stop(): void;
}

/**
 * Flushes closed minutes to the sink. A timer covers idle stretches and each
 * recorded request pokes the flusher, so an autoscale copy that only wakes
 * for traffic still lands the previous minute before it pauses again. Rows
 * from a failed flush are held and retried with the next flush exactly once;
 * if that fails too they are dropped (logged) rather than growing memory
 * through an outage.
 */
export function createMetricsFlusher(recorder: RequestMetricsRecorder, options: { sink?: MetricsSink; intervalMs?: number; now?: () => number } = {}): MetricsFlusher {
  const sink = options.sink ?? supabaseMetricsSink;
  const now = options.now ?? (() => Date.now());
  const HELD_ROW_CAP = 5_000;
  let held: MetricRow[] = [];
  let inFlight: Promise<void> | null = null;
  let lastFlushMinute = minuteStart(now());
  const run = async (final: boolean) => {
    const retrying = held;
    held = [];
    const fresh = recorder.drain(now(), final);
    lastFlushMinute = minuteStart(now());
    const rows = [...retrying, ...fresh];
    if (!rows.length) return;
    try {
      await sink(rows);
    } catch (error) {
      if (retrying.length) {
        logger.error({ err: error, dropped: retrying.length }, "request metrics flush failed twice; held rows dropped");
      }
      held = fresh.slice(0, HELD_ROW_CAP);
      if (held.length) logger.warn({ err: error, rows: held.length }, "request metrics flush failed; holding rows for one retry");
    }
  };
  const flush = (final = false) => {
    if (!inFlight) {
      inFlight = run(final).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
  const timer = setInterval(() => {
    void flush(false);
  }, options.intervalMs ?? MINUTE_MS);
  timer.unref();
  return {
    flush,
    poke: () => {
      if (minuteStart(now()) > lastFlushMinute) void flush(false);
    },
    stop: () => clearInterval(timer),
  };
}
