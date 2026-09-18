/**
 * data-growth-snapshot: once a day, record how big everything is — every
 * application table (total, heap, index, toast bytes and the planner's row
 * estimate), the whole database, and object storage per prefix plus the
 * total — as one row per (day, kind, name) in system_size_snapshots. The
 * System health growth panel reads today against the previous snapshot for
 * the daily delta and keeps 400 days so a year of growth stays comparable.
 *
 * Also trims the per-minute request latency rows past their week; the page
 * only reads the last day.
 *
 * Re-running on the same day replaces that day's rows (upsert), so a manual
 * run after a failed scheduled one is safe. Dry runs read and log the totals
 * but write nothing.
 */
import { objectStorage } from "../../lib/objectStorage";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";
import { RECONCILE_PREFIXES } from "./reconcile-storage";

const DAY_MS = 86_400_000;
export const SNAPSHOT_KEEP_DAYS = 400;
export const REQUEST_METRICS_KEEP_DAYS = 7;

export interface SizeSnapshotRow {
  snapshot_date: string;
  kind: "database" | "table" | "storage" | "storage_total";
  name: string;
  total_bytes: number;
  table_bytes: number | null;
  index_bytes: number | null;
  toast_bytes: number | null;
  row_estimate: number | null;
  object_count: number | null;
  captured_at: string;
}

interface RelationRow {
  schema_name: string;
  table_name: string;
  total_bytes: number | string;
  table_bytes: number | string;
  index_bytes: number | string;
  toast_bytes: number | string;
  row_estimate: number | string;
  database_bytes: number | string;
}

function ok(result: { status: number }, label: string): void {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}

export interface StorageTotals {
  prefix: string;
  bytes: number;
  objects: number;
}

export interface GrowthSnapshotDeps {
  relationSizes?: () => Promise<RelationRow[]>;
  storageTotals?: (prefix: string) => Promise<StorageTotals>;
}

async function defaultRelationSizes(): Promise<RelationRow[]> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/hq_relation_sizes", {});
  ok(result, "relation sizes read");
  return Array.isArray(result.json) ? (result.json as RelationRow[]) : [];
}

async function defaultStorageTotals(prefix: string): Promise<StorageTotals> {
  const objects = await objectStorage.listObjects(prefix);
  let bytes = 0;
  for (const object of objects) bytes += object.sizeBytes ?? 0;
  return { prefix, bytes, objects: objects.length };
}

/** Pure row assembly from the two sources; exported for tests. */
export function buildSnapshotRows(input: { date: string; capturedAt: string; relations: RelationRow[]; storage: StorageTotals[] }): SizeSnapshotRow[] {
  const rows: SizeSnapshotRow[] = [];
  const base = { snapshot_date: input.date, captured_at: input.capturedAt, object_count: null as number | null };
  const databaseBytes = input.relations[0] ? Number(input.relations[0].database_bytes) : null;
  if (databaseBytes !== null) {
    rows.push({ ...base, kind: "database", name: "database", total_bytes: databaseBytes, table_bytes: null, index_bytes: null, toast_bytes: null, row_estimate: null });
  }
  for (const relation of input.relations) {
    rows.push({
      ...base,
      kind: "table",
      name: `${relation.schema_name}.${relation.table_name}`,
      total_bytes: Number(relation.total_bytes),
      table_bytes: Number(relation.table_bytes),
      index_bytes: Number(relation.index_bytes),
      toast_bytes: Number(relation.toast_bytes),
      row_estimate: Number(relation.row_estimate),
    });
  }
  let storageTotal = 0;
  let objectTotal = 0;
  for (const prefix of input.storage) {
    storageTotal += prefix.bytes;
    objectTotal += prefix.objects;
    rows.push({ ...base, kind: "storage", name: prefix.prefix, total_bytes: prefix.bytes, table_bytes: null, index_bytes: null, toast_bytes: null, row_estimate: null, object_count: prefix.objects });
  }
  rows.push({ ...base, kind: "storage_total", name: "storage", total_bytes: storageTotal, table_bytes: null, index_bytes: null, toast_bytes: null, row_estimate: null, object_count: objectTotal });
  return rows;
}

export async function runDataGrowthSnapshot(ctx: JobContext, deps: GrowthSnapshotDeps = {}): Promise<void> {
  const date = ctx.now.toISOString().slice(0, 10);
  const relations = await (deps.relationSizes ?? defaultRelationSizes)();
  if (!relations.length) throw new Error("relation sizes returned no tables");
  ctx.checkpoint();
  const storage: StorageTotals[] = [];
  for (const prefix of RECONCILE_PREFIXES) {
    ctx.checkpoint();
    // A prefix that cannot be listed fails the item, not the run: the table
    // sizes still land and the storage total for the day stays absent
    // (nullable delta) rather than silently low.
    try {
      storage.push(await (deps.storageTotals ?? defaultStorageTotals)(prefix));
    } catch (error) {
      ctx.failItem(prefix, error);
    }
  }
  const complete = storage.length === RECONCILE_PREFIXES.length;
  const rows = buildSnapshotRows({ date, capturedAt: ctx.now.toISOString(), relations, storage });
  const kept = complete ? rows : rows.filter((row) => row.kind !== "storage_total");
  const database = kept.find((row) => row.kind === "database");
  const storageTotal = kept.find((row) => row.kind === "storage_total");
  ctx.log("data_growth_snapshot", {
    date,
    tables: relations.length,
    databaseBytes: database?.total_bytes ?? null,
    storageBytes: storageTotal?.total_bytes ?? null,
    storageObjects: storageTotal?.object_count ?? null,
    storagePrefixesListed: storage.length,
    dryRun: ctx.dryRun,
  });
  ctx.tally("tablesMeasured", relations.length);
  ctx.tally("storagePrefixesMeasured", storage.length);
  if (ctx.dryRun) {
    ctx.tally("rowsWouldWrite", kept.length);
    return;
  }
  const written = await supabaseAdmin("POST", "/rest/v1/system_size_snapshots?on_conflict=snapshot_date,kind,name", kept, "resolution=merge-duplicates,return=minimal");
  ok(written, "size snapshot write");
  ctx.tally("rowsWritten", kept.length);
  ctx.checkpoint();
  const snapshotCutoff = new Date(ctx.now.getTime() - SNAPSHOT_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  const trimmedSnapshots = await supabaseAdmin("DELETE", `/rest/v1/system_size_snapshots?snapshot_date=lt.${snapshotCutoff}`, undefined, "return=representation");
  ok(trimmedSnapshots, "size snapshot trim");
  ctx.tally("snapshotsTrimmed", Array.isArray(trimmedSnapshots.json) ? trimmedSnapshots.json.length : 0);
  const metricsCutoff = new Date(ctx.now.getTime() - REQUEST_METRICS_KEEP_DAYS * DAY_MS).toISOString();
  const trimmedMetrics = await supabaseAdmin("DELETE", `/rest/v1/api_request_metrics?bucket_start=lt.${encodeURIComponent(metricsCutoff)}`, undefined, "return=representation");
  ok(trimmedMetrics, "request metrics trim");
  ctx.tally("requestMetricRowsTrimmed", Array.isArray(trimmedMetrics.json) ? trimmedMetrics.json.length : 0);
}

export const dataGrowthSnapshotJob: JobDefinition = {
  name: "data-growth-snapshot",
  title: "Data growth snapshot",
  description: "Records every table's size, the database total, and object-storage bytes per prefix once a day (400 days kept) and trims request latency rows past a week.",
  intervalMs: DAY_MS,
  leaseSeconds: 20 * 60,
  run: runDataGrowthSnapshot,
};
