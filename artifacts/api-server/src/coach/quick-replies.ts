/**
 * Curated one-tap answer suggestions for the coach chat.
 *
 * The quick-reply chips under a coach reply must never show free-form model
 * text, so the model only ever picks a set ID (via a `[[replies:ID]]` control
 * marker on its final line) and the server emits that set's labels from this
 * allow-list as a side-channel SSE event (`data: {"quickReplies": [...]}`).
 * Unknown ids are dropped by the route; when no suggestion arrives the client
 * falls back to its static yes/no pair.
 */

export interface QuickReplySet {
  id: string;
  /** One or two short, curated one-tap answers shown verbatim as chips. */
  labels: readonly string[];
  /** Prompt-facing description of the closing question this set fits. */
  fits: string;
}

export const QUICK_REPLY_SETS: readonly QuickReplySet[] = [
  {
    id: "yes_no",
    labels: ["Yes, please", "No thanks"],
    fits: 'your closing question is a yes-or-no offer, like "Want a dinner idea that fits your phase?"',
  },
  {
    id: "meal_preference",
    labels: ["Surprise me", "Something light"],
    fits: 'you asked what kind of meal or dish sounds good, like "What sounds good for dinner tonight?"',
  },
  {
    id: "craving_kind",
    labels: ["Something sweet", "Something savory"],
    fits: "you asked what they are craving or in the mood for",
  },
  {
    id: "meal_of_day",
    labels: ["Lunch", "Dinner"],
    fits: "you asked which meal of the day they want help with",
  },
  {
    id: "check_in",
    labels: ["Going well", "Finding it tough"],
    fits: "you asked how their day, week, or progress on the program is going",
  },
  {
    id: "more_questions",
    labels: ["That's all for now", "One more question"],
    fits: "you asked whether they need anything else",
  },
];

const SETS_BY_ID = new Map(QUICK_REPLY_SETS.map((set) => [set.id, set]));

/**
 * Resolves the first marker id (stream order) that names a curated set.
 * Anything the model invented simply comes back undefined.
 */
export function firstQuickReplySet(
  ids: readonly string[],
): QuickReplySet | undefined {
  for (const id of ids) {
    const set = SETS_BY_ID.get(id);
    if (set) return set;
  }
  return undefined;
}
