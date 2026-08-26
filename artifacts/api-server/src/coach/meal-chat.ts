/**
 * Meal photo turns inside the coach chat.
 *
 * When a chat message arrives with a photo flagged `photoKind: "meal"`, the
 * route runs the meal analysis (see meal-photo.ts) and formats the result as
 * a conversational coach reply: the model's warm reaction, one compact block
 * listing each visible food with its committed portion estimate, and a
 * closing line that points at the attached editable meal card. The card
 * itself rides the SSE `card` slot as the existing recipe payload (mode
 * "meal"), so the client's breakdown editor, diary logging, and
 * save-as-recipe paths all reuse the recipe plumbing.
 *
 * Not-food and unreadable photos come back as friendly conversational
 * notices — never error events — and, like the menu pipeline, no reply here
 * ends with a question mark, so the client's fallback yes/no chips stay
 * hidden. The retake affordance is client-side (a chip under the reply);
 * the closer only mentions it in words.
 */
import { generateMealPhotoAnalysis, type MealPhotoAnalysis, type MealPhotoOutcome } from "./meal-photo";
import type { PatientContext } from "./prompt";
import type { RecipeCardPayload } from "./recipe";

/**
 * Closer under the item list. Must not end with a question mark — the chat
 * client shows its fallback yes/no chips under any finished reply that ends
 * with one, and they fit nothing here. Mentions the retake path in words;
 * the actual control is the client's "Retake photo" chip.
 */
export const MEAL_CARD_CLOSER =
  "These amounts are my best read of the photo. Open the meal card below to fine-tune them, then log the meal or save it for next time. And if I misread your plate, just retake the photo.";

/** Closer for photos that couldn't be read as a meal. No "?" ending either. */
export const MEAL_TRY_ANOTHER_PHOTO =
  "Whenever you're ready, snap another photo of your meal and I'll take a look.";

/** Trims "6.00" → "6" and "1.50" → "1.5" for the reply's portion lines. */
function formatAmount(amount: number): string {
  return String(Math.round(amount * 100) / 100);
}

/**
 * One line per visible food: name, committed portion, and the same integer
 * calorie figure the card shows (post-normalization), so the words and the
 * card never disagree.
 */
function itemLine(item: RecipeCardPayload["ingredients"][number]): string {
  const portion = item.unit ? `${formatAmount(item.amount)} ${item.unit}` : formatAmount(item.amount);
  const calories = item.nutrition.calories;
  return `${capitalize(item.name)}: about ${portion} · est. ${calories} cal`;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Formats the structured analysis as blank-line-separated thought blocks
 * (the shape the chat bubbles render).
 */
export function formatMealReply(analysis: MealPhotoAnalysis): string {
  if (analysis.outcome !== "ok" || analysis.payload === null) {
    return `${analysis.message}\n\n${MEAL_TRY_ANOTHER_PHOTO}`;
  }
  const blocks: string[] = [analysis.message];
  blocks.push(analysis.payload.ingredients.map(itemLine).join("\n"));
  blocks.push(MEAL_CARD_CLOSER);
  return blocks.join("\n\n");
}

export interface MealChatTurn {
  reply: string;
  card: { kind: "recipe"; payload: RecipeCardPayload } | null;
  outcome: MealPhotoOutcome;
  itemCount: number;
}

/** Runs the analysis and shapes the whole chat turn for the route. */
export async function generateMealChatTurn(args: {
  image: string;
  patient: PatientContext;
  signal: AbortSignal;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<MealChatTurn> {
  const analysis = await generateMealPhotoAnalysis(args);
  return {
    reply: formatMealReply(analysis),
    card: analysis.payload ? { kind: "recipe", payload: analysis.payload } : null,
    outcome: analysis.outcome,
    itemCount: analysis.payload?.ingredients.length ?? 0,
  };
}
