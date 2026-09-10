/**
 * Deliberately conservative memory policy. This module never asks a model to
 * decide what a patient "probably meant": only a small set of plainly stated
 * preference/routine sentences are eligible.
 */
export type MemorySensitivity = "ordinary" | "sensitive";
export type MemoryCandidate = { text: string; category: string; sensitivity: MemorySensitivity };

const SECRET = /\b(?:password|passcode|pw|verification\s*code|one[- ]?time\s*(?:pass)?code|otp|api[ _-]?key|access\s*token|auth\s*token|secret|cvv|cvc|credit\s*card|debit\s*card|bank\s*account|routing\s*number|social\s*security|ssn)\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:\d[ -]?){13,19}\d\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_-]{24,}\b/i;
const SENSITIVE = /\b(?:pregnan\w*|diagnos\w*|disease\w*|condition\w*|medicat\w*|prescri\w*|treat\w*|therap\w*|allerg\w*|disab\w*|mental\s+health|anxiety|depress\w*|substance|sober|abuse|sexual|gender|race|religion|islam|christian|jewish|cocaine|opioid)\b/i;
const NEGATION = /\b(don'?t remember|do not remember|forget|never mind|ignore that|that(?:'s| is) wrong|not true|i changed my mind)\b/i;
const MAX_MEMORY_TEXT = 180;

export function isCredentialLike(text: string): boolean {
  return SECRET.test(text);
}

/**
 * Returns an explicitly patient-provided candidate or null. The allowlist is
 * intentionally compact: food likes/dislikes, repeatable meal timing and a
 * named coaching communication preference. Medical claims are never inferred.
 */
export function extractMemoryCandidate(text: string): MemoryCandidate | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > MAX_MEMORY_TEXT || isCredentialLike(clean) || NEGATION.test(clean)) return null;
  const sensitiveClaim = /^(?:i\s+)?(?:have|am|was|were|take|use|need|prefer|like|love|hate|avoid|identify|practice)\b/i.test(clean) && SENSITIVE.test(clean);
  if (sensitiveClaim) return { text: clean, category: "patient_detail", sensitivity: "sensitive" };
  const food = "(?:chicken|turkey|fish|salmon|eggs?|yogurt|fruit|vegetables?|salad|rice|beans?|oatmeal|coffee|tea|water|(?:vegetarian|vegan|quick|simple)\\s+(?:meals?|recipes?))";
  if (new RegExp(`^(?:i\\s+)?(?:really\\s+)?(?:like|love|prefer|enjoy|hate|dislike|avoid)\\s+${food}(?:\\s+(?:for|at)\\s+(?:breakfast|lunch|dinner|snacks?))?[.!]?$`, "i").test(clean)) {
    return { text: clean, category: "food_preference", sensitivity: "ordinary" };
  }
  if (/^(?:i\s+)?(?:usually|always|often)\s+(?:eat|have|cook|drink)\s+(?:breakfast|lunch|dinner|water|coffee|tea)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?[.!]?$/i.test(clean)) {
    return { text: clean, category: "routine", sensitivity: "ordinary" };
  }
  if (/^(?:please\s+)?(?:give|keep|make)\s+(?:me\s+)?(?:short|brief|simple|step-by-step|gentle)\s+(?:answers?|guidance|instructions?)[.!]?$/i.test(clean)) {
    return { text: clean, category: "coaching_preference", sensitivity: "ordinary" };
  }
  // An explicit but unrecognized durable-looking statement is never active
  // automatically. It may be presented as a pending patient_detail instead.
  if (/^(?:i\s+)?(?:like|love|prefer|hate|dislike|avoid|usually|always|often|have|am|take|need)\b/i.test(clean)) {
    return { text: clean, category: "patient_detail", sensitivity: "sensitive" };
  }
  return null;
}

/** Stable duplicate key for safely allowlisted equivalent phrasings. */
export function memoryTopicKey(text: string, category: string): string {
  const normalized = text.toLowerCase().replace(/[.!]/g, "").replace(/\s+/g, " ").trim();
  if (category === "food_preference") {
    const food = normalized.match(/\b(chicken|turkey|fish|salmon|egg|eggs|yogurt|fruit|vegetable|vegetables|salad|rice|bean|beans|oatmeal|coffee|tea|water)\b/)?.[1];
    const sentiment = normalized.match(/\b(like|love|prefer|enjoy|hate|dislike|avoid)\b/)?.[1];
    if (food && sentiment) return `${category}:${sentiment}:${food.replace(/s$/, "")}`;
  }
  return `${category}:${normalized}`;
}

export const RECALL_MAX_ITEMS = 6;
export const RECALL_MAX_CHARS = 600;
export const RECALL_PER_ITEM_CHARS = 120;

export type RecallMemory = { id: string; text: string; category: string };

/** Keyword-overlap rank with hard item and character ceilings. */
export function selectRelevantMemories(query: string, memories: RecallMemory[]): RecallMemory[] {
  const terms = new Set(query.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  const ranked = memories
    .map((memory, index) => ({
      memory,
      index,
      score: (memory.text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((term) => terms.has(term)).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  let used = 0;
  const selected: RecallMemory[] = [];
  for (const { memory } of ranked) {
    const text = memory.text.slice(0, RECALL_PER_ITEM_CHARS);
    if (selected.length >= RECALL_MAX_ITEMS || used + text.length > RECALL_MAX_CHARS) break;
    selected.push({ ...memory, text });
    used += text.length;
  }
  return selected;
}

export function memoryPrompt(memories: RecallMemory[]): string | null {
  if (!memories.length) return null;
  return [
    "Approved patient-provided memory relevant to this request (use only if helpful; do not mention this list or recap it unprompted):",
    ...memories.map((memory) => `- ${memory.text}`),
    "Current structured patient records and the current conversation override this context.",
  ].join("\n");
}

export function asksAboutEarlierChats(text: string): boolean {
  return /\b(earlier|previous|past|old)\s+(?:chat|conversation|message|messages)|\bwhat did (?:i|we) (?:say|talk about)\b/i.test(text);
}

export function earlierChatClarification(text: string): boolean {
  return /\b(earlier|previous|past|old)\b/i.test(text) && !asksAboutEarlierChats(text);
}