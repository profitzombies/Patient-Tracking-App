import { safeCoachTitle } from "../../coach/title";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";

export async function runCoachTitleProcessing(ctx: JobContext): Promise<void> {
  if (ctx.dryRun) {
    const due = await supabaseAdmin("POST", "/rest/v1/rpc/coach_memory_due_count", { p_kind: "title" });
    if (due.status >= 300 || typeof due.json !== "number") throw new Error(`coach title due count failed (${due.status})`);
    ctx.tally("workDue", due.json);
    return;
  }
  for (let i = 0; i < 25; i += 1) {
    ctx.checkpoint();
    const claim = await supabaseAdmin("POST", "/rest/v1/rpc/coach_title_claim_processing", { p_lease_seconds: 300 });
    if (claim.status >= 300) throw new Error(`coach title claim failed (${claim.status})`);
    if (!Array.isArray(claim.json) || !claim.json.length || typeof claim.json[0] !== "object" || claim.json[0] === null) return;
    const row = claim.json[0] as { work_id?: unknown; conversation_id?: unknown; patient_id?: unknown; text?: unknown; claim_token?: unknown };
    if (typeof row.work_id !== "string" || typeof row.conversation_id !== "string" || typeof row.patient_id !== "string" ||
      typeof row.text !== "string" || typeof row.claim_token !== "string") return;
    try {
      const completed = await supabaseAdmin("POST", "/rest/v1/rpc/coach_title_complete_processing", {
        p_work_id: row.work_id, p_patient_id: row.patient_id, p_conversation_id: row.conversation_id,
        p_claim_token: row.claim_token, p_title: safeCoachTitle(row.text),
      });
      if (completed.status >= 300 || completed.json !== true) throw new Error("coach title completion refused");
      ctx.tally("titles");
    } catch {
      await supabaseAdmin("POST", "/rest/v1/rpc/coach_title_fail_processing", {
        p_work_id: row.work_id, p_patient_id: row.patient_id, p_conversation_id: row.conversation_id,
        p_claim_token: row.claim_token,
      }).catch(() => undefined);
      ctx.failItem(row.conversation_id, "processing_failed");
    }
  }
}

export const coachTitleProcessingJob: JobDefinition = {
  name: "coach-title-processing",
  title: "Coach conversation titles",
  description: "Assigns a short safe allowlisted title after a substantive exchange.",
  intervalMs: 60_000,
  leaseSeconds: 10 * 60,
  run: runCoachTitleProcessing,
};