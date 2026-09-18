import { generateCoachTitle } from "../../coach/title";
import { withModelUsageContext } from "@workspace/integrations-openai-ai-server/usage";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";

/** Well under the 300 s work lease; a slow model call falls back, never stalls the queue. */
const TITLE_CALL_TIMEOUT_MS = 45_000;

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
    const { text: firstMessage, patient_id: patientId } = row;
    try {
      const named = await withModelUsageContext({ surface: "coach.title", patientId, scope: "system" }, () => generateCoachTitle({
        firstMessage,
        signal: AbortSignal.timeout(TITLE_CALL_TIMEOUT_MS),
        log: { warn: (detail, message) => ctx.log(message, { conversationId: row.conversation_id, ...detail }) },
      }));
      const completed = await supabaseAdmin("POST", "/rest/v1/rpc/coach_title_complete_processing", {
        p_work_id: row.work_id, p_patient_id: row.patient_id, p_conversation_id: row.conversation_id,
        p_claim_token: row.claim_token, p_title: named.title,
      });
      if (completed.status >= 300 || completed.json !== true) throw new Error("coach title completion refused");
      ctx.tally("titles");
      if (named.source === "fallback") ctx.tally("fallbackTitles");
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
  description: "Names each conversation from its first message once the coach has replied.",
  intervalMs: 20_000,
  leaseSeconds: 10 * 60,
  run: runCoachTitleProcessing,
};