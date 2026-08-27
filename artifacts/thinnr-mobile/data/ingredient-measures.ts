/**
 * Ingredient measure data: is an ingredient a liquid (fluid ounces) or a
 * solid (weight ounces), and what does a cup or a piece of it weigh?
 *
 * This is the bridge that lets every editable recipe row offer an ounce
 * option (see data/ingredient-nutrition.ts):
 *  - liquids convert tsp/tbsp/cup ↔ fl oz exactly (pure volume, no density),
 *  - solids measured by volume convert to weight oz via a realistic ozPerCup,
 *  - count rows (eggs, slices, scoops, cloves…) convert via ozPerPiece.
 *
 * Lookup is CLIENT-SIDE NAME MATCHING only — the coach/server AI card
 * contract is untouched. Exact catalog spellings are matched first, then
 * keyword phrases over lightly-stemmed word tokens. When two phrases of the
 * same length both match, the one ending LATEST in the name wins — the head
 * noun — so "almond milk" is a liquid while "milk chocolate" is a solid.
 * Unrecognized names return null and the row keeps its original unit family;
 * we never guess a density.
 */

export interface IngredientMeasure {
  /** Volume rows offer fl oz — exact volume conversion, never a weight bridge. */
  liquid?: boolean;
  /** Weight ounces of 1 cup — solid volume rows offer oz through this. */
  ozPerCup?: number;
  /** Weight ounces of 1 piece in the row's own count unit (egg, slice, clove…). */
  ozPerPiece?: number;
}

const LIQ: IngredientMeasure = { liquid: true };
const cup = (ozPerCup: number): IngredientMeasure => ({ ozPerCup });
const piece = (ozPerPiece: number): IngredientMeasure => ({ ozPerPiece });
const both = (ozPerPiece: number, ozPerCup: number): IngredientMeasure => ({ ozPerPiece, ozPerCup });

/**
 * Exact catalog spellings whose weights are row-specific (cans, dry-rinsed
 * grains) and would be mis-read by the generic keywords below. Keys are
 * normalizeExact() output.
 */
const EXACT_MEASURES: Record<string, IngredientMeasure> = {
  'diced tomatoes 14 oz': piece(14), // the can, as printed on the label
  'tuna in water 5 oz drained': piece(5), // matches the "(5 oz)" in the row text
  'quinoa rinsed': cup(6.0), // dry quinoa — the keyword value is for cooked
  'dried green lentils rinsed': cup(6.8), // dry lentils — keyword value is cooked
};

/**
 * Keyword phrases → measures. Matched on stemmed tokens; most tokens wins,
 * then latest end position (head noun), so specific phrases ("cottage
 * cheese", "sliced almonds", "snap peas") beat their generic tails.
 * Weights are realistic USDA-style values, rounded to ~0.1 oz.
 */
const KEYWORD_MEASURES: Array<[phrase: string, measure: IngredientMeasure]> = [
  // ── Liquids (fl oz) ────────────────────────────────────────────────────
  ['milk', LIQ], ['buttermilk', LIQ], ['cream', LIQ], ['broth', LIQ],
  ['stock', LIQ], ['juice', LIQ], ['water', LIQ], ['oil', LIQ],
  ['vinegar', LIQ], ['honey', LIQ], ['syrup', LIQ], ['molasses', LIQ],
  ['nectar', LIQ], ['extract', LIQ], ['coffee', LIQ], ['espresso', LIQ],
  ['tea', LIQ], ['matcha', LIQ], ['wine', LIQ], ['kombucha', LIQ],
  ['seltzer', LIQ], ['soda', LIQ], ['lemonade', LIQ], ['cider', LIQ],
  ['marinara', LIQ], ['vinaigrette', LIQ], ['dressing', LIQ],
  ['soy sauce', LIQ], ['fish sauce', LIQ], ['hot sauce', LIQ],
  ['worcestershire', LIQ], ['tamari', LIQ], ['aminos', LIQ],

  // ── Dairy & creamy solids (weight oz per cup) ──────────────────────────
  ['yogurt', cup(8.6)], ['cottage cheese', cup(8.0)], ['cream cheese', cup(8.2)],
  ['sour cream', cup(8.5)], ['ice cream', cup(5.2)], ['whipped cream', cup(2.1)],
  ['feta', cup(5.3)], ['parmesan', cup(3.5)], ['mozzarella', cup(4.0)],
  ['cheddar', cup(4.0)], ['cheese', cup(4.0)], ['butter', cup(8.0)],
  ['ice', cup(4.8)],

  // ── Grains, legumes & pantry ───────────────────────────────────────────
  ['oats', cup(2.9)], ['oatmeal', cup(8.3)], ['granola', cup(4.3)],
  ['quinoa', cup(6.5)], ['rice', cup(6.9)], ['cauliflower rice', cup(3.8)],
  ['couscous', cup(5.5)], ['pasta', cup(4.9)], ['noodles', cup(4.9)],
  ['lentils', cup(7.0)], ['chickpeas', cup(5.8)], ['black beans', cup(6.1)],
  ['beans', cup(6.1)], ['hummus', cup(8.7)], ['tofu', cup(8.9)],
  ['tempeh', cup(5.9)], ['flour', cup(4.4)], ['almond flour', cup(3.4)],
  ['sugar', cup(7.1)], ['brown sugar', cup(7.8)], ['cocoa', cup(3.0)],
  ['chocolate', cup(6.0)], ['trail mix', cup(5.3)], ['tahini', cup(8.5)],
  ['mustard', cup(8.8)], ['mayonnaise', cup(7.8)], ['coconut', cup(3.3)],
  // "soda"/"powder" alone must not win these — they are dry leaveners.
  ['baking soda', cup(9.7)], ['baking powder', cup(8.1)],

  // ── Nuts, seeds & nut butters ──────────────────────────────────────────
  ['sliced almonds', cup(3.2)], ['almonds', cup(5.0)], ['walnuts', cup(4.1)],
  ['pecans', cup(3.5)], ['cashews', cup(4.8)], ['peanuts', cup(5.2)],
  ['pistachios', cup(4.3)], ['chia', cup(6.8)], ['flax', cup(4.0)],
  ['flaxseed', cup(4.0)], ['sesame seeds', cup(5.1)], ['sunflower seeds', cup(4.9)],
  ['pumpkin seeds', cup(4.6)], ['peanut butter', cup(9.1)], ['almond butter', cup(9.0)],
  ['cashew butter', cup(9.0)], ['nut butter', cup(9.0)],

  // ── Vegetables & greens ────────────────────────────────────────────────
  ['spinach', cup(1.1)], ['kale', cup(0.7)], ['arugula', cup(0.7)],
  ['lettuce', both(0.3, 1.7)], ['romaine', both(0.3, 1.7)], ['cabbage', cup(3.1)],
  ['cherry tomatoes', cup(5.3)], ['grape tomatoes', cup(5.3)],
  ['tomatoes', both(4.3, 6.4)], ['cucumber', both(10, 4.7)],
  ['carrots', both(2.2, 4.5)], ['celery', both(1.4, 3.6)],
  ['onion', both(3.9, 5.6)], ['scallions', both(0.5, 3.5)],
  ['green onions', both(0.5, 3.5)], ['shallot', both(1.1, 5.6)],
  ['garlic', piece(0.1)], ['ginger', cup(3.4)],
  ['bell peppers', both(4.2, 3.2)], ['jalapeno', both(0.5, 3.2)],
  ['broccoli', cup(3.2)], ['broccolini', piece(6)], ['cauliflower', cup(3.8)],
  ['zucchini', both(6.9, 4.4)], ['squash', cup(4.9)], ['asparagus', piece(0.55)],
  ['brussels sprouts', cup(3.1)], ['green beans', cup(3.9)],
  ['peas', cup(5.1)], ['snap peas', cup(2.2)], ['snow peas', cup(2.2)],
  ['corn', cup(5.8)], ['edamame', cup(5.5)], ['beets', cup(4.8)],
  ['mushrooms', both(0.6, 2.5)], ['potato', both(6.0, 5.3)],
  ['sweet potato', both(6.3, 4.7)], ['avocado', both(4.8, 5.3)],
  ['olives', both(0.15, 4.8)],

  // ── Fruit ──────────────────────────────────────────────────────────────
  ['blueberries', cup(5.2)], ['raspberries', cup(4.3)], ['strawberries', cup(5.9)],
  ['blackberries', cup(5.1)], ['berries', cup(5.2)], ['cherries', cup(4.9)],
  ['cranberries', cup(3.5)], ['dried cranberries', cup(4.3)],
  ['grapes', cup(5.4)], ['watermelon', cup(5.4)], ['pineapple', cup(5.8)],
  ['raisins', cup(5.8)], ['dates', both(0.85, 5.2)], ['mango', both(7.1, 5.8)],
  ['banana', both(4.2, 5.3)], ['apple', both(6.4, 4.4)],
  ['lemon', piece(2.1)], ['lime', piece(1.6)], ['orange', piece(4.6)],
  ['kiwi', piece(2.4)], ['peach', piece(5.3)], ['pear', piece(6.3)],
  ['plum', piece(2.3)],

  // ── Proteins & counted staples ─────────────────────────────────────────
  ['egg', piece(1.8)], ['egg whites', piece(1.2)], ['egg yolk', piece(0.6)],
  ['chicken', cup(4.9)], ['chicken breast', both(6, 4.9)], ['turkey', cup(4.9)],
  ['tuna', both(5, 5.4)], ['shrimp', both(0.4, 5.1)],
  ['protein powder', both(1.1, 4.2)], ['whey protein', both(1.1, 4.2)],
  ['bread', piece(1.5)], ['wrap', piece(2.2)], ['tortilla', piece(1.7)],
  ['pita', piece(2.1)], ['bagel', piece(3.5)],

  // ── Herbs, spices & seasonings ─────────────────────────────────────────
  ['salt', cup(10.2)], ['pepper', cup(3.9)], ['cinnamon', cup(4.4)],
  ['cumin', cup(4.2)], ['paprika', cup(3.9)], ['turmeric', cup(5.1)],
  ['oregano', cup(1.7)], ['basil', cup(0.75)], ['parsley', cup(2.1)],
  ['cilantro', cup(0.6)], ['dill', cup(0.3)], ['thyme', cup(1.7)],
  ['rosemary', cup(1.0)], ['seasoning', cup(5.1)], ['chili flakes', cup(3.0)],
  ['red pepper flakes', cup(3.0)], ['chili powder', cup(4.6)],
];

// ── Matching ────────────────────────────────────────────────────────────────

/** Exact-key form: lowercase with punctuation collapsed to single spaces. */
function normalizeExact(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Naive singular/plural stemming so "blueberries"/"blueberry" and
 * "tomatoes"/"tomato" meet in the middle. Applied identically to names and
 * phrases, so consistency matters more than linguistic correctness.
 */
function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('oes')) return token.slice(0, -2);
  if (
    token.length > 3 &&
    token.endsWith('s') &&
    !token.endsWith('ss') &&
    !token.endsWith('us') &&
    !token.endsWith('is')
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function tokensOf(name: string): string[] {
  return name
    .toLowerCase()
    // "tuna in water", "packed in oil" — the packing medium isn't the food.
    .replace(/\b(?:packed|canned)?\s*in\s+(?:water|oil|brine|juice|syrup)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(stemToken);
}

const KEYWORD_RULES = KEYWORD_MEASURES.map(([phrase, measure]) => ({
  tokens: tokensOf(phrase),
  measure,
}));

/** End index of the LAST occurrence of `parts` as consecutive tokens, or -1. */
function lastMatchEnd(tokens: string[], parts: string[]): number {
  outer: for (let start = tokens.length - parts.length; start >= 0; start -= 1) {
    for (let i = 0; i < parts.length; i += 1) {
      if (tokens[start + i] !== parts[i]) continue outer;
    }
    return start + parts.length - 1;
  }
  return -1;
}

const measureCache = new Map<string, IngredientMeasure | null>();

/**
 * The measure for an ingredient name, or null when it is unrecognized —
 * callers must treat null as "offer no ounce option" rather than guessing.
 */
export function measureForIngredient(name: string): IngredientMeasure | null {
  const cached = measureCache.get(name);
  if (cached !== undefined) return cached;

  let result: IngredientMeasure | null = EXACT_MEASURES[normalizeExact(name)] ?? null;
  if (!result) {
    const tokens = tokensOf(name);
    let bestSize = 0;
    let bestEnd = -1;
    for (const rule of KEYWORD_RULES) {
      const end = lastMatchEnd(tokens, rule.tokens);
      if (end === -1) continue;
      if (
        rule.tokens.length > bestSize ||
        (rule.tokens.length === bestSize && end > bestEnd)
      ) {
        bestSize = rule.tokens.length;
        bestEnd = end;
        result = rule.measure;
      }
    }
  }
  measureCache.set(name, result);
  return result;
}
