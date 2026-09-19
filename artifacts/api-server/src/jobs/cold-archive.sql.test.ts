/**
 * The nightly cold archive, run for real against PostgreSQL: the canonical
 * migration applied verbatim over minimal mirrors of the archived tables, the
 * job driven through a psql-backed source and an in-memory object store.
 *
 * Proves, on a fixture spanning three closed days plus today:
 *   - file names (archive/<table>/yyyy/mm/dd.ndjson.gz + a daily manifest);
 *   - per-table row counts and checksums that match the bytes written;
 *   - rows copied as stored, keyset paging across many pages, UTC day
 *     boundaries, and today's rows left alone;
 *   - a zero-row day still gets its files and manifest;
 *   - re-running a day is byte-identical (same names, same content);
 *   - the day mark lands only after every file, and the backlog / status
 *     RPC counts closed unarchived days;
 *   - dry run writes and marks nothing; off-state is a no-op; the per-run
 *     bound takes the oldest days first;
 *   - the row RPC refuses tables outside its allowlist.
 * Skips loudly without PostgreSQL binaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { JobContext } from "./types";
import {
  ARCHIVE_TABLES,
  MANIFEST_VERSION,
  manifestPath,
  runColdArchive,
  tableFilePath,
  type ArchiveDayMark,
  type ColdArchiveSource,
  type DailyManifest,
} from "./definitions/cold-archive";
import type { ColdArchiveStatus, ColdArchiveStore } from "../lib/cold-archive";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../../../../supabase/migrations/20261107000000_cold_archive.sql");

function hasBinary(name: string): boolean {
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0;
}
const POSTGRES_AVAILABLE = ["initdb", "pg_ctl", "psql"].every(hasBinary);
if (!POSTGRES_AVAILABLE) console.warn("jobs/cold-archive.sql.test: PostgreSQL binaries not on PATH — suite skipped");

const SCHEMA = `
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create table public.hq_organization_settings (singleton boolean primary key default true, version integer not null default 1);
insert into public.hq_organization_settings default values;
create table public.patient_app_events (
  id bigint generated always as identity primary key,
  patient_id uuid not null, provider_id text not null, feature text not null,
  occurred_at timestamptz not null default now(), local_day date not null, local_hour smallint not null default -1,
  platform text not null default 'unknown', detail jsonb not null default '{}'::jsonb);
create table public.admin_audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(), action text not null, actor_kind text not null default 'hq',
  provider_id text, metadata jsonb not null default '{}'::jsonb);
create table public.billing_orders (id uuid primary key default gen_random_uuid(), provider_id text not null, status text not null default 'paid', total_cents integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.billing_order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null, sku text not null, quantity integer not null default 1, created_at timestamptz not null default now());
create table public.billing_shipments (id uuid primary key default gen_random_uuid(), order_id uuid not null, carrier text, created_at timestamptz not null default now());
create table public.billing_ledger (id uuid primary key default gen_random_uuid(), provider_id text not null, kind text not null, amount_cents integer not null, occurred_at timestamptz not null default now(), created_at timestamptz not null default now());
create table public.billing_refunds (id uuid primary key default gen_random_uuid(), order_id uuid not null, amount_cents integer not null, created_at timestamptz not null default now());
create table public.billing_subscriptions (id uuid primary key default gen_random_uuid(), patient_id uuid not null, status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
`;

let dir = "";
let dataDir = "";
const PORT = 55_800 + (process.pid % 1000);
const PSQL_ARGS = () => ["-h", dir, "-p", String(PORT), "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];

function psql(sql: string): string {
  return execFileSync("psql", [...PSQL_ARGS(), "-c", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function rows<T = Record<string, unknown>>(sql: string): T[] {
  const out = psql(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t;`);
  return JSON.parse(out.trim() || "[]") as T[];
}
function scalar<T = unknown>(sql: string): T {
  return rows<{ v: T }>(`select (select ${sql}) as v`)[0].v;
}
function fails(sql: string): string {
  try {
    psql(sql);
    return "";
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}
const lit = (value: string | null) => (value === null ? "null" : `'${value.replace(/'/g, "''")}'`);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Three closed days and "today"; the run instant is mid-day on the 8th (UTC).
const D1 = "2026-09-05";
const D2 = "2026-09-06";
const D3 = "2026-09-07";
const TODAY = "2026-09-08";
const NOW = new Date(`${TODAY}T12:00:00Z`);

/** The job's reads, answered by the real SQL functions through psql. */
const psqlSource: ColdArchiveSource = {
  async rows(table, day, afterId, limit) {
    return rows<{ row_id: string; row_json: Record<string, unknown> }>(
      `select row_id, row_json from public.cold_archive_rows(${lit(table)}, ${lit(day)}::date, ${lit(afterId)}, ${limit})`,
    );
  },
  async earliestDay() {
    return scalar<string | null>("public.cold_archive_earliest_day()");
  },
  async archivedDays(from, to) {
    return rows<{ d: string }>(`select archive_day::text as d from public.system_cold_archive_days where archive_day between ${lit(from)}::date and ${lit(to)}::date order by archive_day`).map((r) => r.d);
  },
  async markDay(mark: ArchiveDayMark) {
    psql(
      `insert into public.system_cold_archive_days (archive_day, archived_at, manifest_path, row_count, bytes_written, manifest)
       values (${lit(mark.archive_day)}::date, ${lit(mark.archived_at)}::timestamptz, ${lit(mark.manifest_path)}, ${mark.row_count}, ${mark.bytes_written}, ${lit(JSON.stringify(mark.manifest))}::jsonb)
       on conflict (archive_day) do update set archived_at = excluded.archived_at, manifest_path = excluded.manifest_path,
         row_count = excluded.row_count, bytes_written = excluded.bytes_written, manifest = excluded.manifest`,
    );
  },
};

function memoryStore() {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const writes: string[] = [];
  const store: ColdArchiveStore = {
    async put(relativePath, bytes, contentType) {
      objects.set(relativePath, { bytes: Buffer.from(bytes), contentType });
      writes.push(relativePath);
    },
  };
  return { store, objects, writes };
}

function status(): Promise<ColdArchiveStatus> {
  const row = rows<Record<string, unknown>>(`select * from public.cold_archive_status(${lit(TODAY)}::date)`)[0];
  return Promise.resolve({
    earliestDay: (row.earliest_day as string | null) ?? null,
    lastArchivedDay: (row.last_archived_day as string | null) ?? null,
    lastArchivedAt: (row.last_archived_at as string | null) ?? null,
    daysArchived: Number(row.days_archived),
    daysPending: Number(row.days_pending),
    rowsArchived: Number(row.rows_archived),
    bytesWritten: Number(row.bytes_written),
  });
}

function ctx(dryRun = false, now = NOW) {
  const counts: Record<string, number> = {};
  const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const c: JobContext = {
    dryRun,
    now,
    tally: (k, by = 1) => { counts[k] = (counts[k] ?? 0) + by; },
    failItem: () => undefined,
    leaseLost: false,
    checkpoint: () => undefined,
    log: (event, detail) => { logs.push({ event, detail }); },
  };
  return { c, counts, logs };
}

function run(store: ColdArchiveStore, options: { dryRun?: boolean; enabled?: boolean; configured?: boolean; maxDays?: number; pageSize?: number; now?: Date } = {}) {
  const { c, counts, logs } = ctx(options.dryRun ?? false, options.now);
  const promise = runColdArchive(c, {
    enabled: async () => options.enabled ?? true,
    storageConfigured: () => options.configured ?? true,
    source: psqlSource,
    store,
    status,
    maxDaysPerRun: options.maxDays,
    pageSize: options.pageSize ?? 7,
  });
  return promise.then(() => ({ counts, logs }));
}

function readNdjson(bytes: Buffer): Record<string, unknown>[] {
  const text = gunzipSync(bytes).toString("utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function readManifest(bytes: Buffer): Omit<DailyManifest, "generatedAt"> {
  return JSON.parse(bytes.toString("utf8")) as Omit<DailyManifest, "generatedAt">;
}

function seed() {
  psql(`
    truncate public.patient_app_events, public.admin_audit_events, public.billing_orders, public.billing_order_items,
             public.billing_shipments, public.billing_ledger, public.billing_refunds, public.billing_subscriptions,
             public.system_cold_archive_days restart identity;
    -- Day 1: 17 app events (more than two 7-row pages) plus one at the very last instant of the day.
    insert into public.patient_app_events (patient_id, provider_id, feature, occurred_at, local_day, detail)
      select '${uuid(1)}', 'PROV1', 'app_open', timestamptz '${D1}T00:00:00Z' + (n || ' minutes')::interval, date '${D1}', jsonb_build_object('n', n, 'nested', jsonb_build_object('z', 1, 'a', 'x'))
        from generate_series(1, 16) n;
    insert into public.patient_app_events (patient_id, provider_id, feature, occurred_at, local_day)
      values ('${uuid(1)}', 'PROV1', 'food_log', '${D1}T23:59:59.999Z', '${D1}');
    -- Day 2 opens at exactly midnight; an event with a non-UTC literal falls on day 2 in UTC.
    insert into public.patient_app_events (patient_id, provider_id, feature, occurred_at, local_day)
      values ('${uuid(2)}', 'PROV1', 'weigh_in', '${D2}T00:00:00Z', '${D2}'),
             ('${uuid(2)}', 'PROV1', 'weigh_in', '2026-09-05T20:30:00-05:00', '${D2}');
    -- Day 3 has no app events at all; today has one that must stay unarchived.
    insert into public.patient_app_events (patient_id, provider_id, feature, occurred_at, local_day)
      values ('${uuid(3)}', 'PROV1', 'order', '${TODAY}T01:00:00Z', '${TODAY}');
    insert into public.admin_audit_events (occurred_at, action, provider_id, metadata)
      values ('${D1}T09:00:00Z', 'hq_settings_updated', null, '{"field":"coldArchiveEnabled","to":true}'),
             ('${D3}T10:00:00Z', 'patient_updated', 'PROV1', '{"unicode":"é ✓","quote":"a\\"b"}');
    insert into public.billing_orders (id, provider_id, status, total_cents, created_at, updated_at)
      values ('${uuid(10)}', 'PROV1', 'paid', 12900, '${D1}T15:00:00Z', '${D1}T15:00:00Z'),
             ('${uuid(11)}', 'PROV1', 'paid', 4500, '${D3}T15:00:00Z', '${D3}T15:00:00Z');
    insert into public.billing_order_items (order_id, sku, quantity, created_at)
      values ('${uuid(10)}', 'REGULATE', 2, '${D1}T15:00:00Z'), ('${uuid(10)}', 'BURN', 1, '${D1}T15:00:00Z'), ('${uuid(11)}', 'BURN', 1, '${D3}T15:00:00Z');
    insert into public.billing_shipments (order_id, carrier, created_at) values ('${uuid(10)}', 'UPS', '${D2}T08:00:00Z');
    insert into public.billing_ledger (provider_id, kind, amount_cents, occurred_at, created_at)
      values ('PROV1', 'charge', 12900, '${D1}T15:00:01Z', '${D1}T15:00:01Z'), ('PROV1', 'platform_fee', -645, '${D1}T15:00:01Z', '${D2}T02:00:00Z');
    insert into public.billing_refunds (order_id, amount_cents, created_at) values ('${uuid(10)}', 2000, '${D3}T11:00:00Z');
    insert into public.billing_subscriptions (id, patient_id, status, created_at, updated_at)
      values ('${uuid(20)}', '${uuid(1)}', 'active', '${D1}T12:00:00Z', '${D3}T12:00:00Z');
  `);
}

describe.skipIf(!POSTGRES_AVAILABLE)("cold archive job (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ca-"));
    dataDir = path.join(dir, "data");
    execFileSync("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-w", "-o", `-k ${dir} -p ${PORT} -c listen_addresses='' -c timezone=UTC`, "-l", path.join(dir, "log"), "start"],
      { stdio: "ignore" },
    );
    const schemaFile = path.join(dir, "schema.sql");
    writeFileSync(schemaFile, SCHEMA);
    for (const file of [schemaFile, MIGRATION]) {
      execFileSync("psql", [...PSQL_ARGS().filter((a) => a !== "-At"), "-f", file], { stdio: "pipe", encoding: "utf8" });
    }
  }, 60_000);

  afterAll(() => {
    if (dataDir) spawnSync("pg_ctl", ["-D", dataDir, "-m", "immediate", "stop"], { stdio: "ignore" });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => { seed(); });

  it("adds the HQ toggle off by default and the archive ledger", () => {
    expect(scalar<boolean>("cold_archive_enabled from public.hq_organization_settings")).toBe(false);
    expect(scalar<number>("count(*) from public.system_cold_archive_days")).toBe(0);
  });

  it("reports the backlog as every closed day from the earliest data, none archived yet", async () => {
    expect(await psqlSource.earliestDay()).toBe(D1);
    expect(await status()).toEqual({ earliestDay: D1, lastArchivedDay: null, lastArchivedAt: null, daysArchived: 0, daysPending: 3, rowsArchived: 0, bytesWritten: 0 });
  });

  it("archives the three closed days: one gzip NDJSON per table plus a manifest, counts and checksums matching the bytes", async () => {
    const { store, objects, writes } = memoryStore();
    const { counts } = await run(store);

    expect(counts).toMatchObject({ daysPendingBefore: 3, daysArchived: 3, daysPendingAfter: 0, filesWritten: 3 * (ARCHIVE_TABLES.length + 1), rowsArchived: 17 + 2 + 0 + 2 + 2 + 3 + 1 + 2 + 1 + 1 });
    // Every table on every closed day has a file at the documented name, even with zero rows.
    for (const day of [D1, D2, D3]) {
      for (const table of ARCHIVE_TABLES) expect(objects.has(tableFilePath(table.name, day)), `${table.name} ${day}`).toBe(true);
      expect(objects.has(manifestPath(day))).toBe(true);
    }
    expect(objects.size).toBe(3 * (ARCHIVE_TABLES.length + 1));
    expect(tableFilePath("patient_app_events", D1)).toBe("archive/patient_app_events/2026/09/05.ndjson.gz");
    expect(manifestPath(D1)).toBe("archive/manifests/2026/09/05.json");
    expect(objects.get(tableFilePath("billing_orders", D1))?.contentType).toBe("application/gzip");
    expect(objects.get(manifestPath(D1))?.contentType).toBe("application/json");
    // Nothing from today is in any file.
    expect(objects.has(tableFilePath("patient_app_events", TODAY))).toBe(false);

    // Day 1 rows: the 17 events (across three keyset pages) come back in id
    // order, as stored, with nested JSON intact and keys sorted.
    const events1 = readNdjson(objects.get(tableFilePath("patient_app_events", D1))!.bytes);
    expect(events1.map((r) => r.id)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(events1[0]).toMatchObject({ patient_id: uuid(1), provider_id: "PROV1", feature: "app_open", detail: { n: 1, nested: { a: "x", z: 1 } } });
    expect(Object.keys(events1[0])).toEqual([...Object.keys(events1[0])].sort());
    expect(events1[16]).toMatchObject({ feature: "food_log" });
    // Day 2: the midnight row and the -05:00 row (UTC 01:30 on day 2), not day 1's 23:59:59.999.
    const events2 = readNdjson(objects.get(tableFilePath("patient_app_events", D2))!.bytes);
    expect(events2.map((r) => r.feature)).toEqual(["weigh_in", "weigh_in"]);
    expect(events2.map((r) => r.id)).toEqual([18, 19]);
    // Day 3: no events → an empty (but present) file.
    expect(readNdjson(objects.get(tableFilePath("patient_app_events", D3))!.bytes)).toEqual([]);
    // The billing ledger is keyed by occurred_at (both entries on day 1, though one was created on day 2).
    expect(readNdjson(objects.get(tableFilePath("billing_ledger", D1))!.bytes).map((r) => r.kind)).toEqual(expect.arrayContaining(["charge", "platform_fee"]));
    expect(readNdjson(objects.get(tableFilePath("billing_ledger", D2))!.bytes)).toEqual([]);
    // Subscriptions ride updated_at: created day 1, changed day 3 → day 3's file only.
    expect(readNdjson(objects.get(tableFilePath("billing_subscriptions", D1))!.bytes)).toEqual([]);
    expect(readNdjson(objects.get(tableFilePath("billing_subscriptions", D3))!.bytes).map((r) => r.id)).toEqual([uuid(20)]);
    // Audit metadata with unicode and quotes survives verbatim.
    const audit3 = readNdjson(objects.get(tableFilePath("admin_audit_events", D3))!.bytes);
    expect(audit3[0]).toMatchObject({ action: "patient_updated", metadata: { unicode: "é ✓", quote: 'a"b' } });

    // Manifest: version, day, per-table entries with retention class, counts, and checksums that match the written bytes.
    const manifest1 = readManifest(objects.get(manifestPath(D1))!.bytes);
    expect(manifest1).toMatchObject({ version: MANIFEST_VERSION, day: D1, dayBoundary: "utc", rowCount: 17 + 1 + 1 + 2 + 0 + 2 + 0 + 0 });
    expect("generatedAt" in manifest1).toBe(false);
    expect(manifest1.tables.map((t) => t.table)).toEqual(ARCHIVE_TABLES.map((t) => t.name));
    expect(manifest1.tables.map((t) => t.retentionClass)).toEqual(["events", "audit", "financial", "financial", "financial", "financial", "financial", "financial"]);
    expect(manifest1.notes.some((note) => /as stored/.test(note))).toBe(true);
    for (const entry of manifest1.tables) {
      const written = objects.get(entry.path)!.bytes;
      expect(entry.gzipBytes, entry.table).toBe(written.length);
      expect(entry.gzipSha256, entry.table).toBe(sha256(written));
      const plain = gunzipSync(written);
      expect(entry.sha256, entry.table).toBe(sha256(plain));
      expect(entry.uncompressedBytes, entry.table).toBe(plain.length);
      expect(entry.rowCount, entry.table).toBe(readNdjson(written).length);
    }
    expect(manifest1.bytesWritten).toBe(manifest1.tables.reduce((sum, t) => sum + t.gzipBytes, 0));
    const orders = manifest1.tables.find((t) => t.table === "billing_orders")!;
    expect(orders).toMatchObject({ dayColumn: "created_at", rowCount: 1, path: "archive/billing_orders/2026/09/05.ndjson.gz" });
    // Day 3's manifest has zero app events but still lists the table.
    const manifest3 = readManifest(objects.get(manifestPath(D3))!.bytes);
    expect(manifest3.tables.find((t) => t.table === "patient_app_events")).toMatchObject({ rowCount: 0, uncompressedBytes: 0 });

    // Order of writes: for every day, all table files land before the manifest.
    for (const day of [D1, D2, D3]) {
      const manifestAt = writes.indexOf(manifestPath(day));
      for (const table of ARCHIVE_TABLES) expect(writes.indexOf(tableFilePath(table.name, day))).toBeLessThan(manifestAt);
    }

    // The ledger: one row per day, oldest first, and the status RPC reads caught up.
    const marks = rows<{ archive_day: string; manifest_path: string; row_count: number; bytes_written: number; version: number }>(
      "select archive_day::text, manifest_path, row_count, bytes_written, (manifest->>'version')::int as version from public.system_cold_archive_days order by archive_day",
    );
    expect(marks.map((m) => m.archive_day)).toEqual([D1, D2, D3]);
    expect(marks[0]).toMatchObject({ manifest_path: manifestPath(D1), row_count: manifest1.rowCount, bytes_written: manifest1.bytesWritten, version: MANIFEST_VERSION });
    expect(scalar<string>("(manifest->>'generatedAt') from public.system_cold_archive_days where archive_day = date '2026-09-05'")).toBe(NOW.toISOString());
    expect(await status()).toMatchObject({ earliestDay: D1, lastArchivedDay: D3, daysArchived: 3, daysPending: 0, rowsArchived: 31, bytesWritten: marks.reduce((sum, m) => sum + m.bytes_written, 0) });
    expect(await status().then((s) => s.lastArchivedAt && new Date(s.lastArchivedAt).toISOString())).toBe(NOW.toISOString());
    // Live rows are untouched.
    expect(scalar<number>("count(*) from public.patient_app_events")).toBe(20);
    expect(scalar<number>("count(*) from public.billing_orders")).toBe(2);
  });

  it("re-running a day is idempotent: same names, byte-identical files and manifest", async () => {
    const first = memoryStore();
    await run(first.store);
    // Forget the marks so the same days are archived again (as after a crash before the mark).
    psql("delete from public.system_cold_archive_days where archive_day is not null");
    const second = memoryStore();
    const later = new Date("2026-09-08T18:00:00Z");
    const { counts } = await run(second.store, { now: later, pageSize: 3 });
    expect(counts.daysArchived).toBe(3);
    expect([...second.objects.keys()].sort()).toEqual([...first.objects.keys()].sort());
    for (const [name, object] of first.objects) {
      expect(second.objects.get(name)!.bytes.equals(object.bytes), name).toBe(true);
    }
    // The ledger row carries the newer archive time; the files do not.
    expect(scalar<string>("max(archived_at)::text from public.system_cold_archive_days")).toContain("18:00:00");
  });

  it("marks a day only after every file and the manifest landed; a failed upload leaves the day pending", async () => {
    const { store, objects } = memoryStore();
    let puts = 0;
    const flaky: ColdArchiveStore = {
      async put(relativePath, bytes, contentType) {
        puts += 1;
        // Fail on day 1's manifest write (the last file of the first day).
        if (relativePath === manifestPath(D1)) throw new Error("storage returned 503");
        return store.put(relativePath, bytes, contentType);
      },
    };
    await expect(run(flaky)).rejects.toThrow("storage returned 503");
    expect(puts).toBe(ARCHIVE_TABLES.length + 1);
    expect(objects.size).toBe(ARCHIVE_TABLES.length);
    expect(scalar<number>("count(*) from public.system_cold_archive_days")).toBe(0);
    expect(await status()).toMatchObject({ daysPending: 3, lastArchivedDay: null });
    // The next run picks the same day up again and completes everything.
    const { counts } = await run(store);
    expect(counts).toMatchObject({ daysPendingBefore: 3, daysArchived: 3, daysPendingAfter: 0 });
    expect(objects.has(manifestPath(D1))).toBe(true);
  });

  it("takes the oldest days first within the per-run bound and reports the remaining backlog", async () => {
    const { store, objects } = memoryStore();
    const one = await run(store, { maxDays: 1 });
    expect(one.counts).toMatchObject({ daysPendingBefore: 3, daysArchived: 1, daysPendingAfter: 2 });
    expect(rows<{ d: string }>("select archive_day::text as d from public.system_cold_archive_days").map((r) => r.d)).toEqual([D1]);
    expect(objects.has(manifestPath(D2))).toBe(false);
    expect(await status()).toMatchObject({ lastArchivedDay: D1, daysArchived: 1, daysPending: 2 });
    const two = await run(store, { maxDays: 1 });
    expect(two.counts).toMatchObject({ daysPendingBefore: 2, daysArchived: 1, daysPendingAfter: 1 });
    expect(await status()).toMatchObject({ lastArchivedDay: D2, daysPending: 1 });
    // A gap re-opened in the middle is counted pending and archived before nothing else moves.
    psql("delete from public.system_cold_archive_days where archive_day = date '2026-09-05'");
    expect(await status()).toMatchObject({ lastArchivedDay: D2, daysPending: 2 });
    const gap = await run(store, { maxDays: 1 });
    expect(gap.counts).toMatchObject({ daysArchived: 1, daysPendingAfter: 1 });
    expect(rows<{ d: string }>("select archive_day::text as d from public.system_cold_archive_days order by 1").map((r) => r.d)).toEqual([D1, D2]);
  });

  it("dry run counts the days and rows it would archive but writes and marks nothing", async () => {
    const { store, objects } = memoryStore();
    const { counts, logs } = await run(store, { dryRun: true });
    expect(counts).toMatchObject({ daysPendingBefore: 3, daysWouldArchive: 3, rowsWouldArchive: 31, daysPendingAfter: 3 });
    expect(counts.daysArchived).toBeUndefined();
    expect(objects.size).toBe(0);
    expect(scalar<number>("count(*) from public.system_cold_archive_days")).toBe(0);
    expect(logs.filter((l) => l.event === "cold_archive_would_archive").map((l) => l.detail)).toEqual([
      { day: D1, rows: 23 }, { day: D2, rows: 3 }, { day: D3, rows: 5 },
    ]);
  });

  it("does nothing when the HQ toggle is off, and refuses to run on without a storage prefix", async () => {
    const { store, objects } = memoryStore();
    const off = await run(store, { enabled: false });
    expect(off.counts).toEqual({ skippedOff: 1 });
    expect(objects.size).toBe(0);
    expect(scalar<number>("count(*) from public.system_cold_archive_days")).toBe(0);
    await expect(run(store, { configured: false })).rejects.toThrow(/COLD_ARCHIVE_OBJECT_DIR/);
    expect(objects.size).toBe(0);
  });

  it("has nothing pending when the only data is from today, and no earliest day with no data at all", async () => {
    psql(`delete from public.patient_app_events where occurred_at < timestamptz '${TODAY}T00:00:00Z';
          truncate public.admin_audit_events, public.billing_orders, public.billing_order_items, public.billing_shipments, public.billing_ledger, public.billing_refunds, public.billing_subscriptions`);
    expect(await psqlSource.earliestDay()).toBe(TODAY);
    expect(await status()).toMatchObject({ earliestDay: TODAY, daysPending: 0 });
    const { store, objects } = memoryStore();
    const { counts } = await run(store);
    expect(counts).toMatchObject({ daysPendingBefore: 0, daysPendingAfter: 0 });
    expect(objects.size).toBe(0);
    psql("truncate public.patient_app_events");
    expect(await psqlSource.earliestDay()).toBeNull();
    expect(await status()).toMatchObject({ earliestDay: null, daysPending: 0, lastArchivedDay: null });
  });

  it("the row RPC only serves the allowlisted tables and clamps its page size", async () => {
    expect(fails(`select * from public.cold_archive_rows('patients', date '${D1}', null, 10)`)).toMatch(/not archived/);
    expect(fails(`select * from public.cold_archive_rows('hq_organization_settings', date '${D1}', null, 10)`)).toMatch(/not archived/);
    expect(fails(`select * from public.cold_archive_rows(null, date '${D1}', null, 10)`)).toMatch(/required/);
    // Limit 0 becomes 1; keyset continuation resumes strictly after the id.
    expect((await psqlSource.rows("patient_app_events", D1, null, 0)).map((r) => r.row_id)).toEqual(["1"]);
    expect((await psqlSource.rows("patient_app_events", D1, "15", 10)).map((r) => r.row_id)).toEqual(["16", "17"]);
    expect((await psqlSource.rows("billing_orders", D1, uuid(9), 10)).map((r) => r.row_id)).toEqual([uuid(10)]);
    expect((await psqlSource.rows("billing_orders", D1, uuid(10), 10))).toEqual([]);
    // The functions are service-role only.
    const grants = rows<{ grantee: string; routine_name: string }>(
      "select grantee, routine_name from information_schema.routine_privileges where routine_schema = 'public' and routine_name like 'cold_archive_%' and privilege_type = 'EXECUTE' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')",
    );
    expect(new Set(grants.map((g) => g.grantee))).toEqual(new Set(["service_role"]));
    expect(scalar<boolean>("relrowsecurity from pg_class where oid = 'public.system_cold_archive_days'::regclass")).toBe(true);
  });
});
