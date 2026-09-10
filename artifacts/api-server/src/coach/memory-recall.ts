import { supabaseAdmin } from "../lib/supabase-admin";
import { type RecallMemory, selectRelevantMemories } from "./memory";

/** Server-only active-memory read. Suppressed/pending rows never leave SQL. */
export async function recallCoachMemories(patientId: string, conversationId: string, query: string): Promise<RecallMemory[]> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/coach_memory_recall", {
    p_patient_id: patientId,
    p_conversation_id: conversationId,
    p_limit: 24,
  });
  if (response.status >= 300 || !Array.isArray(response.json)) {
    throw new Error(`coach memory recall failed (${response.status})`);
  }
  const rows = response.json
    .filter((row: unknown): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .filter((row) => typeof row.id === "string" && typeof row.text === "string" && typeof row.category === "string")
    .map((row) => ({ id: row.id as string, text: row.text as string, category: row.category as string }));
  return selectRelevantMemories(query, rows);
}

/** Exact-conversation authorization used before any model stream starts. */
export async function authorizeCoachGeneration(patientId: string, conversationId: string): Promise<"ok" | "archived" | "missing"> {
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/coach_generation_conversation", {
    p_patient_id: patientId,
    p_conversation_id: conversationId,
  });
  if (response.status >= 300) throw new Error(`coach conversation authorization failed (${response.status})`);
  return response.json === "ok" || response.json === "archived" ? response.json : "missing";
}