import { objectStorage } from "../../lib/objectStorage";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";
import { randomUUID } from "node:crypto";

interface ClaimedFile {
  report_id: string;
  staging_object_path: string;
  object_path: string | null;
}

export async function runBloodworkCleanup(ctx: JobContext): Promise<void> {
  const stagingCutoff = new Date(ctx.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (ctx.dryRun) {
    const scan = await supabaseAdmin("GET",
      "/rest/v1/patient_bloodwork_reports?select=id&or=" +
      encodeURIComponent(`(lifecycle_status.eq.deleted,and(lifecycle_status.eq.staging,staging_touched_at.lt.${stagingCutoff}))`) +
      "&limit=50");
    if (scan.status >= 300 || !Array.isArray(scan.json)) throw new Error(`bloodwork cleanup scan failed (${scan.status})`);
    ctx.tally("wouldDelete", scan.json.length);
    return;
  }
  const token = randomUUID();
  const claimed = await supabaseAdmin("POST", "/rest/v1/rpc/bloodwork_claim_cleanup", {
    p_staging_cutoff: stagingCutoff, p_claim_token: token, p_lease_seconds: 1800, p_limit: 50,
  });
  if (claimed.status >= 300 || !Array.isArray(claimed.json)) {
    throw new Error(`bloodwork cleanup claim failed (${claimed.status})`);
  }
  const byReport = new Map<string, ClaimedFile[]>();
  for (const file of claimed.json as ClaimedFile[]) {
    const group = byReport.get(file.report_id) ?? [];
    group.push(file);
    byReport.set(file.report_id, group);
  }
  for (const [reportId, files] of byReport) {
    ctx.checkpoint();
    ctx.tally("scanned");
    try {
      for (const file of files) {
        await objectStorage.deleteObjectStrict(file.staging_object_path);
        if (file.object_path) await objectStorage.deleteObjectStrict(file.object_path);
        ctx.tally("objectsDeleted", file.object_path ? 2 : 1);
      }
      const deleted = await supabaseAdmin("POST", "/rest/v1/rpc/bloodwork_finish_cleanup", {
        p_report_id: reportId, p_claim_token: token,
      });
      if (deleted.status >= 300 || deleted.json !== true) throw new Error(`metadata delete failed (${deleted.status})`);
      ctx.tally("reportsDeleted");
    } catch {
      // Metadata and references remain, so a later run safely retries.
      ctx.failItem(reportId, "BLOODWORK_CLEANUP_FAILED");
    }
  }
}

export const bloodworkCleanupJob: JobDefinition = {
  name: "bloodwork-cleanup",
  title: "Bloodwork report cleanup",
  description: "Deletes bytes for tombstoned reports and abandoned staged reports before removing their reference rows.",
  intervalMs: 60 * 60 * 1000,
  leaseSeconds: 30 * 60,
  run: runBloodworkCleanup,
};