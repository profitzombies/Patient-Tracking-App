/**
 * HQ System health → performance: request latency per route family, the
 * heaviest database statements, and table/storage growth.
 *
 * Each section reads independently and degrades to null on failure so one
 * broken source never blanks the others (the page prints "unavailable" for
 * a null section, never a healthy-looking zero). Thresholds are evaluated
 * here from the same numbers the page shows.
 */
import { supabaseAdmin } from "../lib/supabase-admin";
import { estimateQuantile, latencyBudget, STREAMING_FAMILIES } from "../lib/request-metrics";
import { warehouseSyncHealth } from "../billing/warehouse-status-sync";
import { withLiveBillingScope } from "../billing/lifecycle-scopes";
import { evaluateThresholds, levelFor, thresholdConfig, worstLevel, type ColdArchiveInput, type ThresholdConfig, type ThresholdFinding, type ThresholdLevel, type WarehousePollInput } from "./thresholds";
import { readColdArchiveHealth } from "../lib/cold-archive";
import { supabaseJobStore } from "../jobs/store";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface LatencyFamilyDto {
  family: string;
  streaming: boolean;
  requests: number;
  errors: number;
  dbShare: number;
  aiShare: number;
  meanMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
  level: ThresholdLevel;
}

export interface LatencyWindowDto {
  since: string;
  families: LatencyFamilyDto[];
}

export interface SlowStatementDto {
  queryId: string;
  role: string | null;
  query: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  maxMs: number;
  rows: number;
  sharedBlocksRead: number;
}

export interface SlowStatementsDto {
  statsResetAt: string | null;
  byTotal: SlowStatementDto[];
  byMean: SlowStatementDto[];
}

export interface GrowthSeriesDto {
  bytes: number;
  previousBytes: number | null;
  deltaBytes: number | null;
  deltaPercent: number | null;
  /** Delta normalised to one day (snapshots can be more than a day apart after a missed run). */
  bytesPerDay: number | null;
  level: ThresholdLevel;
}

export interface TableGrowthDto {
  name: string;
  totalBytes: number;
  tableBytes: number | null;
  indexBytes: number | null;
  rowEstimate: number | null;
  deltaBytes: number | null;
}

export interface GrowthHistoryPointDto {
  date: string;
  databaseBytes: number | null;
  storageBytes: number | null;
}

export interface GrowthDto {
  latestDate: string;
  previousDate: string | null;
  database: GrowthSeriesDto;
  storage: GrowthSeriesDto;
  tables: TableGrowthDto[];
  storagePrefixes: Array<{ name: string; bytes: number; objectCount: number | null; deltaBytes: number | null }>;
  history: GrowthHistoryPointDto[];
}

export interface PerformanceDto {
  asOf: string;
  latency: { lastHour: LatencyWindowDto; lastDay: LatencyWindowDto } | null;
  slowStatements: SlowStatementsDto | null;
  growth: GrowthDto | null;
  thresholds: { level: ThresholdLevel; config: ThresholdConfig; findings: ThresholdFinding[] };
}

interface LatencyRow {
  route_family: string;
  requests: number | string;
  errors: number | string;
  db_requests: number | string;
  ai_requests: number | string;
  total_ms: number;
  max_ms: number;
  buckets: Array<number | string>;
}

function ok(result: { status: number }, label: string): void {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}

function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0;
}

export function latencyFamilyFromRow(row: LatencyRow): LatencyFamilyDto {
  const requests = Number(row.requests);
  const buckets = row.buckets.map((count) => Number(count));
  const p95 = estimateQuantile(buckets, 0.95);
  const budget = latencyBudget(row.route_family);
  return {
    family: row.route_family,
    streaming: STREAMING_FAMILIES.has(row.route_family),
    requests,
    errors: Number(row.errors),
    dbShare: share(Number(row.db_requests), requests),
    aiShare: share(Number(row.ai_requests), requests),
    meanMs: requests > 0 ? Math.round((Number(row.total_ms) / requests) * 10) / 10 : null,
    p50Ms: estimateQuantile(buckets, 0.5),
    p95Ms: p95,
    maxMs: Number(row.max_ms),
    level: levelFor(p95, budget.amberMs, budget.redMs),
  };
}

export async function readLatencyWindow(since: Date): Promise<LatencyWindowDto> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_request_latency", { p_since: since.toISOString() });
  ok(result, "request latency read");
  const rows = Array.isArray(result.json) ? (result.json as LatencyRow[]) : [];
  return { since: since.toISOString(), families: rows.map(latencyFamilyFromRow) };
}

export async function readLatency(now: Date): Promise<{ lastHour: LatencyWindowDto; lastDay: LatencyWindowDto }> {
  const [lastHour, lastDay] = await Promise.all([
    readLatencyWindow(new Date(now.getTime() - HOUR_MS)),
    readLatencyWindow(new Date(now.getTime() - DAY_MS)),
  ]);
  return { lastHour, lastDay };
}

interface StatementRow {
  query_id: string | number;
  role_name: string | null;
  query: string;
  calls: number | string;
  total_ms: number;
  mean_ms: number;
  max_ms: number;
  rows_returned: number | string;
  shared_blks_read: number | string;
  stats_reset: string | null;
}

function statementDto(row: StatementRow): SlowStatementDto {
  return {
    queryId: String(row.query_id),
    role: row.role_name,
    query: row.query,
    calls: Number(row.calls),
    totalMs: Math.round(Number(row.total_ms) * 10) / 10,
    meanMs: Math.round(Number(row.mean_ms) * 100) / 100,
    maxMs: Math.round(Number(row.max_ms) * 10) / 10,
    rows: Number(row.rows_returned),
    sharedBlocksRead: Number(row.shared_blks_read),
  };
}

export async function readSlowStatements(limit = 15): Promise<SlowStatementsDto> {
  const [total, mean] = await Promise.all([
    supabaseAdmin("POST", "/rest/v1/rpc/hq_slow_statements", { p_limit: limit, p_order: "total" }),
    supabaseAdmin("POST", "/rest/v1/rpc/hq_slow_statements", { p_limit: limit, p_order: "mean" }),
  ]);
  ok(total, "slow statements read");
  ok(mean, "slow statements read");
  const totalRows = Array.isArray(total.json) ? (total.json as StatementRow[]) : [];
  const meanRows = Array.isArray(mean.json) ? (mean.json as StatementRow[]) : [];
  return {
    statsResetAt: totalRows[0]?.stats_reset ?? meanRows[0]?.stats_reset ?? null,
    byTotal: totalRows.map(statementDto),
    byMean: meanRows.map(statementDto),
  };
}

export interface SnapshotRow {
  snapshot_date: string;
  kind: "database" | "table" | "storage" | "storage_total";
  name: string;
  total_bytes: number | string;
  table_bytes: number | string | null;
  index_bytes: number | string | null;
  row_estimate: number | string | null;
  object_count: number | string | null;
}

function daysBetween(later: string, earlier: string): number {
  return Math.max(1, Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS));
}

function series(latest: number | null, previous: number | null, days: number, amber: number, red: number): GrowthSeriesDto {
  const bytes = latest ?? 0;
  const delta = latest !== null && previous !== null ? latest - previous : null;
  const perDay = delta === null ? null : Math.round(delta / days);
  return {
    bytes,
    previousBytes: previous,
    deltaBytes: delta,
    deltaPercent: delta !== null && previous ? Math.round((delta / previous) * 1000) / 10 : null,
    bytesPerDay: perDay,
    level: levelFor(perDay, amber, red),
  };
}

/**
 * Pure assembly from snapshot rows (latest day, the day before it, and the
 * database/storage totals for the history range). Exported for tests.
 */
export function assembleGrowth(rows: SnapshotRow[], config: ThresholdConfig, tableLimit = 25): GrowthDto | null {
  const dates = [...new Set(rows.map((row) => row.snapshot_date))].sort();
  const latestDate = dates[dates.length - 1];
  if (!latestDate) return null;
  const previousDate = dates.length > 1 ? dates[dates.length - 2]! : null;
  const days = previousDate ? daysBetween(latestDate, previousDate) : 1;
  const byDate = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.snapshot_date) ?? [];
    list.push(row);
    byDate.set(row.snapshot_date, list);
  }
  const pick = (date: string | null, kind: SnapshotRow["kind"], name?: string) =>
    date ? (byDate.get(date) ?? []).find((row) => row.kind === kind && (name === undefined || row.name === name)) ?? null : null;
  const num = (value: number | string | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));
  const latestDb = num(pick(latestDate, "database")?.total_bytes);
  const previousDb = num(pick(previousDate, "database")?.total_bytes);
  const latestStorage = num(pick(latestDate, "storage_total")?.total_bytes);
  const previousStorage = num(pick(previousDate, "storage_total")?.total_bytes);
  const latestRows = byDate.get(latestDate) ?? [];
  const tables = latestRows
    .filter((row) => row.kind === "table")
    .sort((a, b) => Number(b.total_bytes) - Number(a.total_bytes))
    .slice(0, tableLimit)
    .map((row) => {
      const previous = num(pick(previousDate, "table", row.name)?.total_bytes);
      return {
        name: row.name,
        totalBytes: Number(row.total_bytes),
        tableBytes: num(row.table_bytes),
        indexBytes: num(row.index_bytes),
        rowEstimate: num(row.row_estimate),
        deltaBytes: previous === null ? null : Number(row.total_bytes) - previous,
      };
    });
  const storagePrefixes = latestRows
    .filter((row) => row.kind === "storage")
    .sort((a, b) => Number(b.total_bytes) - Number(a.total_bytes))
    .map((row) => {
      const previous = num(pick(previousDate, "storage", row.name)?.total_bytes);
      return {
        name: row.name,
        bytes: Number(row.total_bytes),
        objectCount: num(row.object_count),
        deltaBytes: previous === null ? null : Number(row.total_bytes) - previous,
      };
    });
  const history = dates.map((date) => ({
    date,
    databaseBytes: num(pick(date, "database")?.total_bytes),
    storageBytes: num(pick(date, "storage_total")?.total_bytes),
  }));
  return {
    latestDate,
    previousDate,
    database: series(latestDb, previousDb, days, config.dbGrowth.amberBytesPerDay, config.dbGrowth.redBytesPerDay),
    storage: series(latestStorage, previousStorage, days, config.storageGrowth.amberBytesPerDay, config.storageGrowth.redBytesPerDay),
    tables,
    storagePrefixes,
    history,
  };
}

const HISTORY_DAYS = 90;

export async function readGrowth(now: Date, config: ThresholdConfig): Promise<GrowthDto | null> {
  const latest = await supabaseAdmin("GET", "/rest/v1/system_size_snapshots?select=snapshot_date&order=snapshot_date.desc&limit=1");
  ok(latest, "size snapshot read");
  const latestDate = Array.isArray(latest.json) && latest.json[0] ? String((latest.json[0] as { snapshot_date: string }).snapshot_date) : null;
  if (!latestDate) return null;
  const previous = await supabaseAdmin("GET", `/rest/v1/system_size_snapshots?select=snapshot_date&snapshot_date=lt.${latestDate}&order=snapshot_date.desc&limit=1`);
  ok(previous, "size snapshot read");
  const previousDate = Array.isArray(previous.json) && previous.json[0] ? String((previous.json[0] as { snapshot_date: string }).snapshot_date) : null;
  const historySince = new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const dateFilter = previousDate ? `snapshot_date=in.(${latestDate},${previousDate})` : `snapshot_date=eq.${latestDate}`;
  const [detail, totals] = await Promise.all([
    supabaseAdmin("GET", `/rest/v1/system_size_snapshots?select=snapshot_date,kind,name,total_bytes,table_bytes,index_bytes,row_estimate,object_count&${dateFilter}&order=total_bytes.desc&limit=2000`),
    supabaseAdmin("GET", `/rest/v1/system_size_snapshots?select=snapshot_date,kind,name,total_bytes,table_bytes,index_bytes,row_estimate,object_count&kind=in.(database,storage_total)&snapshot_date=gte.${historySince}&order=snapshot_date.asc&limit=1000`),
  ]);
  ok(detail, "size snapshot read");
  ok(totals, "size snapshot read");
  const rows = [...(Array.isArray(detail.json) ? (detail.json as SnapshotRow[]) : []), ...(Array.isArray(totals.json) ? (totals.json as SnapshotRow[]) : [])];
  return assembleGrowth(rows, config);
}

export interface PerformanceReaders {
  latency?: (now: Date) => Promise<{ lastHour: LatencyWindowDto; lastDay: LatencyWindowDto }>;
  slowStatements?: () => Promise<SlowStatementsDto>;
  growth?: (now: Date, config: ThresholdConfig) => Promise<GrowthDto | null>;
  /** Warehouse status feed freshness; feeds the stalled-feed threshold. */
  warehousePoll?: (now: Date) => Promise<WarehousePollInput | null>;
  /** Cold archive job health; feeds the repeated-failure / backlog threshold. */
  coldArchive?: (now: Date) => Promise<ColdArchiveInput | null>;
  onError?: (section: "latency" | "slowStatements" | "growth" | "warehousePoll" | "coldArchive", error: unknown) => void;
}

async function readWarehousePoll(now: Date): Promise<WarehousePollInput | null> {
  const health = await withLiveBillingScope(() => warehouseSyncHealth(now));
  return { lastSuccessAt: health.last_success_at, lastPollAt: health.last_poll_at, stalledAfterMinutes: health.stalled_after_minutes, lastError: health.last_error };
}

async function readColdArchive(now: Date): Promise<ColdArchiveInput | null> {
  const [health, state] = await Promise.all([readColdArchiveHealth(now), supabaseJobStore.getState("cold-archive")]);
  return {
    enabled: health.enabled,
    storageConfigured: health.storageConfigured,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    daysPending: health.daysPending,
    lastError: state?.lastError ?? null,
  };
}

export async function readPerformance(now: Date, readers: PerformanceReaders = {}): Promise<PerformanceDto> {
  const config = thresholdConfig();
  const guard = async <T>(section: "latency" | "slowStatements" | "growth" | "warehousePoll" | "coldArchive", read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      readers.onError?.(section, error);
      return null;
    }
  };
  const [latency, slowStatements, growth, warehousePoll, coldArchive] = await Promise.all([
    guard("latency", () => (readers.latency ?? readLatency)(now)),
    guard("slowStatements", () => (readers.slowStatements ?? readSlowStatements)()),
    guard("growth", () => (readers.growth ?? readGrowth)(now, config)),
    guard("warehousePoll", () => (readers.warehousePoll ?? readWarehousePoll)(now)),
    guard("coldArchive", () => (readers.coldArchive ?? readColdArchive)(now)),
  ]);
  const findings = evaluateThresholds(
    {
      latencyLastHour: latency ? latency.lastHour.families.map((family) => ({ family: family.family, requests: family.requests, p95Ms: family.p95Ms })) : [],
      growth: growth ? { databaseBytesPerDay: growth.database.bytesPerDay, storageBytesPerDay: growth.storage.bytesPerDay } : null,
      warehousePoll, coldArchive, now,
    },
    config,
  );
  return {
    asOf: now.toISOString(),
    latency,
    slowStatements,
    growth,
    thresholds: { level: worstLevel(findings), config, findings },
  };
}
