/**
 * Export job worker — runs inside the API server process.
 *
 * Lifecycle: queued -> running -> ready | failed -> expired.
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

/** Every stored object a job owns (part 1 doubles as object_path). */
export function jobObjectPaths(job: Pick<ExportJobRow, "object_path" | "parts">): string[] {
  const paths = new Set<string>();
  if (job.object_path) paths.add(job.object_path);
  for (const part of job.parts ?? []) if (part.objectPath) paths.add(part.objectPath);
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

async function patchJob(jobId: string, patch: Record<string, unknown>, expectStatus?: string): Promise<boolean> {
  const filter = expectStatus ? `&status=eq.${enc(expectStatus)}` : "";
  const res = await supabaseAdmin("PATCH", `/rest/v1/data_exports?id=eq.${enc(jobId)}${filter}`, patch, "return=representation");
  if (res.status >= 300) throw new Error(`export job update failed (${res.status})`);
  return Array.isArray(res.json) && res.json.length === 1;
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Keep storage/DB internals out of the row; the log has the full error.
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 300) || "Export failed.";
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
    );
    if (!landed) {
      for (const path of objectPaths.values()) await objectStorage.deleteObjectStrict(path);
    }
  } catch (error) {
    // Never leave half a record behind: a failed build owns no files.
    for (const path of objectPaths.values()) {
      try {
        await objectStorage.deleteObjectStrict(path);
      } catch (cleanupError) {
        logger.error({ err: cleanupError, jobId: job.id, objectPath: path }, "failed export part not removed");
      }
    }
    throw error;
  }
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
    const rows = sheet.rows.slice(0, MAX_EXPORT_ROWS);
    const buffer = csvBuffer(sheet.header, rows);
    const objectPath = exportObjectPath(job.id);
    await objectStorage.saveBuffer(objectPath, buffer, "text/csv; charset=utf-8");
    const landed = await patchJob(
      job.id,
      { status: "ready", object_path: objectPath, size_bytes: buffer.byteLength, row_count: rows.length, completed_at: new Date().toISOString(), error: null },
      "running",
    );
    if (!landed) {
      // The row moved on without us (expired/pruned mid-run): don't orphan the file.
      await objectStorage.deleteObjectStrict(objectPath);
    }
  } catch (error) {
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
    `/rest/v1/data_exports?select=id,object_path,parts,status&status=in.(queued,running,ready,failed)&expires_at=lt.${enc(nowIso)}&order=expires_at.asc&limit=200`,
  );
  if (due.status >= 300 || !Array.isArray(due.json)) throw new Error(`export expiry scan failed (${due.status})`);
  let expired = 0;
  for (const row of due.json as Array<{ id: string; object_path: string | null; parts: ExportPartRow[] | null; status: string }>) {
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
