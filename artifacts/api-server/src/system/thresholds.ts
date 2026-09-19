/**
 * Simple thresholds for the HQ System health performance panels.
 *
 * One pure evaluator feeds the page colours and the HQ threshold alert job,
 * so the two can never disagree. Levels: ok → amber ("worth a look") → red
 * ("act now"). Every limit is an env knob (blank-checked; see lib/env.ts)
 * and the effective values are returned with the findings so the page can
 * print what it is comparing against.
 */
import { envInt } from "../lib/env";
import { latencyBudget } from "../lib/request-metrics";

export type ThresholdLevel = "ok" | "amber" | "red";
export type ThresholdMetric = "p95_latency" | "db_growth" | "storage_growth" | "warehouse_poll" | "cold_archive";

export interface ThresholdFinding {
  metric: ThresholdMetric;
  level: Exclude<ThresholdLevel, "ok">;
  /** Route family for latency findings; null for growth. */
  family: string | null;
  /** Observed value: ms for latency, bytes per day for growth, minutes since the last successful poll for the warehouse feed, consecutive failed runs (red) or pending days (amber) for the cold archive. */
  value: number;
  /** The limit that was crossed, in the same unit. */
  limit: number;
  message: string;
}

export interface GrowthThresholds {
  amberBytesPerDay: number;
  redBytesPerDay: number;
}

export interface ThresholdConfig {
  latency: { defaultAmberMs: number; defaultRedMs: number; streamingAmberMs: number; streamingRedMs: number; minRequests: number };
  dbGrowth: GrowthThresholds;
  storageGrowth: GrowthThresholds;
}

const MB = 1024 * 1024;

export function thresholdConfig(): ThresholdConfig {
  const plain = latencyBudget("hq/system-health");
  const streaming = latencyBudget("coach/chat");
  return {
    latency: {
      defaultAmberMs: plain.amberMs,
      defaultRedMs: plain.redMs,
      streamingAmberMs: streaming.amberMs,
      streamingRedMs: streaming.redMs,
      minRequests: envInt("LATENCY_MIN_REQUESTS", 20),
    },
    dbGrowth: {
      amberBytesPerDay: envInt("DB_GROWTH_AMBER_MB", 250) * MB,
      redBytesPerDay: envInt("DB_GROWTH_RED_MB", 1024) * MB,
    },
    storageGrowth: {
      amberBytesPerDay: envInt("STORAGE_GROWTH_AMBER_MB", 2048) * MB,
      redBytesPerDay: envInt("STORAGE_GROWTH_RED_MB", 10240) * MB,
    },
  };
}

export function levelFor(value: number | null, amber: number, red: number): ThresholdLevel {
  if (value === null || !Number.isFinite(value)) return "ok";
  if (value >= red) return "red";
  if (value >= amber) return "amber";
  return "ok";
}

export interface LatencyFamilyInput {
  family: string;
  requests: number;
  p95Ms: number | null;
}

/** Warehouse status feed freshness (see billing/warehouse-status-sync.ts); null when the feed has never polled. */
export interface WarehousePollInput {
  lastSuccessAt: string | null;
  lastPollAt: string | null;
  stalledAfterMinutes: number;
  lastError: string | null;
}

/** Cold archive job health (see lib/cold-archive.ts); null when the ledger could not be read. */
export interface ColdArchiveInput {
  enabled: boolean;
  storageConfigured: boolean;
  /** Failed runs in a row on the cold-archive job state. */
  consecutiveFailures: number;
  daysPending: number;
  lastError: string | null;
}

/** Consecutive failed cold-archive runs that turn red (the nightly job has missed more than one night). */
export const COLD_ARCHIVE_FAILURES_RED = 2;
/** Closed days still pending that turn amber once the archive is on (a healthy nightly job keeps this near zero after the initial catch-up). */
export const COLD_ARCHIVE_BACKLOG_AMBER_DAYS = 45;

export interface GrowthInput {
  /** Bytes added since the previous daily snapshot, normalised to one day; null when there is no previous day. */
  databaseBytesPerDay: number | null;
  storageBytesPerDay: number | null;
}

export function formatBytesShort(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (abs >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Latency findings use the last hour; families under `minRequests` are skipped (too few samples to call slow). */
export function evaluateThresholds(input: { latencyLastHour: LatencyFamilyInput[]; growth: GrowthInput | null; warehousePoll?: WarehousePollInput | null; coldArchive?: ColdArchiveInput | null; now?: Date }, config: ThresholdConfig = thresholdConfig()): ThresholdFinding[] {
  const findings: ThresholdFinding[] = [];
  // The cold archive only counts while HQ has it on: repeated failed runs are
  // red (nights are being missed), a backlog past the limit is amber (the
  // job runs but is not keeping up). Off = no finding, whatever the ledger says.
  if (input.coldArchive && input.coldArchive.enabled) {
    const archive = input.coldArchive;
    if (archive.consecutiveFailures >= COLD_ARCHIVE_FAILURES_RED) {
      findings.push({
        metric: "cold_archive", level: "red", family: null, value: archive.consecutiveFailures, limit: COLD_ARCHIVE_FAILURES_RED,
        message: `The cold archive job has failed ${archive.consecutiveFailures} runs in a row (limit ${COLD_ARCHIVE_FAILURES_RED}); ${archive.daysPending} day${archive.daysPending === 1 ? "" : "s"} pending.${archive.lastError ? ` Last error: ${archive.lastError}` : ""}`,
      });
    } else if (archive.daysPending > COLD_ARCHIVE_BACKLOG_AMBER_DAYS) {
      findings.push({
        metric: "cold_archive", level: "amber", family: null, value: archive.daysPending, limit: COLD_ARCHIVE_BACKLOG_AMBER_DAYS,
        message: `The cold archive is ${archive.daysPending} days behind (limit ${COLD_ARCHIVE_BACKLOG_AMBER_DAYS}).`,
      });
    }
  }
  // A dead warehouse feed is red once no poll has succeeded for longer than
  // the stalled limit (only after at least one poll ran: a never-configured
  // feed is not an outage).
  if (input.warehousePoll && input.warehousePoll.lastPollAt) {
    const now = input.now ?? new Date();
    const limit = input.warehousePoll.stalledAfterMinutes;
    const sinceMinutes = input.warehousePoll.lastSuccessAt
      ? Math.floor((now.getTime() - new Date(input.warehousePoll.lastSuccessAt).getTime()) / 60_000)
      : Math.floor((now.getTime() - new Date(input.warehousePoll.lastPollAt).getTime()) / 60_000);
    if (sinceMinutes > limit) {
      findings.push({
        metric: "warehouse_poll", level: "red", family: null, value: sinceMinutes, limit,
        message: input.warehousePoll.lastSuccessAt
          ? `The WarehouseCraft status feed has not synced successfully for ${sinceMinutes} minutes (limit ${limit}).${input.warehousePoll.lastError ? ` Last error: ${input.warehousePoll.lastError}` : ""}`
          : `The WarehouseCraft status feed has never synced successfully; the first poll ran ${sinceMinutes} minutes ago (limit ${limit}).${input.warehousePoll.lastError ? ` Last error: ${input.warehousePoll.lastError}` : ""}`,
      });
    }
  }
  for (const family of input.latencyLastHour) {
    if (family.requests < config.latency.minRequests || family.p95Ms === null) continue;
    const budget = latencyBudget(family.family);
    const level = levelFor(family.p95Ms, budget.amberMs, budget.redMs);
    if (level === "ok") continue;
    const limit = level === "red" ? budget.redMs : budget.amberMs;
    findings.push({
      metric: "p95_latency",
      level,
      family: family.family,
      value: family.p95Ms,
      limit,
      message: `${family.family}: p95 ${Math.round(family.p95Ms)} ms over the last hour (${family.requests} requests) is above the ${limit} ms ${level} limit.`,
    });
  }
  if (input.growth) {
    const growthFinding = (metric: ThresholdMetric, label: string, value: number | null, limits: GrowthThresholds) => {
      const level = levelFor(value, limits.amberBytesPerDay, limits.redBytesPerDay);
      if (level === "ok" || value === null) return;
      const limit = level === "red" ? limits.redBytesPerDay : limits.amberBytesPerDay;
      findings.push({
        metric,
        level,
        family: null,
        value,
        limit,
        message: `${label} grew ${formatBytesShort(value)} in a day, above the ${formatBytesShort(limit)} per day ${level} limit.`,
      });
    };
    growthFinding("db_growth", "Database", input.growth.databaseBytesPerDay, config.dbGrowth);
    growthFinding("storage_growth", "Object storage", input.growth.storageBytesPerDay, config.storageGrowth);
  }
  return findings.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1));
}

export function worstLevel(findings: readonly ThresholdFinding[]): ThresholdLevel {
  if (findings.some((finding) => finding.level === "red")) return "red";
  if (findings.length) return "amber";
  return "ok";
}
