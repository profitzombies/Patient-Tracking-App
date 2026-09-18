/**
 * Queue drains that used to depend solely on process timers.
 *
 * Office CSV exports, patient data exports, and due account purges each have
 * an in-process worker loop (src/exports/worker.ts, src/privacy/worker.ts).
 * On an autoscale deployment those loops are off (JOBS_DISABLED=1), so the
 * internal job tick runs the same drains here: every external tick moves
 * queued exports and due purges along, and no worker family depends on a
 * long-lived process. The drains are single-flight inside each module and
 * lease their rows in the database, so a timer and a tick overlapping is
 * harmless.
 *
 * One drain failing never hides the others: each is isolated and reported.
 */
import { logger } from "../lib/logger";
import { drainQueuedExports } from "../exports/worker";
import { drainPatientExports } from "../privacy/exports";
import { drainDuePurges } from "../privacy/purge";

export type WorkerDrainName = "officeExports" | "patientExports" | "purges";
export const WORKER_DRAIN_NAMES: readonly WorkerDrainName[] = ["officeExports", "patientExports", "purges"];

export type WorkerDrains = Record<WorkerDrainName, () => Promise<number>>;

export const defaultWorkerDrains: WorkerDrains = {
  officeExports: () => drainQueuedExports(),
  patientExports: () => drainPatientExports(),
  purges: () => drainDuePurges(),
};

export interface WorkerDrainResult {
  /** Items processed per family (0 when nothing was queued or the drain failed). */
  counts: Record<WorkerDrainName, number>;
  /** Families whose drain threw, with the message. */
  failed: Array<{ drain: WorkerDrainName; error: string }>;
}

export async function runWorkerDrains(drains: WorkerDrains = defaultWorkerDrains): Promise<WorkerDrainResult> {
  const counts: Record<WorkerDrainName, number> = { officeExports: 0, patientExports: 0, purges: 0 };
  const failed: WorkerDrainResult["failed"] = [];
  for (const name of WORKER_DRAIN_NAMES) {
    try {
      const n = await drains[name]();
      counts[name] = Number.isFinite(n) ? n : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message || error.name : String(error);
      failed.push({ drain: name, error: message });
      logger.error({ err: error, drain: name }, "worker drain failed during tick");
    }
  }
  return { counts, failed };
}
