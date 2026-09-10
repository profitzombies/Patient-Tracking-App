import { supabaseAdmin } from "../lib/supabase-admin";
import { asksAboutEarlierChats, earlierChatClarification } from "./memory";

export type HistoricalRecall = { excerpts: string[]; clarification: boolean };

/** Historical transcript access is opt-in per turn and stays tightly bounded. */
export async function recallHistoricalExcerpts(
  patientId: string, conversationId: string, query: string,
): Promise<HistoricalRecall> {
  if (earlierChatClarification(query)) return { excerpts: [], clarification: true };
  if (!asksAboutEarlierChats(query)) return { excerpts: [], clarification: false };
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .filter((term) => !new Set(["earlier", "previous", "past", "chat", "conversation", "message", "messages", "what", "did", "talk", "talked", "about"]).has(term)))];
  if (!terms.length) return { excerpts: [], clarification: true };
  const response = await supabaseAdmin("POST", "/rest/v1/rpc/coach_historical_excerpts_v2", {
    p_patient_id: patientId, p_conversation_id: conversationId, p_terms: terms, p_limit: 24,
  });
  if (response.status >= 300 || !Array.isArray(response.json)) throw new Error(`coach excerpt recall failed (${response.status})`);
  const termSet = new Set(query.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const matching = response.json
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null &&
      typeof (row as Record<string, unknown>).text === "string" &&
      typeof (row as Record<string, unknown>).conversation_id === "string")
    .filter((row) => (String(row.text).toLowerCase().match(/[a-z]{4,}/g) ?? []).some((term) => termSet.has(term)));
  // Two old chats matching a short request are ambiguous; do not concatenate
  // conflicting history. Ask the patient to name the topic instead.
  if (new Set(matching.map((row) => String(row.conversation_id))).size > 1) return { excerpts: [], clarification: true };
  const excerpts = matching.map((row) => String(row.text).slice(0, 180)).slice(0, 3);
  return { excerpts, clarification: excerpts.length === 0 };
}