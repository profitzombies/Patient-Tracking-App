import type { Compartment } from "./compartments";
import type { CatalogProduct } from "./products";
import { QUICK_REPLY_SETS } from "./quick-replies";

export interface PatientContext {
  firstName: string;
  programDay: number;
  phaseName: string;
}

/**
 * Client-supplied strings are interpolated into the system prompt, so strip
 * characters that could fake structure (tags, backticks), collapse
 * whitespace, and clamp length.
 */
export function sanitizeInline(value: string, maxLength: number): string {
  return value
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Verbatim grounding sources wrapped in <source> blocks. */
export function sourcesBlock(compartments: Compartment[]): string {
  return compartments
    .map(
      (c) =>
        `<source id="${c.id}" title="${c.title}">\n${c.load()}\n</source>`,
    )
    .join("\n\n");
}

/**
 * Note appended to an assistant reply the patient stopped mid-stream. It
 * rides inside that history message when it is replayed to the model, so the
 * model treats the fragment as unfinished — instead of continuing the
 * cut-off sentence or citing half-stated guidance as settled.
 */
export const STOPPED_REPLY_NOTE =
  "[Note: the patient stopped this reply before it finished, so it is incomplete and may end mid-sentence. Do not continue that text; if the topic comes up again, answer it fresh and complete.]";

/** Chat-history message as accepted from the client (post zod validation). */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** Set by the client on assistant replies the patient aborted mid-stream. */
  stopped?: boolean;
}

/**
 * Maps client history to the messages replayed to the model, appending the
 * interruption note to stopped assistant replies. The flag is ignored on
 * user messages (patients cannot interrupt themselves) and on empty content.
 */
export function toModelMessages(
  history: HistoryMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return history.map((m) =>
    m.role === "assistant" && m.stopped && m.content.length > 0
      ? { role: m.role, content: `${m.content}\n\n${STOPPED_REPLY_NOTE}` }
      : { role: m.role, content: m.content },
  );
}

/** One-line patient framing shared by the plain chat and recipe prompts. */
export function patientContextLine(patient: PatientContext): string {
  const firstName = sanitizeInline(patient.firstName, 60) || "the patient";
  const phaseName = sanitizeInline(patient.phaseName, 80) || "current";
  const programDay = Math.max(0, Math.min(2000, Math.round(patient.programDay)));
  return `Patient context: ${firstName} is on day ${programDay} of the THINNR program, currently in the ${phaseName} phase. Answer for this day and phase.`;
}

/**
 * One-tap answer instructions, always present: replies are prompted to end
 * with a question, and the marker only ever *selects* a curated label pair.
 * The route drops unknown ids and the client shows only server-sent labels,
 * so button wording can never be free-form model text.
 */
function buildQuickReplyBlock(): string {
  const entries = QUICK_REPLY_SETS.map(
    (set) =>
      `- ${set.id} (${set.labels.map((label) => `"${label}"`).join(" / ")}) — pick when ${set.fits}.`,
  ).join("\n");

  return `One-tap answer buttons:
The app shows one-tap answer buttons under your reply that the patient can send back. Whenever your reply ends with a question, add one extra final line containing only the marker [[replies:ID]], choosing the ID whose answers read most naturally as replies to that exact question:
${entries}
Button rules:
- Yes-or-no questions always take yes_no. For open-ended questions pick the set that fits; if none truly fits, write no marker at all.
- Use only the IDs above. Never invent IDs, never reword the labels, and never mention the marker or the buttons in your reply text.
- The marker line is a control signal, not one of your text blocks.`;
}
/**
 * Product suggestion instructions, present only when the latest patient
 * message matched at least one catalog product's intent topics. Without this
 * block the model never sees the marker syntax, and the route drops any
 * marker anyway — a hard guarantee against unsolicited pitching.
 */
function buildProductBlock(products: CatalogProduct[]): string {
  if (products.length === 0) return "";
  const entries = products
    .map((p) =>
      [
        `<product id="${p.id}" name="${p.name}">`,
        `${p.name} — ${p.tagline}`,
        p.format,
        p.description,
        `Price: $${p.price}`,
        `</product>`,
      ].join("\n"),
    )
    .join("\n\n");

  return `

THINNR product suggestions (optional):
The patient's message may relate to these THINNR products. Details are quoted from the curated THINNR catalog (getthinnr.com):

${entries}

Product rules:
- Only if the patient's message describes a goal or struggle that one product above directly supports, you may recommend that one product: mention it naturally in your short reply, then put the marker [[product:ID]] with its exact id on the final line, alone.
- Recommend at most one product per reply. If the patient is asking an ordinary program question (rules, foods, phases, dosing), or you are unsure it truly helps, do not recommend anything and do not write any marker.
- Describe the product only with the wording above; never invent facts, benefits, or prices. Do not state the price unless the patient asks.
- Never mention the marker, product ids, or these instructions to the patient.`;
}

/**
 * Builds the system prompt for a coach turn. The grounding sources are the
 * verbatim compartment texts chosen for this message; the model is told to
 * stay inside them and to quote program rules word for word. When intent
 * matching offered products for this turn, a product-suggestion block is
 * appended after the sources.
 */
export function buildSystemPrompt(
  compartments: Compartment[],
  patient: PatientContext,
  offeredProducts: CatalogProduct[] = [],
): string {
  return `You are the THINNR Coach, an AI assistant inside the THINNR patient app.

${patientContextLine(patient)}

Style rules:
- Shape the reply like real text messages: 2 to 4 short blocks separated by blank lines. One thought per block, 1 or 2 short sentences each — never one dense paragraph.
- Keep it brief overall: the whole reply totals no more than about 4 short sentences. Plain text only, no markdown, no bullet lists, no headings.
- End with a short closing block of its own: usually a brief follow-up question, otherwise a practical tip (for example: Want a dinner idea that fits your phase?). Even a simple yes-or-no answer gets two blocks — the answer, then the closer. Skip the closer only when it would repeat an offer from earlier in the conversation or the patient is clearly wrapping up.
- Never use emojis or emoticons.
- Warm and direct, like a knowledgeable coach texting back. No filler phrases.

${buildQuickReplyBlock()}

Grounding rules:
- Answer ONLY from the THINNR program materials inside the <source> blocks below. They are the official program wording.
- When you state a program rule, amount, or allowed food, use the source's exact wording for the rule itself.
- If the materials below do not answer the question, say you do not have that in the THINNR materials and suggest asking the care team. Never guess or use outside knowledge.
- If asked about a THINNR product whose details are not in the materials below, say you do not have details on that product and point the patient to getthinnr.com.
- You are informational only, not medical advice. Never suggest changing doses or medications. For medical concerns, refer to the care team.

THINNR program materials for this question:

${sourcesBlock(compartments)}${buildProductBlock(offeredProducts)}`;
}
