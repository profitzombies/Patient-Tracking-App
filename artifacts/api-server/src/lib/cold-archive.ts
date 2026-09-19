/**
 * Cold archive plumbing shared by the HQ settings routes, the System health
 * page, the threshold evaluator, and the cold-archive job:
 *
 *   - the storage prefix knob (COLD_ARCHIVE_OBJECT_DIR, "/<bucket>/<prefix>")
 *     and its startup validation,
 *   - the object store the job writes through (default: the bucket the knob
 *     names, via the shared GCS client),
 *   - the status read (backlog, last archived day, bytes written) backed by
 *     the cold_archive_status SQL function.
 *
 * The knob is read at call time (blank-checked; see lib/env.ts for why
 * Number("") style traps matter) so tests can pin it per case.
 */
import { objectStorage } from "./objectStorage";
import { loadOrgPolicy } from "./org-policy";
import { supabaseAdmin } from "./supabase-admin";

export const COLD_ARCHIVE_ENV = "COLD_ARCHIVE_OBJECT_DIR";

/** "/<bucket>/<prefix...>" — a bucket plus at least one path segment, no trailing slash, no blanks. */
const OBJECT_DIR_RE = /^\/[^/\s]+(?:\/[^/\s]+)+$/;

/** The configured prefix (normalised, no trailing slash) or null when the knob is blank. */
export function coldArchiveObjectDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[COLD_ARCHIVE_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!OBJECT_DIR_RE.test(withSlash)) {
    throw new Error(`${COLD_ARCHIVE_ENV} must look like /<bucket>/<prefix> (got ${JSON.stringify(raw)})`);
  }
  return withSlash;
}

export function coldArchiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return coldArchiveObjectDir(env) !== null;
}

export const COLD_ARCHIVE_NOT_CONFIGURED = `Cold storage is not configured: set ${COLD_ARCHIVE_ENV} (/<bucket>/<prefix>) on the server before turning the archive on.`;

/**
 * Startup check. A malformed knob throws (misconfiguration must not boot);
 * an enabled toggle with no knob is reported to the caller so it can log an
 * error — the job itself fails visibly on every run until one of the two
 * is fixed.
 */
export function validateColdArchiveStartup(input: { enabled: boolean; env?: NodeJS.ProcessEnv }): { ok: true } | { ok: false; error: string } {
  const dir = coldArchiveObjectDir(input.env ?? process.env);
  if (input.enabled && dir === null) return { ok: false, error: COLD_ARCHIVE_NOT_CONFIGURED };
  return { ok: true };
}

/** Where the job writes. Paths are relative to the configured prefix (e.g. "archive/billing_orders/2026/09/18.ndjson.gz"). */
export interface ColdArchiveStore {
  put(relativePath: string, bytes: Buffer, contentType: string): Promise<void>;
}

export const defaultColdArchiveStore: ColdArchiveStore = {
  async put(relativePath, bytes, contentType) {
    const dir = coldArchiveObjectDir();
    if (dir === null) throw new Error(COLD_ARCHIVE_NOT_CONFIGURED);
    await objectStorage.saveBufferAt(`${dir}/${relativePath}`, bytes, contentType);
  },
};

export interface ColdArchiveStatus {
  earliestDay: string | null;
  lastArchivedDay: string | null;
  lastArchivedAt: string | null;
  daysArchived: number;
  daysPending: number;
  rowsArchived: number;
  bytesWritten: number;
}

interface StatusRow {
  earliest_day: string | null;
  last_archived_day: string | null;
  last_archived_at: string | null;
  days_archived: number | string | null;
  days_pending: number | string | null;
  rows_archived: number | string | null;
  bytes_written: number | string | null;
}

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Backlog and high-water tallies as of `now` (closed UTC days before today count as pending). */
export async function readColdArchiveStatus(now: Date): Promise<ColdArchiveStatus> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/cold_archive_status", { p_today: utcDay(now) });
  if (result.status >= 300) throw new Error(`cold archive status read failed (${result.status})`);
  const row = Array.isArray(result.json) ? (result.json[0] as StatusRow | undefined) : (result.json as StatusRow | undefined);
  if (!row || typeof row !== "object") throw new Error("cold archive status returned no row");
  const num = (value: number | string | null | undefined) => {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) throw new Error("cold archive status returned a non-numeric tally");
    return n;
  };
  return {
    earliestDay: row.earliest_day ?? null,
    lastArchivedDay: row.last_archived_day ?? null,
    lastArchivedAt: row.last_archived_at ?? null,
    daysArchived: num(row.days_archived),
    daysPending: num(row.days_pending),
    rowsArchived: num(row.rows_archived),
    bytesWritten: num(row.bytes_written),
  };
}

/** What System health and the threshold evaluator read: the toggle, the knob, and the ledger tallies. */
export interface ColdArchiveHealth extends ColdArchiveStatus {
  enabled: boolean;
  storageConfigured: boolean;
}

export async function readColdArchiveHealth(
  now: Date,
  deps: { enabled?: () => Promise<boolean>; status?: (now: Date) => Promise<ColdArchiveStatus>; env?: NodeJS.ProcessEnv } = {},
): Promise<ColdArchiveHealth> {
  const [policy, status] = await Promise.all([
    deps.enabled ? deps.enabled() : loadOrgPolicy().then((p) => p.coldArchiveEnabled),
    (deps.status ?? readColdArchiveStatus)(now),
  ]);
  return { enabled: policy, storageConfigured: coldArchiveConfigured(deps.env ?? process.env), ...status };
}
