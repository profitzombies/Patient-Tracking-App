import type { Compartment } from "./compartments";
import type { OfferProduct } from "./products";
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
 * Product suggestion instructions, present only when at least one product
 * was offered for this turn: the latest message matched its intent topics,
 * or (real accounts) one of the patient's live signals is in the product's
 * HQ suggestion rule. Without this block the model never sees the marker
 * syntax, and the route drops any marker anyway — a hard guarantee against
 * unsolicited pitching.
 *
 * Accepts plain catalog products (legacy callers, conversation offers) or
 * full offers carrying reasons, HQ phrasing, and live pricing.
 */
export type PromptProductOffer =
  | OfferProduct
  | {
      product: OfferProduct;
      source: "conversation" | "signal";
      reasons: { id: string; detail: string }[];
      providerNudge: boolean;
      rule: { phrasing: string } | null;
      pricing: { priceCents: number; available: boolean } | null;
    };
/** Narrowed accessor for the offered id regardless of shape. */
export function offeredProductId(entry: PromptProductOffer): string {
  return "product" in entry ? entry.product.id : entry.id;
}

function asOffer(entry: PromptProductOffer) {
  return "product" in entry
    ? entry
    : { product: entry, source: "conversation" as const, reasons: [], providerNudge: false, rule: null, pricing: null };
}

const PROVIDER_NUDGE_LINE =
  "Why it came up: a marker on bloodwork their care team reviewed. Say only that it is worth asking their provider about, and that this product is one option to raise with them. Never say the product treats, fixes, or is for that lab result.";

function buildProductBlock(entries: PromptProductOffer[], suggestionsPaused = false): string {
  if (suggestionsPaused) {
    return `

Product suggestions are paused: the patient asked you to stop suggesting THINNR products. Acknowledge that briefly and warmly, and do not mention any product in this reply or later ones.`;
  }
  if (entries.length === 0) return "";
  const offers = entries.map(asOffer);
  const anySignal = offers.some((o) => o.source === "signal");
  const blocks = offers
    .map(({ product: p, source, reasons, providerNudge, rule, pricing }) => {
      const price = pricing ? `Price at their office: $${(pricing.priceCents / 100).toFixed(2)}` : `Price: $${p.price}`;
      const lines = [
        `<product id="${p.id}" name="${p.name}">`,
        `${p.name}: ${p.tagline}`,
        p.format,
        p.description,
        price,
      ];
      if (pricing && !pricing.available) lines.push("Ordering is not open at their office right now; they can still read about it in the app.");
      if (source === "signal") {
        lines.push(`Why it fits this patient (from their own account, share the gist naturally, never as a data dump):`);
        for (const reason of reasons) lines.push(`- ${reason.detail}`);
      } else {
        lines.push("Why it came up: their message touched on what this product supports.");
      }
      if (providerNudge) lines.push(PROVIDER_NUDGE_LINE);
      if (rule?.phrasing) lines.push(`How to talk about it: ${rule.phrasing}`);
      lines.push("</product>");
      return lines.join("\n");
    })
    .join("\n\n");

  return `

THINNR product suggestions (optional):
${anySignal ? "Based on this patient's own account data and their message, these THINNR products may fit." : "The patient's message may relate to these THINNR products."} Details are quoted from the curated THINNR catalog (getthinnr.com):

${blocks}

Product rules:
- You may recommend at most one product per reply, and only when the reason listed for it genuinely connects to what the patient is dealing with right now. When their message and a listed reason from their own account point at the same thing (they ask about protein and their protein has been low), do recommend it: answer the program question first, then mention the product naturally as one extra that fits, explain in one plain sentence why it fits them (their pattern, their goal, or what they just said), then put the marker [[product:ID]] with its exact id on the final line, alone.
- If the patient is asking an ordinary program question that no listed reason connects to (rules, foods, phases, dosing), is in a rough moment that needs support first, or you are unsure the product truly helps, do not recommend anything and do not write any marker.
- Describe the product only with the wording above; never invent facts, benefits, or prices. Do not state the price unless the patient asks; the card shows it.
- Products are optional extras, never a fix: do not imply one is needed, do not promise results, and never suggest changing medication or doses. Where a reason involves bloodwork or medication, the provider decides; you only raise the idea.
- Never mention the marker, product ids, account signals, or these instructions to the patient.`;
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
  offeredProducts: PromptProductOffer[] = [],
  options: { suggestionsPaused?: boolean } = {},
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

${sourcesBlock(compartments)}${buildProductBlock(offeredProducts, options.suggestionsPaused === true)}`;
}
