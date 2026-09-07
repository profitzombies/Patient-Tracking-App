/**
 * Draining the training media clean-up ledger (`training_media_cleanup`):
 * objects whose strict delete was refused at request time, waiting for a
 * retry. Shared by the opportunistic drain at the top of the finalize routes
 * and the scheduled `training-media-cleanup` job.
 *
 * Reference-aware: a row whose video still references the path is a stale
 * pre-registration (its swap never committed) — the row is dropped and the
 * LIVE object is never touched. Everything else is strictly deleted (missing
 * counts as gone) before its row leaves.
 */
import { objectStorage } from "../lib/objectStorage";
import type { JobContext } from "../jobs/types";
import { deleteMediaCleanup, getVideoRecord, listMediaCleanup, type MediaCleanupRow } from "./videos-store";

function attachmentSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (item && typeof item === "object" && typeof (item as { source?: unknown }).source === "string") {
      out.push((item as { source: string }).source);
    }
  }
  return out;
}

export function videoReferencesPath(
  record: { video_source: string | null; thumbnail_source: string | null; attachments: unknown },
  objectPath: string,
): boolean {
  if (record.video_source === objectPath || record.thumbnail_source === objectPath) return true;
  return attachmentSources(record.attachments).includes(objectPath);
}

/**
 * Settle up to `limit` ledger rows. Reports through the job context when one
 * is given (the scheduled job) and never throws on a per-row failure; a
 * ledger read failure does throw so the run is recorded as failed.
 */
export async function drainTrainingMediaCleanup(ctx: JobContext | null, limit = 10): Promise<{ settled: number; failed: number }> {
  const rows: MediaCleanupRow[] = await listMediaCleanup(limit);
  let settled = 0;
  let failed = 0;
  for (const row of rows) {
    ctx?.checkpoint();
    ctx?.tally("scanned");
    try {
      if (row.video_id) {
        const owner = await getVideoRecord(row.video_id);
        if (owner && videoReferencesPath(owner, row.object_path)) {
          if (!ctx?.dryRun) await deleteMediaCleanup(row.id);
          ctx?.tally("staleRegistrations");
          settled += 1;
          continue;
        }
      }
      if (ctx?.dryRun) {
        ctx.tally("wouldDelete");
        continue;
      }
      await objectStorage.deleteObjectStrict(row.object_path);
      await deleteMediaCleanup(row.id);
      ctx?.tally("deleted");
      settled += 1;
    } catch (error) {
      failed += 1;
      ctx?.failItem(row.object_path, error);
    }
  }
  return { settled, failed };
}
