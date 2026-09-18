/**
 * Photo variant backfill: progress and chat photos uploaded before display
 * variants existed (or whose render failed at finalize) get their thumb and
 * medium siblings generated here, in batches, under the leased job ledger.
 *
 * Work queue = patient_media rows of a variant-eligible kind, whose object
 * is not flagged missing, that still lack a variant. Rows are walked in
 * object_path order (keyset), so a run never re-reads what it already
 * handled. Every attempt — success or failure — stamps
 * `variants_attempted_at`; a failed row is retried only once the retry
 * window has passed, so one undecodable photo cannot pin the queue.
 *
 * Idempotent: a second run over the same rows finds them complete and
 * skips them; regenerating a variant overwrites the same sibling path.
 * Dry run counts due rows and writes nothing.
 */
import { availableVariants, generatePhotoVariants, hasAllVariants } from "../../lib/photo-variants";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { envInt } from "../scheduler";
import type { JobContext, JobDefinition } from "../types";

const enc = encodeURIComponent;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Rows examined per page; each page is one leased unit of work. */
export const BACKFILL_BATCH = 50;
/** Most pages a single run walks before yielding to the next interval. */
export const BACKFILL_MAX_BATCHES = 40;

/** A failed row waits this long before the backfill tries it again. */
export function variantRetryMs(): number {
  return envInt("JOBS_PHOTO_VARIANT_RETRY_MS", 7 * DAY_MS);
}

interface PendingRow {
  object_path: string;
  variants: unknown;
  variants_attempted_at: string | null;
}

async function pendingPage(after: string): Promise<PendingRow[]> {
  const result = await supabaseAdmin(
    "GET",
    "/rest/v1/patient_media?select=object_path,variants,variants_attempted_at" +
      "&kind=in.(progress,chat)&object_missing_at=is.null" +
      "&variants=not.cs.{thumb,medium}" +
      `&object_path=gt.${enc(after)}&order=object_path.asc&limit=${BACKFILL_BATCH}`,
  );
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`photo variant queue read failed (${result.status})`);
  }
  return result.json as PendingRow[];
}

async function recordAttempt(objectPath: string, variants: string[], at: Date): Promise<void> {
  const result = await supabaseAdmin(
    "PATCH",
    `/rest/v1/patient_media?object_path=eq.${enc(objectPath)}`,
    { variants, variants_attempted_at: at.toISOString() },
    "return=minimal",
  );
  if (result.status >= 300) throw new Error(`photo variant record failed (${result.status})`);
}

export async function backfillPhotoVariants(ctx: JobContext): Promise<void> {
  const retryCutoff = ctx.now.getTime() - variantRetryMs();
  ctx.log("photo_variants_backfill_start", { batch: BACKFILL_BATCH, retryMs: variantRetryMs() });
  let after = "";
  for (let batch = 0; batch < BACKFILL_MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const rows = await pendingPage(after);
    for (const row of rows) {
      ctx.checkpoint();
      ctx.tally("scanned");
      if (hasAllVariants(row.variants)) {
        // The partial index and filter should exclude these; counted so a
        // drift between the two shows up rather than silently costing work.
        ctx.tally("alreadyComplete");
        continue;
      }
      const attempted = row.variants_attempted_at ? Date.parse(row.variants_attempted_at) : Number.NaN;
      if (Number.isFinite(attempted) && attempted > retryCutoff) {
        ctx.tally("waitingRetry");
        continue;
      }
      if (ctx.dryRun) {
        ctx.tally("due");
        continue;
      }
      try {
        const variants = await generatePhotoVariants(row.object_path);
        await recordAttempt(row.object_path, variants, ctx.now);
        ctx.tally("generated");
      } catch (error) {
        ctx.failItem(row.object_path, error, { reportLocal: true });
        try {
          // Stamp the failure so the row waits out the retry window instead
          // of being retried on every run; keep whatever variants it had.
          await recordAttempt(row.object_path, availableVariants(row.variants), ctx.now);
        } catch (recordError) {
          ctx.failItem(`record:${row.object_path}`, recordError);
        }
      }
    }
    if (rows.length < BACKFILL_BATCH) break;
    after = rows[rows.length - 1].object_path;
  }
}

export const photoVariantsBackfillJob: JobDefinition = {
  name: "photo-variants-backfill",
  title: "Photo variant backfill",
  description: "Generates missing thumbnail and medium display variants for progress and chat photos in batches; originals are never changed.",
  intervalMs: HOUR_MS,
  leaseSeconds: 30 * 60,
  run: backfillPhotoVariants,
};
