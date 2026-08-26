/**
 * Menu photo turns inside the coach chat.
 *
 * When a chat message arrives with a photo attached, the route runs the same
 * grounded vision scan as the standalone menu-scan screen, then formats the
 * structured result into a conversational coach reply: the model's warm
 * summary, the top picks with exactly how to order them, what to skip, and a
 * closing offer to turn a pick into a custom recipe (answered via the
 * curated yes/no chips). Not-a-menu and unreadable photos come back as
 * friendly conversational notices — never error events — and deliberately do
 * not end with a question mark, so the client's fallback yes/no chips stay
 * hidden under them.
 *
 * The follow-up side lives here too: detectMenuRecipeFollowUp() recognizes a
 * short affirmative answer to the offer question in the replayed history, so
 * the route can seed the existing recipe pipeline with the menu context. The
 * suggestions text is already in the history — the photo itself is never
 * re-sent.
 */
import { generateMenuScan, type MenuScanPayload } from "./menu-scan";
import type { PatientContext } from "./prompt";

/**
 * Closing offer after menu suggestions. Server-authored (never model text),
 * so the follow-up detector can key on it verbatim in the replayed history.
 */
export const MENU_RECIPE_OFFER =
  "Want me to turn one of these into a custom recipe you can save and log?";

/** Offer variant when nothing printed on the menu fit the program. */
export const MENU_RECIPE_OFFER_EMPTY =
  "Want a custom recipe you could make at home instead?";

/**
 * Closer for photos that were not readable menus. Must not end with a
 * question mark — the chat client shows its fallback yes/no chips under any
 * finished reply that ends with one, and they fit nothing here.
 */
const TRY_ANOTHER_PHOTO =
  "Whenever you're ready, snap another photo and I'll take a look.";

/** Chat replies stay text-message sized: top picks only, not the full scan. */
const MAX_CHAT_PICKS = 3;
const MAX_CHAT_AVOIDS = 2;

/**
 * Formats a structured scan result as blank-line-separated thought blocks
 * (the shape the chat bubbles render). `offerRecipe` tells the route to send
 * the curated yes/no chip labels alongside.
 */
export function formatMenuReply(payload: MenuScanPayload): {
  reply: string;
  offerRecipe: boolean;
} {
  if (payload.result !== "ok") {
    return { reply: `${payload.message}\n\n${TRY_ANOTHER_PHOTO}`, offerRecipe: false };
  }

  const blocks: string[] = [payload.message];

  const picks = payload.order.slice(0, MAX_CHAT_PICKS);
  picks.forEach((dish, index) => {
    const number = picks.length > 1 ? `${index + 1}. ` : "";
    const note = dish.note ? ` ${dish.note}` : "";
    blocks.push(`${number}${dish.name}: ${dish.howToOrder}${note}`);
  });

  const avoids = payload.avoid.slice(0, MAX_CHAT_AVOIDS);
  if (avoids.length > 0) {
    blocks.push(avoids.map((dish) => `Skip ${dish.name}: ${dish.reason}`).join("\n"));
  }

  blocks.push(picks.length > 0 ? MENU_RECIPE_OFFER : MENU_RECIPE_OFFER_EMPTY);
  return { reply: blocks.join("\n\n"), offerRecipe: true };
}

/**
 * Exact-membership check over normalized text (lowercased, punctuation
 * stripped). Deliberately conservative: a false negative just falls through
 * to the normal grounded streaming reply, while a false positive would
 * silently switch an unrelated turn into the recipe pipeline.
 */
const AFFIRMATIVE_REPLIES = new Set([
  "yes",
  "yes please",
  "yeah",
  "yep",
  "yup",
  "sure",
  "sure thing",
  "ok",
  "okay",
  "please",
  "please do",
  "yes do it",
  "do it",
  "lets do it",
  "go for it",
  "go ahead",
  "sounds good",
  "sounds great",
  "absolutely",
  "definitely",
  "why not",
  "id love that",
  "that would be great",
]);

export function isAffirmativeReply(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return AFFIRMATIVE_REPLIES.has(normalized);
}

/**
 * True when the latest user message is a short yes to the immediately
 * preceding assistant reply's menu recipe offer. Strict adjacency on
 * purpose: if the patient asked something else in between, the offer is
 * stale and the turn belongs to the normal pipeline. A stopped menu reply
 * only matches when the offer text was actually revealed before the stop —
 * the client keeps exactly what was on screen.
 */
export function detectMenuRecipeFollowUp(
  history: { role: "user" | "assistant"; content: string }[],
): boolean {
  if (history.length < 2) return false;
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (latest.role !== "user" || previous.role !== "assistant") return false;
  if (!isAffirmativeReply(latest.content)) return false;
  return (
    previous.content.includes(MENU_RECIPE_OFFER) ||
    previous.content.includes(MENU_RECIPE_OFFER_EMPTY)
  );
}

export interface MenuChatTurn {
  reply: string;
  /** Send the curated yes/no chips with this reply. */
  offerRecipe: boolean;
  /** Outcome shape for logging — never the photo. */
  outcome: MenuScanPayload["result"];
  orderCount: number;
  avoidCount: number;
}

/** Runs the grounded vision scan and formats it as a chat reply. */
export async function generateMenuChatTurn(args: {
  /** Validated image data URI (jpeg/png/webp). Kept in memory only. */
  image: string;
  patient: PatientContext;
  signal: AbortSignal;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}): Promise<MenuChatTurn> {
  const payload = await generateMenuScan(args);
  const { reply, offerRecipe } = formatMenuReply(payload);
  return {
    reply,
    offerRecipe,
    outcome: payload.result,
    orderCount: payload.order.length,
    avoidCount: payload.avoid.length,
  };
}
