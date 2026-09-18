/**
 * Two-way storage reconciliation, per object prefix:
 *
 *   storage → ledger   an object no ledger row references, older than the
 *                      orphan grace window and not covered by a live upload
 *                      intent, is deleted.
 *   ledger → storage   a ledger row whose object is gone is flagged
 *                      (`*_missing_at`) so the UI shows "file unavailable";
 *                      a flagged row whose object reappears is unflagged.
 *
 * Ledger sources without a flag column (progress photos, chat photos, custom
 * food/recipe photos, training attachments) are counted and logged, never
 * silently ignored. The training clean-up queue is a reference (pending
 * delete), not a ledger to flag.
 *
 * Photo display variants (`<original>.thumb` / `<original>.medium`, see
 * lib/photo-variants) have no ledger row of their own: a variant object is
 * owned exactly when its ORIGINAL is on a ledger, and a patient_media row
 * that records a variant whose object is gone has that entry cleared so
 * readers fall back to the original instead of a broken image.
 */
import { objectStorage, type StoredObjectSummary } from "../../lib/objectStorage";
import { availableVariants, parsePhotoVariantPath, photoVariantPath } from "../../lib/photo-variants";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { envInt } from "../scheduler";
import type { JobContext, JobDefinition } from "../types";

const enc = encodeURIComponent;
const HOUR_MS = 3_600_000;
const LEDGER_PAGE = 1000;
const CHUNK = 200;

export const RECONCILE_PREFIXES = [
  "/objects/patient-media/",
  "/objects/patients/",
  "/objects/hq-files/",
  "/objects/training-videos/",
  "/objects/training-attachments/",
  "/objects/knowledge-docs/",
  "/objects/exports/",
] as const;

/** Ledger sources whose rows carry a missing flag. */
export const FLAGGABLE_SOURCES = new Set([
  "patient_media",
  "hq_private_files",
  "knowledge_documents",
  "training_video",
  "training_thumbnail",
  "data_exports",
  "patient_data_exports",
]);

export function orphanGraceMs(): number {
  return envInt("JOBS_ORPHAN_GRACE_MS", 24 * HOUR_MS);
}

export interface LedgerEntry {
  sources: string[];
  missing: boolean;
  flaggable: boolean;
}

interface LedgerRow {
  object_path: string;
  source: string;
  missing: boolean;
}

export async function loadLedger(prefix: string): Promise<Map<string, LedgerEntry>> {
  const ledger = new Map<string, LedgerEntry>();
  let after = "";
  for (let page = 0; page < 10_000; page += 1) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/storage_ledger_paths", {
      p_prefix: prefix,
      p_after: after || null,
      p_limit: LEDGER_PAGE,
    });
    if (result.status >= 300 || !Array.isArray(result.json)) {
      throw new Error(`storage ledger read failed (${result.status})`);
    }
    const rows = result.json as LedgerRow[];
    for (const row of rows) {
      if (row.source === "training_media_cleanup") {
        // A queued delete references the object (not an orphan) but is not
        // a ledger entry to flag.
        if (!ledger.has(row.object_path)) ledger.set(row.object_path, { sources: [], missing: false, flaggable: false });
        continue;
      }
      const entry = ledger.get(row.object_path);
      if (entry) {
        entry.sources.push(row.source);
        entry.missing = entry.missing || row.missing === true;
        entry.flaggable = entry.flaggable || FLAGGABLE_SOURCES.has(row.source);
      } else {
        ledger.set(row.object_path, {
          sources: [row.source],
          missing: row.missing === true,
          flaggable: FLAGGABLE_SOURCES.has(row.source),
        });
      }
    }
    if (rows.length < LEDGER_PAGE) break;
    after = rows[rows.length - 1].object_path;
  }
  return ledger;
}

/**
 * Whether a stored object is referenced: by a ledger row of its own, or —
 * for a photo display variant — by its original's ledger row.
 */
export function isReferencedObject(path: string, ledger: Map<string, LedgerEntry>): boolean {
  if (ledger.has(path)) return true;
  const variant = parsePhotoVariantPath(path);
  return variant !== null && ledger.has(variant.originalPath);
}

const VARIANT_PREFIX = "/objects/patient-media/";

interface VariantRow {
  object_path: string;
  variants: unknown;
}

/**
 * ledger → storage for variants: patient_media rows that record a variant
 * whose object is gone lose that entry (the backfill regenerates it later).
 * Rows are paged by object_path; only rows with something recorded count.
 */
export async function reconcileVariantFlags(ctx: JobContext, stored: Map<string, StoredObjectSummary>): Promise<void> {
  let after = "";
  for (let page = 0; page < 10_000; page += 1) {
    ctx.checkpoint();
    const result = await supabaseAdmin(
      "GET",
      "/rest/v1/patient_media?select=object_path,variants&variants=neq.{}" +
        `&object_path=gt.${enc(after)}&order=object_path.asc&limit=${LEDGER_PAGE}`,
    );
    if (result.status >= 300 || !Array.isArray(result.json)) {
      throw new Error(`patient media variant read failed (${result.status})`);
    }
    const rows = result.json as VariantRow[];
    for (const row of rows) {
      ctx.checkpoint();
      const recorded = availableVariants(row.variants);
      const present = recorded.filter((variant) => stored.has(photoVariantPath(row.object_path, variant)));
      if (present.length === recorded.length) continue;
      if (ctx.dryRun) {
        ctx.tally("variantsMissingFound", recorded.length - present.length);
        continue;
      }
      const patch = await supabaseAdmin(
        "PATCH",
        `/rest/v1/patient_media?object_path=eq.${enc(row.object_path)}`,
        { variants: present },
        "return=minimal",
      );
      if (patch.status >= 300) {
        ctx.failItem(`variants:${row.object_path}`, new Error(`variant flag update failed (${patch.status})`));
        continue;
      }
      ctx.tally("variantsMissingCleared", recorded.length - present.length);
    }
    if (rows.length < LEDGER_PAGE) break;
    after = rows[rows.length - 1].object_path;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function liveIntents(paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunks(paths, CHUNK)) {
    const list = chunk.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(",");
    const result = await supabaseAdmin("GET", `/rest/v1/storage_upload_intents?select=object_path&object_path=in.(${enc(list)})`);
    if (result.status >= 300 || !Array.isArray(result.json)) {
      throw new Error(`upload intent lookup failed (${result.status})`);
    }
    for (const row of result.json as Array<{ object_path: string }>) out.add(row.object_path);
  }
  return out;
}

async function markMissing(paths: string[], missing: boolean): Promise<number> {
  let changed = 0;
  for (const chunk of chunks(paths, CHUNK)) {
    const result = await supabaseAdmin("POST", "/rest/v1/rpc/storage_mark_object_missing", { p_paths: chunk, p_missing: missing });
    if (result.status >= 300) throw new Error(`storage missing flag update failed (${result.status})`);
    changed += typeof result.json === "number" ? result.json : Number(result.json) || 0;
  }
  return changed;
}

export async function reconcilePrefix(ctx: JobContext, prefix: string): Promise<void> {
  let objects: StoredObjectSummary[];
  try {
    objects = await objectStorage.listObjects(prefix);
  } catch (error) {
    ctx.failItem(`list:${prefix}`, error);
    return;
  }
  const ledger = await loadLedger(prefix);
  const stored = new Map(objects.map((o) => [o.path, o]));
  ctx.tally("objects", objects.length);
  ctx.tally("ledgerRows", ledger.size);

  // storage → ledger: orphans
  const graceCutoff = ctx.now.getTime() - orphanGraceMs();
  const unreferenced = objects.filter((o) => !isReferencedObject(o.path, ledger));
  const candidates = unreferenced.filter((o) => o.createdAt !== null && o.createdAt.getTime() <= graceCutoff);
  ctx.tally("orphanYoung", unreferenced.length - candidates.length);
  const protectedPaths = candidates.length > 0 ? await liveIntents(candidates.map((o) => o.path)) : new Set<string>();
  for (const orphan of candidates) {
    ctx.checkpoint();
    if (protectedPaths.has(orphan.path)) {
      // An intent still exists: the abandoned-upload sweep owns this path.
      ctx.tally("orphanPendingUpload");
      continue;
    }
    if (ctx.dryRun) {
      ctx.tally("orphansFound");
      continue;
    }
    try {
      await objectStorage.deleteObjectStrict(orphan.path);
      ctx.tally("orphansDeleted");
    } catch (error) {
      ctx.failItem(orphan.path, error);
    }
  }

  // ledger → storage: missing objects
  const newlyMissing: string[] = [];
  const unflaggable: string[] = [];
  let knownMissing = 0;
  const recovered: string[] = [];
  for (const [path, entry] of ledger) {
    ctx.checkpoint();
    if (entry.sources.length === 0) continue; // clean-up queue only
    const present = stored.has(path);
    if (!present) {
      if (entry.missing) knownMissing += 1;
      else if (entry.flaggable) newlyMissing.push(path);
      else unflaggable.push(path);
    } else if (entry.missing) {
      recovered.push(path);
    }
  }
  ctx.tally("missingKnown", knownMissing);
  if (unflaggable.length > 0) {
    ctx.tally("missingUnflaggable", unflaggable.length);
    ctx.log("missing_objects_without_flag", { prefix, sample: unflaggable.slice(0, 20), total: unflaggable.length });
  }
  if (prefix === VARIANT_PREFIX) {
    try {
      await reconcileVariantFlags(ctx, stored);
    } catch (error) {
      ctx.failItem(`variants:${prefix}`, error);
    }
  }
  if (ctx.dryRun) {
    ctx.tally("missingFound", newlyMissing.length);
    ctx.tally("recoveredFound", recovered.length);
    return;
  }
  if (newlyMissing.length > 0) {
    try {
      await markMissing(newlyMissing, true);
      ctx.tally("missingFlagged", newlyMissing.length);
    } catch (error) {
      ctx.failItem(`flag:${prefix}`, error);
    }
  }
  if (recovered.length > 0) {
    try {
      await markMissing(recovered, false);
      ctx.tally("recovered", recovered.length);
    } catch (error) {
      ctx.failItem(`unflag:${prefix}`, error);
    }
  }
}

export async function reconcileStorage(ctx: JobContext): Promise<void> {
  ctx.log("reconcile_storage_start", { prefixes: RECONCILE_PREFIXES, orphanGraceMs: orphanGraceMs() });
  for (const prefix of RECONCILE_PREFIXES) {
    ctx.checkpoint();
    await reconcilePrefix(ctx, prefix);
  }
}

export const reconcileStorageJob: JobDefinition = {
  name: "reconcile-storage",
  title: "Storage reconciliation",
  description: "Compares object storage against the database in both directions: deletes unreferenced objects past the grace window and flags rows whose file is missing.",
  intervalMs: 6 * HOUR_MS,
  leaseSeconds: 60 * 60,
  run: reconcileStorage,
};
