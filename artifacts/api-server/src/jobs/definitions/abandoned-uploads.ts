/**
 * Abandoned-upload sweep: every issued upload URL leaves an intent row; once
 * an intent is older than the grace window and NO ledger references its
 * path (the union in `storage_referenced_paths`), the bytes are deleted and
 * the intent dropped. Referenced intents were finalized — their rows are
 * simply retired. Paths that fail to delete keep their intent so the next
 * run retries them.
 */
import { objectStorage } from "../../lib/objectStorage";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { envInt } from "../scheduler";
import type { JobContext, JobDefinition } from "../types";

const enc = encodeURIComponent;
const HOUR_MS = 3_600_000;
const BATCH = 200;
const MAX_BATCHES = 25;

export function uploadGraceMs(): number {
  return envInt("JOBS_UPLOAD_GRACE_MS", 6 * HOUR_MS);
}

interface IntentRow {
  object_path: string;
  surface: string;
  issued_at: string;
}

export async function referencedPaths(paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const result = await supabaseAdmin("POST", "/rest/v1/rpc/storage_referenced_paths", { p_paths: paths });
  if (result.status >= 300 || !Array.isArray(result.json)) {
    throw new Error(`storage reference lookup failed (${result.status})`);
  }
  const out = new Set<string>();
  for (const row of result.json as Array<unknown>) {
    if (typeof row === "string") out.add(row);
    else if (row && typeof row === "object" && typeof (row as { object_path?: unknown }).object_path === "string") {
      out.add((row as { object_path: string }).object_path);
    }
  }
  return out;
}

async function deleteIntents(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const list = paths.map((p) => `"${p.replace(/"/g, '\\"')}"`).join(",");
  const result = await supabaseAdmin("DELETE", `/rest/v1/storage_upload_intents?object_path=in.(${enc(list)})`);
  if (result.status >= 300) throw new Error(`upload intent delete failed (${result.status})`);
}

export async function sweepAbandonedUploads(ctx: JobContext): Promise<void> {
  const cutoff = new Date(ctx.now.getTime() - uploadGraceMs()).toISOString();
  ctx.log("abandoned_uploads_cutoff", { cutoff });
  let cursor = "";
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    ctx.checkpoint();
    const page = await supabaseAdmin(
      "GET",
      `/rest/v1/storage_upload_intents?select=object_path,surface,issued_at&issued_at=lt.${enc(cutoff)}` +
        (cursor ? `&object_path=gt.${enc(cursor)}` : "") +
        `&order=object_path.asc&limit=${BATCH}`,
    );
    if (page.status >= 300 || !Array.isArray(page.json)) {
      throw new Error(`upload intent scan failed (${page.status})`);
    }
    const rows = page.json as IntentRow[];
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].object_path;
    const referenced = await referencedPaths(rows.map((r) => r.object_path));
    const finalized: string[] = [];
    for (const row of rows) {
      ctx.checkpoint();
      ctx.tally("scanned");
      if (referenced.has(row.object_path)) {
        ctx.tally("finalized");
        finalized.push(row.object_path);
        continue;
      }
      if (ctx.dryRun) {
        ctx.tally("wouldDelete");
        ctx.tally(`wouldDelete_${row.surface}`);
        continue;
      }
      try {
        await objectStorage.deleteObjectStrict(row.object_path);
        await deleteIntents([row.object_path]);
        ctx.tally("deleted");
        ctx.tally(`deleted_${row.surface}`);
      } catch (error) {
        ctx.failItem(row.object_path, error);
      }
    }
    if (!ctx.dryRun && finalized.length > 0) {
      try {
        await deleteIntents(finalized);
      } catch (error) {
        ctx.failItem(`intents:${finalized.length}`, error);
      }
    }
    if (rows.length < BATCH) break;
  }
}

export const abandonedUploadsJob: JobDefinition = {
  name: "abandoned-uploads",
  title: "Abandoned uploads",
  description: "Deletes uploads whose URL was issued but never finalized (patient media, HQ files, training media, knowledge documents) once past the grace window.",
  intervalMs: HOUR_MS,
  leaseSeconds: 20 * 60,
  run: sweepAbandonedUploads,
};
