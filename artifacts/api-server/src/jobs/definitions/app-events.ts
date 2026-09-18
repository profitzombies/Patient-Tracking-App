/**
 * App event rollups and the one-time history backfill behind HQ Insights.
 *
 * `app-events-rollup` (every 15 minutes) asks the database to recompute the
 * hourly per-office per-feature buckets for every patient-local day whose
 * raw events changed since the last run — today in every timezone, plus any
 * older day that received a late write or a purge delete — and to stamp
 * closed days finalized. The Insights read serves clean days from the
 * rollups and dirty days from the raw rows, so a missed run only costs
 * speed, never accuracy. Dry runs report the same figures and write nothing.
 *
 * `app-events-backfill` (on demand) seeds events for each feature from the
 * tables that already carry timestamps, in bounded batches per run and only
 * for source rows before that feature's first LIVE event, so history and the
 * live seam never double count. Every source row carries a natural key, so
 * the job is idempotent and can be re-run until it reports nothing left.
 */
import { INSIGHTS_DATASET_KEYS, type InsightsDataset } from "@workspace/app-usage-insights";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";

const MINUTE_MS = 60_000;
export const BACKFILL_BATCH = 2000;
export const BACKFILL_MAX_BATCHES_PER_FEATURE = 25;

export interface RollupSummary {
  daysRolled: number;
  eventsRolled: number;
  daysFinalized: number;
  dirtyRemaining: number;
}

export async function rollupAppEvents(ctx: JobContext): Promise<RollupSummary> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_events_rollup", {
    p_now: ctx.now.toISOString(),
    p_dry_run: ctx.dryRun,
  });
  if (result.status >= 300 || !Array.isArray(result.json) || result.json.length === 0) {
    throw new Error(`app event rollup failed (${result.status})`);
  }
  const row = result.json[0] as Record<string, unknown>;
  const n = (key: string) => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const summary: RollupSummary = {
    daysRolled: n("days_rolled"),
    eventsRolled: n("events_rolled"),
    daysFinalized: n("days_finalized"),
    dirtyRemaining: n("dirty_remaining"),
  };
  ctx.tally(ctx.dryRun ? "wouldRollDays" : "daysRolled", summary.daysRolled);
  ctx.tally(ctx.dryRun ? "wouldRollEvents" : "eventsRolled", summary.eventsRolled);
  ctx.tally(ctx.dryRun ? "wouldFinalizeDays" : "daysFinalized", summary.daysFinalized);
  ctx.tally("dirtyRemaining", summary.dirtyRemaining);
  ctx.log("app_events_rollup", { ...summary, dryRun: ctx.dryRun });
  return summary;
}

async function firstLiveAt(feature: InsightsDataset): Promise<string | null> {
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_event_bounds", { p_feature: feature, p_provider_id: null });
  if (result.status >= 300 || !Array.isArray(result.json)) throw new Error(`app event bounds failed (${result.status})`);
  const row = (result.json[0] ?? {}) as { first_live_at?: unknown };
  return typeof row.first_live_at === "string" ? row.first_live_at : null;
}

export async function backfillAppEvents(ctx: JobContext): Promise<void> {
  for (const feature of INSIGHTS_DATASET_KEYS) {
    ctx.checkpoint();
    // History stops where live recording started (or now, for a feature that
    // has not seen a live event yet).
    const before = (await firstLiveAt(feature)) ?? ctx.now.toISOString();
    let batches = 0;
    let inserted = 0;
    for (; batches < BACKFILL_MAX_BATCHES_PER_FEATURE; batches += 1) {
      ctx.checkpoint();
      const result = await supabaseAdmin("POST", "/rest/v1/rpc/patient_app_events_backfill", {
        p_feature: feature,
        p_before: before,
        p_limit: BACKFILL_BATCH,
        p_dry_run: ctx.dryRun,
      });
      if (result.status >= 300) {
        ctx.failItem(feature, new Error(`backfill failed (${result.status})`));
        break;
      }
      const count = Number(result.json);
      const landed = Number.isFinite(count) ? count : 0;
      inserted += landed;
      ctx.tally(ctx.dryRun ? "wouldInsert" : "inserted", landed);
      ctx.tally(`${ctx.dryRun ? "wouldInsert" : "inserted"}_${feature}`, landed);
      // A dry run never consumes candidates, so one probe per feature is the whole answer.
      if (ctx.dryRun || landed < BACKFILL_BATCH) break;
    }
    if (!ctx.dryRun && batches >= BACKFILL_MAX_BATCHES_PER_FEATURE) ctx.tally("featuresWithMoreLeft");
    ctx.log("app_events_backfill_feature", { feature, before, inserted, batches: Math.min(batches + 1, BACKFILL_MAX_BATCHES_PER_FEATURE), dryRun: ctx.dryRun });
  }
}

export const appEventsRollupJob: JobDefinition = {
  name: "app-events-rollup",
  title: "App usage hourly rollups",
  description: "Rolls patient app events into hourly per-office per-feature buckets for every day that changed, and finalizes days once they have closed in every timezone.",
  intervalMs: 15 * MINUTE_MS,
  leaseSeconds: 10 * 60,
  run: async (ctx) => {
    await rollupAppEvents(ctx);
  },
};

export const appEventsBackfillJob: JobDefinition = {
  name: "app-events-backfill",
  title: "App usage history backfill",
  description: "One-time, re-runnable seed of app events from tables that already carry timestamps (chat, weigh-ins, photos, dose logs, orders, diary) and day-only sources (water, app-open days), stopping at each feature's first live event.",
  intervalMs: null,
  leaseSeconds: 30 * 60,
  run: backfillAppEvents,
};
