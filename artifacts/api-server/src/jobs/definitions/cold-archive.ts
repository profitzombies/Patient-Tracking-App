/**
 * cold-archive: nightly, when the HQ "Archive to cold storage" toggle is on,
 * copy each closed UTC day's raw rows into compressed files under the
 * dedicated storage prefix (COLD_ARCHIVE_OBJECT_DIR):
 *
 *   archive/<table>/<yyyy>/<mm>/<dd>.ndjson.gz     one per table, rows as-is
 *   archive/manifests/<yyyy>/<mm>/<dd>.json        row counts + checksums
 *
 * Days are taken oldest first from the earliest data day, bounded per run
 * (MAX_DAYS_PER_RUN), and a day is marked archived (system_cold_archive_days)
 * only after every table file and the manifest landed. Output is
 * deterministic — sorted JSON keys, id-ordered rows, gzip with a zero mtime —
 * so re-running a day overwrites the same names with the same bytes. Days
 * with zero rows still get their (empty) files and a manifest.
 *
 * Nothing here deletes or changes live rows. Dry runs list the pending days
 * and count rows but write nothing and mark nothing. When the toggle is off
 * the run is a logged no-op.
 *
 * Caveats recorded in every manifest: rows are snapshots of the day's rows
 * as of the run (mutable tables such as orders and subscriptions can change
 * afterwards; subscriptions are keyed by updated_at, so a later change lands
 * in a later day), and rows that arrive later with a historical timestamp
 * (e.g. a backfill) are not picked up by an already-archived day.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { COLD_ARCHIVE_NOT_CONFIGURED, coldArchiveConfigured, defaultColdArchiveStore, readColdArchiveStatus, utcDay, type ColdArchiveStatus, type ColdArchiveStore } from "../../lib/cold-archive";
import { loadOrgPolicy } from "../../lib/org-policy";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";

const DAY_MS = 86_400_000;
export const MAX_DAYS_PER_RUN = 30;
export const ROW_PAGE_SIZE = 2000;
export const ARCHIVE_ROOT = "archive";
export const MANIFEST_VERSION = 1;

export type RetentionClass = "events" | "audit" | "financial";

export interface ArchiveTable {
  name: string;
  /** Column that places a row in a day (UTC). */
  dayColumn: string;
  retentionClass: RetentionClass;
}

/** The archived tables, in file order. Mirrors the allowlist inside cold_archive_rows(). */
export const ARCHIVE_TABLES: readonly ArchiveTable[] = [
  { name: "patient_app_events", dayColumn: "occurred_at", retentionClass: "events" },
  { name: "admin_audit_events", dayColumn: "occurred_at", retentionClass: "audit" },
  { name: "billing_orders", dayColumn: "created_at", retentionClass: "financial" },
  { name: "billing_order_items", dayColumn: "created_at", retentionClass: "financial" },
  { name: "billing_shipments", dayColumn: "created_at", retentionClass: "financial" },
  { name: "billing_ledger", dayColumn: "occurred_at", retentionClass: "financial" },
  { name: "billing_refunds", dayColumn: "created_at", retentionClass: "financial" },
  { name: "billing_subscriptions", dayColumn: "updated_at", retentionClass: "financial" },
];

export interface ArchiveRow {
  row_id: string;
  row_json: Record<string, unknown>;
}

/** Reads the job needs; the defaults ride the SQL functions, tests inject psql/memory stand-ins. */
export interface ColdArchiveSource {
  /** One keyset page of a table's rows for a UTC day, ordered by id. */
  rows(table: string, day: string, afterId: string | null, limit: number): Promise<ArchiveRow[]>;
  /** First UTC day with any archivable data, or null. */
  earliestDay(): Promise<string | null>;
  /** Days already marked archived within [from, to] inclusive. */
  archivedDays(from: string, to: string): Promise<string[]>;
  /** Record a day as archived (upsert). */
  markDay(mark: ArchiveDayMark): Promise<void>;
}

export interface ArchiveDayMark {
  archive_day: string;
  archived_at: string;
  manifest_path: string;
  row_count: number;
  bytes_written: number;
  manifest: DailyManifest;
}

export interface ColdArchiveDeps {
  enabled?: () => Promise<boolean>;
  storageConfigured?: () => boolean;
  source?: ColdArchiveSource;
  store?: ColdArchiveStore;
  /** Ledger tallies logged after a run that archived something. */
  status?: (now: Date) => Promise<ColdArchiveStatus>;
  maxDaysPerRun?: number;
  pageSize?: number;
}

export interface ManifestTableEntry {
  table: string;
  path: string;
  dayColumn: string;
  retentionClass: RetentionClass;
  rowCount: number;
  /** SHA-256 of the uncompressed NDJSON bytes. */
  sha256: string;
  /** SHA-256 and size of the gzip file as written. */
  gzipSha256: string;
  gzipBytes: number;
  uncompressedBytes: number;
}

export interface DailyManifest {
  version: number;
  day: string;
  dayBoundary: "utc";
  generatedAt: string;
  rowCount: number;
  bytesWritten: number;
  tables: ManifestTableEntry[];
  notes: string[];
}

export const MANIFEST_NOTES = [
  "Rows are copied as stored (no scrubbing); the archive bucket shares the database's data-handling posture.",
  "Each file is a snapshot of the rows whose day column fell on this UTC day at archive time (archived_at in the archive ledger); rows in mutable tables may change later.",
  "billing_subscriptions rows are keyed by updated_at, so a later change to a subscription lands in that later day's file.",
  "Rows inserted later with a historical timestamp (for example a backfill) are not added to an already archived day.",
];

function ok(result: { status: number }, label: string): void {
  if (result.status >= 300) throw new Error(`${label} failed (${result.status})`);
}

export const defaultColdArchiveSource: ColdArchiveSource = {
  async rows(table, day, afterId, limit) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/cold_archive_rows", { p_table: table, p_day: day, p_after_id: afterId, p_limit: limit });
    ok(result, `cold archive rows read (${table} ${day})`);
    return Array.isArray(result.json) ? (result.json as ArchiveRow[]) : [];
  },
  async earliestDay() {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/cold_archive_earliest_day", {});
    ok(result, "cold archive earliest day read");
    return typeof result.json === "string" && result.json ? result.json : null;
  },
  async archivedDays(from, to) {
    const result = await supabaseAdmin("GET", `/rest/v1/system_cold_archive_days?select=archive_day&archive_day=gte.${from}&archive_day=lte.${to}&order=archive_day.asc&limit=10000`);
    ok(result, "cold archive marks read");
    return Array.isArray(result.json) ? (result.json as Array<{ archive_day: string }>).map((row) => row.archive_day) : [];
  },
  async markDay(mark) {
    const result = await supabaseAdmin("POST", "/rest/v1/system_cold_archive_days?on_conflict=archive_day", mark, "resolution=merge-duplicates,return=minimal");
    ok(result, `cold archive mark (${mark.archive_day})`);
  },
};

async function defaultEnabled(): Promise<boolean> {
  return (await loadOrgPolicy({ fresh: true })).coldArchiveEnabled;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export function dayPath(day: string): string {
  const [yyyy, mm, dd] = day.split("-");
  return `${yyyy}/${mm}/${dd}`;
}
export function tableFilePath(table: string, day: string): string {
  return `${ARCHIVE_ROOT}/${table}/${dayPath(day)}.ndjson.gz`;
}
export function manifestPath(day: string): string {
  return `${ARCHIVE_ROOT}/manifests/${dayPath(day)}.json`;
}

/** JSON with recursively sorted object keys so identical rows always serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic gzip: fixed level, zero mtime, no name — same input, same bytes. */
export function gzipDeterministic(bytes: Buffer): Buffer {
  const out = gzipSync(bytes, { level: 6 });
  // RFC 1952 header: bytes 4-7 are MTIME, byte 9 is the OS id. zlib stamps
  // neither the time nor a name, but pin both explicitly so the promise
  // does not depend on the runtime.
  out.writeUInt32LE(0, 4);
  out[9] = 0x03;
  return out;
}

/** Days from `from` to `to` inclusive (YYYY-MM-DD, UTC). */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  let at = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  while (at <= end) {
    out.push(new Date(at).toISOString().slice(0, 10));
    at += DAY_MS;
  }
  return out;
}

/** Closed days (before today, UTC) from the earliest data day that carry no archive mark, oldest first. */
export function pendingDays(input: { earliestDay: string | null; today: string; archived: readonly string[] }): string[] {
  if (!input.earliestDay || input.earliestDay >= input.today) return [];
  const lastClosed = new Date(Date.UTC(Number(input.today.slice(0, 4)), Number(input.today.slice(5, 7)) - 1, Number(input.today.slice(8, 10))) - DAY_MS).toISOString().slice(0, 10);
  const done = new Set(input.archived);
  return dayRange(input.earliestDay, lastClosed).filter((day) => !done.has(day));
}

export interface BuiltTableFile {
  entry: ManifestTableEntry;
  gzip: Buffer;
}

/** NDJSON + gzip + checksums for one table/day from already-read rows. */
export function buildTableFile(table: ArchiveTable, day: string, rows: readonly ArchiveRow[]): BuiltTableFile {
  const ndjson = Buffer.from(rows.map((row) => canonicalJson(row.row_json) + "\n").join(""), "utf8");
  const gzip = gzipDeterministic(ndjson);
  return {
    gzip,
    entry: {
      table: table.name,
      path: tableFilePath(table.name, day),
      dayColumn: table.dayColumn,
      retentionClass: table.retentionClass,
      rowCount: rows.length,
      sha256: sha256Hex(ndjson),
      gzipSha256: sha256Hex(gzip),
      gzipBytes: gzip.length,
      uncompressedBytes: ndjson.length,
    },
  };
}

export function buildManifest(day: string, generatedAt: string, tables: readonly ManifestTableEntry[]): DailyManifest {
  return {
    version: MANIFEST_VERSION,
    day,
    dayBoundary: "utc",
    generatedAt,
    rowCount: tables.reduce((sum, table) => sum + table.rowCount, 0),
    bytesWritten: tables.reduce((sum, table) => sum + table.gzipBytes, 0),
    tables: [...tables],
    notes: [...MANIFEST_NOTES],
  };
}

/**
 * The manifest file's bytes leave out generatedAt so a re-run of the same day
 * writes byte-identical files under the same names; the archive time lives on
 * the ledger row (archived_at) and in its stored manifest copy.
 */
export function manifestBytes(manifest: DailyManifest): Buffer {
  const { generatedAt: _generatedAt, ...stable } = manifest;
  return Buffer.from(canonicalJson(stable) + "\n", "utf8");
}

async function readAllRows(source: ColdArchiveSource, ctx: JobContext, table: ArchiveTable, day: string, pageSize: number): Promise<ArchiveRow[]> {
  const rows: ArchiveRow[] = [];
  let afterId: string | null = null;
  for (;;) {
    ctx.checkpoint();
    const page: ArchiveRow[] = await source.rows(table.name, day, afterId, pageSize);
    rows.push(...page);
    if (page.length < pageSize) break;
    const last = page[page.length - 1];
    if (!last || last.row_id === afterId) throw new Error(`cold archive page for ${table.name} ${day} did not advance`);
    afterId = last.row_id;
  }
  return rows;
}

export async function runColdArchive(ctx: JobContext, deps: ColdArchiveDeps = {}): Promise<void> {
  const enabled = await (deps.enabled ?? defaultEnabled)();
  if (!enabled) {
    ctx.log("cold_archive_off", { dryRun: ctx.dryRun });
    ctx.tally("skippedOff", 1);
    return;
  }
  if (!(deps.storageConfigured ?? coldArchiveConfigured)()) throw new Error(COLD_ARCHIVE_NOT_CONFIGURED);
  const source = deps.source ?? defaultColdArchiveSource;
  const store = deps.store ?? defaultColdArchiveStore;
  const maxDays = deps.maxDaysPerRun ?? MAX_DAYS_PER_RUN;
  const pageSize = deps.pageSize ?? ROW_PAGE_SIZE;
  const today = utcDay(ctx.now);

  const earliestDay = await source.earliestDay();
  const archived = earliestDay && earliestDay < today ? await source.archivedDays(earliestDay, today) : [];
  const pending = pendingDays({ earliestDay, today, archived });
  const batch = pending.slice(0, maxDays);
  ctx.log("cold_archive_plan", { earliestDay, today, daysPending: pending.length, daysThisRun: batch.length, dryRun: ctx.dryRun });
  ctx.tally("daysPendingBefore", pending.length);

  let done = 0;
  for (const day of batch) {
    ctx.checkpoint();
    const entries: ManifestTableEntry[] = [];
    const files: Array<{ path: string; bytes: Buffer }> = [];
    let dayRows = 0;
    for (const table of ARCHIVE_TABLES) {
      const rows = await readAllRows(source, ctx, table, day, pageSize);
      dayRows += rows.length;
      if (ctx.dryRun) continue;
      const built = buildTableFile(table, day, rows);
      entries.push(built.entry);
      files.push({ path: built.entry.path, bytes: built.gzip });
    }
    if (ctx.dryRun) {
      ctx.log("cold_archive_would_archive", { day, rows: dayRows });
      ctx.tally("daysWouldArchive", 1);
      ctx.tally("rowsWouldArchive", dayRows);
      continue;
    }
    const manifest = buildManifest(day, ctx.now.toISOString(), entries);
    for (const file of files) {
      ctx.checkpoint();
      await store.put(file.path, file.bytes, "application/gzip");
    }
    const manifestFile = manifestBytes(manifest);
    await store.put(manifestPath(day), manifestFile, "application/json");
    // The mark is the last write: a day only counts once every file and its
    // manifest are in storage. A crash before this line leaves the day
    // pending and the next run rewrites the same names with the same bytes.
    await source.markDay({
      archive_day: day,
      archived_at: ctx.now.toISOString(),
      manifest_path: manifestPath(day),
      row_count: manifest.rowCount,
      bytes_written: manifest.bytesWritten,
      manifest,
    });
    done += 1;
    ctx.log("cold_archive_day", { day, rows: manifest.rowCount, bytes: manifest.bytesWritten, tables: entries.length });
    ctx.tally("daysArchived", 1);
    ctx.tally("rowsArchived", manifest.rowCount);
    ctx.tally("bytesWritten", manifest.bytesWritten);
    ctx.tally("filesWritten", files.length + 1);
  }
  ctx.tally("daysPendingAfter", Math.max(0, pending.length - done));
  if (!ctx.dryRun && done > 0) {
    // Report the ledger's view (not the local arithmetic) so the run record
    // matches what System health will show.
    try {
      const status = await (deps.status ?? readColdArchiveStatus)(ctx.now);
      ctx.log("cold_archive_status", { lastArchivedDay: status.lastArchivedDay, daysPending: status.daysPending, bytesWritten: status.bytesWritten });
    } catch (error) {
      ctx.log("cold_archive_status_unavailable", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const coldArchiveJob: JobDefinition = {
  name: "cold-archive",
  title: "Cold archive to storage",
  description: "When the HQ archive toggle is on, copies each closed UTC day's raw app events, audit events, orders, order items, shipments, ledger entries, refunds, and subscription changes into gzip NDJSON files plus a daily manifest under the cold storage prefix (up to 30 days per run, oldest first). Never deletes live rows; off by default.",
  intervalMs: DAY_MS,
  leaseSeconds: 60 * 60,
  run: runColdArchive,
};
