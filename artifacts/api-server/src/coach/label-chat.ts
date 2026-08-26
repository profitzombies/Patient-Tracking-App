/**
 * Nutrition label turns inside the coach chat.
 *
 * When a chat photo resolves to `photoKind: "label"`, the route runs the
 * label reader (see label-photo.ts) and formats the result as a
 * conversational reply: the model's short reaction, a read-back of the
 * printed facts so the patient can spot a misread immediately, an optional
 * double-check note when the calories fight the macro math, then a canned
 * closer asking what the product is called. The validated draft rides the
 * dedicated SSE `labelDraft` event — NOT the card slot — because the food
 * card is built client-side only after the name conversation settles (the
 * name never round-trips through the server).
 *
 * Not-label and unreadable photos come back as friendly conversational
 * notices, never error events, and no reply here ends with a question mark:
 * the client's fallback yes/no chips fit nothing on a label turn, so the
 * name ask closes as an instruction, not a question.
 */
import {
  generateLabelPhotoAnalysis,
  type LabelDraft,
  type LabelPhotoAnalysis,
  type LabelPhotoOutcome,
} from "./label-photo";
import type { MealSlotContext } from "./meal-slot";
import type { PatientContext } from "./prompt";

/**
 * Closer under the facts read-back. Must not end with a question mark — the
 * chat client shows its fallback yes/no chips under any finished reply that
 * ends with one, and they fit nothing here. The ask reads as an instruction.
 */
export const LABEL_NAME_ASK =
  "One thing the label never tells me is the name. Type what this food is called, brand and all, and I'll set it up as a food you can log anytime.";

/** Closer for photos that couldn't be read as a label. No "?" ending either. */
export const LABEL_TRY_ANOTHER_PHOTO =
  "Whenever you're ready, snap the Nutrition Facts panel again, straight on and filling the frame, and I'll read it for you.";

/**
 * Caution block when the printed calories fight the 4/4/9 macro math. The
 * read still goes through — it is the patient's label — but they should
 * glance at the package before trusting the numbers.
 */
export const LABEL_CHECK_NOTE =
  "One heads up: those calories don't quite line up with the protein, carb, and fat math, which can mean a misprint or a misread. Worth a quick look at the package to be sure I got it right.";

/** Trims "8.00" → "8" and "4.50" → "4.5" for the read-back lines. */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * The facts read-back block: per-serving line, container count when printed,
 * and a second line for the optional extras that were legible. Uses the same
 * integer/one-decimal values the eventual card shows, so the words and the
 * card never disagree.
 */
function factsBlock(draft: LabelDraft): string {
  const lines = [
    `Per serving (${draft.servingSize}): ${formatNumber(draft.calories)} cal · ${formatNumber(draft.protein)}g protein · ${formatNumber(draft.carbs)}g carbs · ${formatNumber(draft.fat)}g fat`,
  ];
  if (draft.servingsPerContainer !== null) {
    lines.push(`Servings per container: ${formatNumber(draft.servingsPerContainer)}`);
  }
  const extras: string[] = [];
  if (draft.fiber !== undefined) extras.push(`${formatNumber(draft.fiber)}g fiber`);
  if (draft.sugar !== undefined) extras.push(`${formatNumber(draft.sugar)}g sugar`);
  if (draft.sodium !== undefined) extras.push(`${formatNumber(draft.sodium)}mg sodium`);
  if (extras.length > 0) {
    lines.push(`Also printed: ${extras.join(" · ")}`);
  }
  return lines.join("\n");
}

/**
 * Formats the structured read as blank-line-separated thought blocks (the
 * shape the chat bubbles render).
 */
export function formatLabelReply(analysis: LabelPhotoAnalysis): string {
  if (analysis.outcome !== "ok" || analysis.draft === null) {
    return `${analysis.message}\n\n${LABEL_TRY_ANOTHER_PHOTO}`;
  }
  const blocks: string[] = [analysis.message, factsBlock(analysis.draft)];
  if (analysis.draft.flagged) {
    blocks.push(LABEL_CHECK_NOTE);
  }
  blocks.push(LABEL_NAME_ASK);
  return blocks.join("\n\n");
}

export interface LabelChatTurn {
  reply: string;
  /** Rides the SSE `labelDraft` event — present only on a successful read. */
  draft: LabelDraft | null;
  outcome: LabelPhotoOutcome;
}

/** Runs the label read and shapes the whole chat turn for the route. */
export async function generateLabelChatTurn(args: {
  image: string;
  patient: PatientContext;
  /**
   * Meal-slot context from the request (explicit client pin and/or the
   * default derived from the patient's local time), passed through so the
   * draft preselects the right diary slot.
   */
  slot?: MealSlotContext;
  signal: AbortSignal;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<LabelChatTurn> {
  const analysis = await generateLabelPhotoAnalysis(args);
  return {
    reply: formatLabelReply(analysis),
    draft: analysis.draft,
    outcome: analysis.outcome,
  };
}
