/**
 * Lightweight intent detection for chat turns that should produce a
 * structured recipe card alongside the short text reply.
 *
 * Deliberately conservative regexes on the latest user message only: a false
 * negative just falls back to the normal grounded streaming reply, while a
 * false positive silently switches the turn to the slower JSON pipeline. The
 * cravings check runs first — "I'm craving something sweet, any snack ideas?"
 * must land in strict approved-foods mode, not the looser recipe mode.
 */

export type RecipeIntent = "recipe" | "cravings";

const CRAVING_PATTERNS: RegExp[] = [
  /\bcrav/i, // craving, cravings, crave
  /\bsweet tooth\b/i,
  /\bmunchies\b/i,
];

const RECIPE_PATTERNS: RegExp[] = [
  // "give me a dinner idea", "any snack suggestions?", "meal inspiration"
  /\b(meal|breakfast|lunch|dinner|snack|dish|dessert)\w*\b[^.?!]{0,40}\b(idea|suggest|inspiration|recommend)/i,
  // "suggest a dinner", "ideas for something to cook"
  /\b(idea|suggest|inspiration|recommend)\w*\b[^.?!]{0,40}\b(meal|breakfast|lunch|dinner|snack|dish|to eat|to cook|to make)/i,
  // "what should I eat today", "what can I make tonight"
  /\bwhat\s+(should|can|could)\s+i\s+(eat|make|cook|have)\b/i,
  // "what's for dinner"
  /\bwhat(?:'s| is)\s+for\s+(breakfast|lunch|dinner)\b/i,
  // any direct mention of a recipe
  /\brecipes?\b/i,
];

export function detectRecipeIntent(latestUserMessage: string): RecipeIntent | null {
  const text = latestUserMessage.slice(0, 2000);
  if (CRAVING_PATTERNS.some((p) => p.test(text))) return "cravings";
  if (RECIPE_PATTERNS.some((p) => p.test(text))) return "recipe";
  return null;
}
