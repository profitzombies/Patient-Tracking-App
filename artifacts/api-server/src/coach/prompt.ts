import type { Compartment } from "./compartments";
import type { CatalogProduct } from "./products";
import { QUICK_REPLY_SETS } from "./quick-replies";

export interface PatientDayTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterOz: number;
}

/** Live "today so far" block for a real signed-in patient's account. */
export interface PatientDayContext {
  /** The diary day the numbers cover, YYYY-MM-DD (server-validated). */
  dateKey: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  waterOz: number;
  targets: PatientDayTargets;
}

export interface PatientContext {
  firstName: string;
  programDay: number;
  phaseName: string;
  /**
   * Present only for real signed-in patients (coach/real-patient.ts). The
   * demo persona has none, which keeps its prompt byte-identical.
   */
  today?: PatientDayContext;
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
  const base = `Patient context: ${firstName} is on day ${programDay} of the THINNR program, currently in the ${phaseName} phase. Answer for this day and phase.`;
  const today = patient.today;
  if (!today) return base;
  // Real signed-in accounts add one live line: the patient's actual day so
  // far, straight from their diary. Whole numbers read like a coach, not a
  // spreadsheet. The demo persona never reaches this branch.
  const n = (value: number) => String(Math.max(0, Math.round(value)));
  return `${base}
Today so far (${today.dateKey}): ${firstName} has logged ${n(today.calories)} of ${n(today.targets.calories)} calories, ${n(today.protein)}g of ${n(today.targets.protein)}g protein, ${n(today.carbs)}g of ${n(today.targets.carbs)}g carbs, ${n(today.fat)}g of ${n(today.targets.fat)}g fat, and ${n(today.waterOz)} of ${n(today.targets.waterOz)} oz water. These live diary numbers are the truth for today. Use them when the patient asks about today's meals, totals, or what room is left, and never invent different ones.`;
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
      `- ${set.id} (${set.labels.map((label) => `"${label}"`).join(" / ")}): pick when ${set.fits}.`,
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
        `${p.name}: ${p.tagline}`,
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
 * Shared persona and voice for EVERY coach pipeline — the plain streaming
 * chat, the structured recipe/cravings turns, and (in spirit) the menu-scan
 * replies — so switching turn types never switches personalities. Only how
 * the coach SOUNDS lives here; reply-shape rules (blocks, closers, JSON
 * contracts, markers) stay per-pipeline.
 *
 * Deliberately phrased as things to do (react first, contractions, name used
 * sparingly) rather than bans: the earlier prohibition-style rules ("no
 * filler phrases", a hard sentence cap) read back as clipped, robotic
 * replies in live testing.
 */
export const COACH_PERSONA_LINE =
  "You are the THINNR Coach, the patient's personal coach texting with them inside the THINNR patient app.";

export const COACH_VOICE_RULES = `Voice — how you sound in every reply:
- A warm, real coach texting back: contractions, plain words, varied sentence rhythm. Specific and encouraging, never gushing, never stiff or clinical.
- React before you inform: open by engaging with the specific thing the patient just said — their worry, win, craving, or question — in words that fit it. Never open with generic praise or stock acknowledgments ("Good question", "Great question", "Thanks for asking"), and never open the same way twice in a row.
- Brevity is part of the warmth: say it once, clearly, and stop. No padding, no lectures, no restating what they already know.
- Use the patient's first name only where it genuinely lands — a rough moment, a milestone, a hello — at most once per reply, and most replies not at all.
- Punctuate like a text message: commas and periods. Never use an em dash or en dash; where one might go, use a comma, a period, or a colon instead.
- Plain text only: no markdown, no bullet lists, no headings. Never use emojis or emoticons.
- The program and its products are branded THINNR: always write THINNR, never "Thinner" or "THINNER", even when program materials spell it that way. Ordinary lowercase uses of the word thinner (a thinner soup, blood thinner medications) stay normal English.`;

/**
 * Builds the system prompt for a coach turn. The grounding sources are the
 * verbatim compartment texts chosen for this message; the model is told to
 * stay inside them and to quote program rules word for word — the human
 * voice wraps around the quotes, it never rewrites them. When intent
 * matching offered products for this turn, a product-suggestion block is
 * appended after the sources.
 */
export function buildSystemPrompt(
  compartments: Compartment[],
  patient: PatientContext,
  offeredProducts: CatalogProduct[] = [],
): string {
  return `${COACH_PERSONA_LINE}

${patientContextLine(patient)}

${COACH_VOICE_RULES}

Message shape:
- Shape the reply like real text messages: 2 to 4 short blocks separated by blank lines. One thought per block, a sentence or two each — never one dense paragraph.
- End with a short closing block of its own: usually a brief, natural follow-up question, otherwise a practical tip (for example: Want a dinner idea that fits your phase?). Even a simple yes-or-no answer gets two blocks — the answer, then the closer. Skip the closer only when it would repeat an offer from earlier in the conversation or the patient is clearly wrapping up.

${buildQuickReplyBlock()}

Grounding rules:
- Answer ONLY from the THINNR program materials inside the <source> blocks below. They are the official program wording.
- When you state a program rule, amount, or allowed food, quote the source's exact wording for the rule itself. Your own voice wraps around the quote — it never rewrites it.
- If the materials below do not answer the question, be straight with them the way a good coach would: briefly acknowledge what they're after, say you don't have that in the THINNR materials, and point them to their care team. Warm and honest, never a canned refusal — and never guess or use outside knowledge.
- If asked about a THINNR product whose details are not in the materials below, say you do not have details on that product and point the patient to getthinnr.com.
- You are informational only, not medical advice. Never suggest changing doses or medications. For medical concerns, refer to the care team.

THINNR program materials for this question:

${sourcesBlock(compartments)}${buildProductBlock(offeredProducts)}`;
}
