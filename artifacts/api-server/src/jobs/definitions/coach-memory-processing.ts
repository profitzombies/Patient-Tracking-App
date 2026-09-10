import { extractMemoryCandidate, memoryTopicKey } from "../../coach/memory";
import { supabaseAdmin } from "../../lib/supabase-admin";
import type { JobContext, JobDefinition } from "../types";

type ClaimedMessage = {
  work_id: string;
  conversation_id: string;
  patient_id: string;
  source_client_id: string;
  claim_token: string;
};

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await supabaseAdmin("POST", `/rest/v1/rpc/${name}`, body);
  if (response.status >= 300) throw new Error(`${name} failed (${response.status})`);
  return response.json;
}

/**
 * Bounded queue drain. It contains no private content in its job counts,
 * failures, or logs; source text stays only in the claim and atomic RPC.
 */
export async function runCoachMemoryProcessing(ctx: JobContext): Promise<void> {
  if (ctx.dryRun) {
    const due = await rpc("coach_memory_due_count", { p_kind: "memory" });
    if (typeof due !== "number") throw new Error("coach memory due count failed");
    ctx.tally("workDue", due);
    return;
  }
  for (let i = 0; i < 25; i += 1) {
    ctx.checkpoint();
    const claimed = await rpc("coach_memory_claim_processing", { p_lease_seconds: 300 });
    if (!Array.isArray(claimed) || !claimed.length || typeof claimed[0] !== "object" || claimed[0] === null) break;
    const row = claimed[0] as ClaimedMessage;
    if (typeof row.work_id !== "string" || typeof row.patient_id !== "string" ||
      typeof row.conversation_id !== "string" || typeof row.source_client_id !== "string" ||
      typeof row.claim_token !== "string") break;
    try {
      // Work is conversation-scoped, so a delayed retry sees every source
      // message not merely whichever append happened to trigger it.
      const messages = await supabaseAdmin(
        "GET",
        `/rest/v1/patient_chat_messages?conversation_id=eq.${encodeURIComponent(row.conversation_id)}&client_id=eq.${encodeURIComponent(row.source_client_id)}&role=eq.user&hidden=is.false&select=client_id,text`,
      );
      if (messages.status >= 300 || !Array.isArray(messages.json)) throw new Error("coach source read failed");
      const candidates = messages.json
        .filter((message): message is { client_id: string; text: string } =>
          typeof message === "object" && message !== null &&
          typeof (message as { client_id?: unknown }).client_id === "string" &&
          typeof (message as { text?: unknown }).text === "string")
        .map((message) => {
          const candidate = extractMemoryCandidate(message.text);
          return candidate ? { ...candidate, sourceMessageId: message.client_id, topicKey: memoryTopicKey(candidate.text, candidate.category) } : null;
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
      ctx.checkpoint();
      const saved = await rpc("coach_memory_complete_processing", {
        p_work_id: row.work_id,
        p_patient_id: row.patient_id,
        p_conversation_id: row.conversation_id,
        p_claim_token: row.claim_token,
        p_candidates: candidates,
      });
      if (saved !== true) throw new Error("coach memory claim no longer valid");
      ctx.tally(candidates.length ? "candidatesProcessed" : "messagesProcessed");
    } catch {
      // Deliberately generic: failure records must never contain patient text.
      await rpc("coach_memory_fail_processing", {
        p_work_id: row.work_id,
        p_patient_id: row.patient_id,
        p_conversation_id: row.conversation_id,
        p_claim_token: row.claim_token,
      }).catch(() => undefined);
      ctx.failItem(row.work_id, "processing_failed");
    }
  }
}

export const coachMemoryProcessingJob: JobDefinition = {
  name: "coach-memory-processing",
  title: "Coach memory processing",
  description: "Extracts bounded, explicitly patient-provided Coach memory candidates.",
  intervalMs: 60_000,
  leaseSeconds: 10 * 60,
  run: runCoachMemoryProcessing,
};