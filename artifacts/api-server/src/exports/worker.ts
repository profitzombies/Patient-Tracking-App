/**
 * Export job worker — runs inside the API server process.
 *
 * Lifecycle: queued -> running -> ready | failed | cancelled -> expired.
 *   * `drainQueuedExports` claims one job at a time through the
 *     `claim_next_data_export` RPC (FOR UPDATE SKIP LOCKED, so two server
 *     instances never build the same file), generates the CSV, writes it to
 *     private object storage under a path bound to the job id, and marks the
 *     row ready with its size/row count. Failures land as `failed` with a
 *     short, non-sensitive error string; the job is never retried silently.
 *   * `sweepExpiredExports` deletes the object for every job past its
 *     expiry, then flips the row to `expired` with its path cleared. Delete
 *     is strict: a storage failure keeps the row (and its path) so the next
 *     sweep retries. Rows are pruned entirely once they are well past expiry.
 *   * Cancellation is cooperative. The route flips a QUEUED job straight to
 *     `cancelled`; for a RUNNING job it stamps `cancel_requested_at` and the
 *     worker notices at the next checkpoint (between parts and before each
 *     stored file), deletes every part it already wrote, and marks the row
 *     cancelled. A job that finishes in the same instant never lands as
 *     ready: the ready flip is conditional on no cancel request, and a lost
 *     flip deletes the files again.
 *
 * Both entry points are idempotent and safe to call concurrently with the
 * request handlers; the route kicks a drain right after inserting a job so
 * small exports are ready within a second or two.
 */
import { csvBuffer } from "./csv";
import { GENERATORS, MAX_EXPORT_ROWS } from "./generators";
import { isExportKind, PATIENT_KINDS, type ExportKind, type ExportScope } from "./kinds";
import { buildPatientRecordArchive, type WrittenRecordPart } from "./patient-record";
import { jobsDisabled } from "../jobs/scheduler";
import { logger } from "../lib/logger";
import { objectStorage } from "../lib/objectStorage";
import { supabaseAdmin } from "../lib/supabase-admin";
import { randomUUID } from "crypto";

const enc = encodeURIComponent;

export interface ExportJobRow {
  id: string;
  kind: string;
  status: string;
  requested_by: string;
  requester_kind: string;
  requester_role: string | null;
  provider_id: string | null;
  params: Record<string, unknown> | null;
  file_name: string | null;
  object_path: string | null;
  size_bytes: number | null;
  row_count: number | null;
  error: string | null;
  attempts: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string;
  download_count: number;
  last_downloaded_at: string | null;
  /** Multi-part archives (patient records): every part, in order. */
  parts: ExportPartRow[] | null;
  /** Set by the cancel route while running; the worker stops at its next checkpoint. */
  cancel_requested_at: string | null;
}

/** Thrown inside a build when the requester cancelled the job. */
export class ExportCancelledError extends Error {
  constructor() {
    super("Export cancelled by the requester.");
    this.name = "ExportCancelledError";
  }
}

/** How often (at most) a running build re-reads its row for a cancel request. */
const CANCEL_CHECK_EVERY_MS = 1_500;

/**
 * A checkpoint the archive builder awaits between files and parts. Reads
 * the job row (throttled) and throws ExportCancelledError once the
 * requester has cancelled or the row otherwise stopped being ours to
 * finish (expired/pruned mid-run). A read failure is NOT a cancel: the
 * build continues and the conditional ready flip stays the backstop.
 */
export function cancelCheckpoint(jobId: string, everyMs = CANCEL_CHECK_EVERY_MS, now = () => Date.now()): () => Promise<void> {
  let lastChecked = 0;
  let cancelled = false;
  return async () => {
    if (cancelled) throw new ExportCancelledError();
    const at = now();
    if (at - lastChecked < everyMs) return;
    lastChecked = at;
    try {
      const res = await supabaseAdmin("GET", `/rest/v1/data_exports?id=eq.${enc(jobId)}&select=status,cancel_requested_at&limit=1`);
      if (res.status >= 300 || !Array.isArray(res.json)) throw new Error(`export cancel check failed (${res.status})`);
      const row = res.json[0] as { status: string; cancel_requested_at: string | null } | undefined;
      if (!row || row.status !== "running" || row.cancel_requested_at) cancelled = true;
    } catch (error) {
      logger.warn({ err: error, jobId }, "export cancel check failed; continuing");
    }
    if (cancelled) throw new ExportCancelledError();
  };
}

export interface ExportPartRow {
  part: number;
  fileName: string;
  objectPath: string;
  sizeBytes: number;
  fileCount: number;
}

export function exportObjectPath(jobId: string): string {
  return `/objects/exports/${jobId}/export-${randomUUID()}.csv`;
}

/** Numbered ZIP part of a patient record; the job id stays in the path. */
export function exportPartObjectPath(jobId: string, part: number): string {
  return `/objects/exports/${jobId}/record-part-${String(part).padStart(2, "0")}-${randomUUID()}.zip`;
}

/**
 * Every stored object a job owns: part 1 doubles as object_path, and a
 * still-building office bundle also owns its per-part file-list sidecars
 * (`params.bundle.fileLists`).
 */
export function jobObjectPaths(job: Pick<ExportJobRow, "object_path" | "parts"> & { params?: Record<string, unknown> | null }): string[] {
  const paths = new Set<string>();
  if (job.object_path) paths.add(job.object_path);
  for (const part of job.parts ?? []) if (part.objectPath) paths.add(part.objectPath);
  const bundle = job.params?.bundle;
  const lists = bundle && typeof bundle === "object" ? (bundle as { fileLists?: unknown }).fileLists : null;
  if (Array.isArray(lists)) for (const path of lists) if (typeof path === "string" && path.startsWith("/objects/exports/")) paths.add(path);
  return [...paths];
}

/** Rebuild the frozen scope from the job row (the only input generators get). */
export function scopeFromJob(job: ExportJobRow): ExportScope {
  const params = job.params ?? {};
  const start = typeof params.start === "string" ? params.start : null;
  const end = typeof params.end === "string" ? params.end : null;
  return {
    providerId: job.provider_id,
    officeName: typeof params.officeName === "string" ? params.officeName : null,
    requesterKind: job.requester_kind === "hq" ? "hq" : job.requester_kind === "provider" ? "provider" : "team_member",
    requesterRole: (job.requester_role as ExportScope["requesterRole"]) ?? null,
    range: start && end ? { start, end } : null,
    patient:
      typeof params.patientId === "string" && params.patientId
        ? { id: params.patientId, name: typeof params.patientName === "string" ? params.patientName : "Patient" }
        : null,
  };
}

async function patchJob(jobId: string, patch: Record<string, unknown>, expectStatus?: string, extraFilter = ""): Promise<boolean> {
  const filter = expectStatus ? `&status=eq.${enc(expectStatus)}` : "";
  const res = await supabaseAdmin("PATCH", `/rest/v1/data_exports?id=eq.${enc(jobId)}${filter}${extraFilter}`, patch, "return=representation");
  if (res.status >= 300) throw new Error(`export job update failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length === 1;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Keep storage/DB internals out of the row; the log has the full error.
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) || "Export failed.";
}

/** The ready flip only lands while the job is running AND nobody cancelled it. */
const NOT_CANCELLED = "&cancel_requested_at=is.null";

/** Remove every object a build wrote (best effort, every failure logged). */
async function removeWritten(jobId: string, paths: Iterable<string>, why: string): Promise<void> {
  for (const path of paths) {
    try {
      await objectStorage.deleteObjectStrict(path);
    } catch (cleanupError) {
      logger.error({ err: cleanupError, jobId, objectPath: path }, `${why} export part not removed`);
    }
  }
}

/**
 * One patient's full record: numbered ZIP parts streamed to storage, then a
 * single atomic flip to ready with every part recorded. Progress (parts
 * written so far) rides `params.progress` so the panel can show it.
 */
async function runPatientRecordJob(job: ExportJobRow, scope: ExportScope): Promise<void> {
  const patient = scope.patient;
  if (!patient) throw new Error("patient record export without a patient");
  const objectPaths = new Map<number, string>();
  const checkpoint = cancelCheckpoint(job.id);
  const stem = (job.file_name ?? `thinnr_patient-record_${job.id}`).replace(/\.zip$/i, "");
  const progress = async (patch: Record<string, unknown>) => {
    try {
      await patchJob(job.id, { params: { ...(job.params ?? {}), progress: patch } }, "running");
    } catch (error) {
      logger.warn({ err: error, jobId: job.id }, "export progress not recorded");
    }
  };
  await progress({ stage: "collecting" });
  try {
    const result = await buildPatientRecordArchive(patient.id, {
      exportId: job.id,
      fileNameStem: stem,
      writePart: async (part, stream) => {
        if (objectPaths.size === 0) await progress({ stage: "writing", partsDone: 0 });
        const objectPath = exportPartObjectPath(job.id, part.part);
        objectPaths.set(part.part, objectPath);
        return objectStorage.saveStream(objectPath, stream, "application/zip");
      },
      onPartWritten: async (done, total) => {
        await progress({ stage: "writing", partsDone: done, partsTotal: total });
      },
      checkpoint,
    });
    const parts: ExportPartRow[] = result.parts.map((part: WrittenRecordPart) => ({
      part: part.part,
      fileName: part.fileName,
      objectPath: objectPaths.get(part.part) as string,
      sizeBytes: part.sizeBytes,
      fileCount: part.fileCount,
    }));
    const landed = await patchJob(
      job.id,
      {
        status: "ready",
        object_path: parts[0].objectPath,
        parts,
        size_bytes: parts.reduce((sum, part) => sum + part.sizeBytes, 0),
        row_count: result.manifest.fileCount,
        params: { ...(job.params ?? {}), progress: { stage: "ready", partsDone: parts.length, partsTotal: parts.length }, omitted: result.manifest.omitted.length },
        completed_at: new Date().toISOString(),
        error: null,
      },
      "running",
      NOT_CANCELLED,
    );
    if (!landed) {
      // Cancelled (or expired/pruned) in the last instant: the row is not
      // ours to finish, and a cancelled record owns no files.
      await removeWritten(job.id, [...objectPaths.values()], "cancelled");
      objectPaths.clear();
      throw new ExportCancelledError();
    }
  } catch (error) {
    // Never leave half a record behind: a failed or cancelled build owns no files.
    await removeWritten(job.id, objectPaths.values(), error instanceof ExportCancelledError ? "cancelled" : "failed");
    throw error;
  }
}

/**
 * Terminal state for a build that stopped on a cancel request. The row may
 * already be cancelled (queued cancel) or gone (pruned); either way there is
 * nothing more to record.
 */
async function markCancelled(jobId: string): Promise<void> {
  const landed = await patchJob(
    jobId,
    { status: "cancelled", object_path: null, parts: null, size_bytes: null, row_count: null, error: null, completed_at: new Date().toISOString() },
    "running",
  );
  if (!landed) logger.info({ jobId }, "export cancelled; row already moved on");
}

/** Generate one claimed job to completion. Exported for tests. */
export async function runExportJob(job: ExportJobRow): Promise<void> {
  const kind = job.kind;
  try {
    if (!isExportKind(kind)) throw new Error(`unknown export kind ${kind}`);
    if (PATIENT_KINDS.has(kind)) {
      await runPatientRecordJob(job, scopeFromJob(job));
      return;
    }
    const sheet = await GENERATORS[kind as ExportKind](scopeFromJob(job));
    // A CSV has one checkpoint: after the rows are gathered, before any file exists.
    await cancelCheckpoint(job.id, 0)();
    const rows = sheet.rows.slice(0, MAX_EXPORT_ROWS);
    const buffer = csvBuffer(sheet.header, rows);
    const objectPath = exportObjectPath(job.id);
    await objectStorage.saveBuffer(objectPath, buffer, "text/csv; charset=utf-8");
    const landed = await patchJob(
      job.id,
      { status: "ready", object_path: objectPath, size_bytes: buffer.byteLength, row_count: rows.length, completed_at: new Date().toISOString(), error: null },
      "running",
      NOT_CANCELLED,
    );
    if (!landed) {
      // The row moved on without us (cancelled/expired/pruned mid-run): don't orphan the file.
      await objectStorage.deleteObjectStrict(objectPath);
      throw new ExportCancelledError();
    }
  } catch (error) {
    if (error instanceof ExportCancelledError) {
      logger.info({ jobId: job.id, kind }, "export job cancelled");
      try {
        await markCancelled(job.id);
      } catch (patchError) {
        logger.error({ err: patchError, jobId: job.id }, "export cancellation not recorded");
      }
      return;
    }
    logger.error({ err: error, jobId: job.id, kind }, "export job failed");
    try {
      await patchJob(job.id, { status: "failed", error: shortError(error), completed_at: new Date().toISOString() }, "running");
    } catch (patchError) {
      logger.error({ err: patchError, jobId: job.id }, "export job failure not recorded");
    }
  }
}

let draining: Promise<number> | null = null;

/**
 * Claim and run queued jobs until the queue is empty. Concurrent callers
 * share one drain; the returned count is how many jobs THIS drain ran.
 */
export function drainQueuedExports(maxJobs = 20): Promise<number> {
  if (draining) return draining;
  draining = (async () => {
    let ran = 0;
    try {
      while (ran < maxJobs) {
        const claimed = await supabaseAdmin("POST", "/rest/v1/rpc/claim_next_data_export", {});
        if (claimed.status >= 300) throw new Error(`export claim failed (${claimed.status})`);
        const job = Array.isArray(claimed.json) ? (claimed.json[0] as ExportJobRow | undefined) : undefined;
        if (!job) break;
        await runExportJob(job);
        ran += 1;
      }
    } catch (error) {
      logger.error({ err: error }, "export drain stopped");
    } finally {
      draining = null;
    }
    return ran;
  })();
  return draining;
}

/** Days an expired row lingers (status "expired") before it is pruned. */
const PRUNE_AFTER_DAYS = 14;

/** Expire past-due jobs (deleting their files) and prune long-expired rows. */
export async function sweepExpiredExports(now = new Date()): Promise<{ expired: number; pruned: number }> {
  const nowIso = now.toISOString();
  const due = await supabaseAdmin(
    "GET",
    `/rest/v1/data_exports?select=id,object_path,parts,params,status&status=in.(queued,running,ready,failed,cancelled)&expires_at=lt.${enc(nowIso)}&order=expires_at.asc&limit=200`,
  );
  if (due.status >= 300 || !Array.isArray(due.json)) throw new Error(`export expiry scan failed (${due.status})`);
  let expired = 0;
  for (const row of due.json as Array<{ id: string; object_path: string | null; parts: ExportPartRow[] | null; params: Record<string, unknown> | null; status: string }>) {
    try {
      // Every part goes before the row flips; a strict delete failure keeps
      // the row (and its paths) so the next sweep retries the whole set.
      for (const path of jobObjectPaths(row)) await objectStorage.deleteObjectStrict(path);
      const patch: Record<string, unknown> = { status: "expired", object_path: null, parts: null };
      if (row.status === "queued" || row.status === "running") patch.error = "Expired before it could finish.";
      await patchJob(row.id, patch);
      expired += 1;
    } catch (error) {
      logger.error({ err: error, jobId: row.id }, "export expiry failed; will retry");
    }
  }
  const pruneBefore = new Date(now.getTime() - PRUNE_AFTER_DAYS * 86_400_000).toISOString();
  const pruned = await supabaseAdmin(
    "DELETE",
    `/rest/v1/data_exports?status=eq.expired&expires_at=lt.${enc(pruneBefore)}`,
    undefined,
    "return=representation",
  );
  if (pruned.status >= 300) throw new Error(`export prune failed (${pruned.status})`);
  return { expired, pruned: Array.isArray(pruned.json) ? pruned.json.length : 0 };
}

let timers: { drain: NodeJS.Timeout } | null = null;

/**
 * Drains queued exports on a timer (once per process). Expiry of finished
 * archives is NOT on a timer here any more: the `retention-exports` job
 * (src/jobs) runs `sweepExpiredExports` under a lease so overlapping
 * processes never race.
 *
 * JOBS_DISABLED=1 (production autoscale) leaves the loop off: the external
 * job tick runs `drainQueuedExports` instead (src/jobs/worker-drains.ts).
 */
export function startExportWorker(input: { drainEveryMs?: number } = {}): void {
  if (timers) return;
  if (jobsDisabled()) {
    logger.info("export worker disabled (JOBS_DISABLED); the internal job tick drains exports");
    return;
  }
  const drainEveryMs = input.drainEveryMs ?? 15_000;
  const drain = setInterval(() => {
    void drainQueuedExports();
  }, drainEveryMs);
  drain.unref();
  timers = { drain };
  // Pick up anything left queued by a previous process.
  void drainQueuedExports();
}

export function stopExportWorker(): void {
  if (!timers) return;
  clearInterval(timers.drain);
  timers = null;
}
