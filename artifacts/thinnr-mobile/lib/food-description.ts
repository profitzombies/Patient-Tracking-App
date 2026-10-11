/**
 * Turns what the app knows about a food into the shared classifier's
 * FoodDescription. The catalog carries no diet tags, so the bridge derives
 * conservative ones from (a) the Approved Foods section the food maps to and
 * (b) a short, whole-word keyword table over the food's name. Anything it
 * cannot place stays untagged, and the classifier answers "unknown" — the
 * app never guesses a verdict it cannot back.
 */
import type { FoodDescription } from '@/lib/diet-fit';
import { APPROVED_MATCH_BY_FOOD, CATEGORY_BY_ITEM_ID, isApprovedFood } from '@/data/approved-foods';

/** The slice of a food the bridge reads (FoodItem, CatalogFood and diary rows all satisfy it). */
export interface DescribableFood {
  id?: string;
  refId?: string;
  name: string;
  brand?: string;
  carbs?: number;
  calories?: number;
  servingGrams?: number;
  /** Explicit reviewed relationship from the shared catalog (never inferred for private foods). */
  approved?: boolean;
  catalogApproved?: boolean;
  /** Free-text ingredient names when the app has them (recipes, AI meals). */
  ingredients?: readonly string[];
  /** Growing-catalog metadata on basket items (serving weight lives here). */
  catalog?: { servingGrams?: number } | null;
}

const SECTION_TAGS: Record<string, readonly string[]> = {
  beef: ['meat', 'red_meat'],
  pork: ['meat', 'pork', 'red_meat'],
  poultry: ['meat', 'poultry'],
  lunchmeat: ['meat', 'processed_meat'],
  seafood: ['fish'],
  vegetables: ['vegetable'],
  fruits: ['fruit'],
  bread_grain: ['grain', 'whole_grain'],
  fats_oils: ['high_fat'],
};

/**
 * Whole-word name keywords → tags. Deliberately short: a wrong tag would
 * turn into a wrong verdict, while a missing tag only means "unknown".
 */
const KEYWORD_TAGS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\b(beef|steak|sirloin|burger|bison|venison|lamb|elk|veal)\b/, ['meat', 'red_meat']],
  [/\b(pork|bacon|ham|sausage|prosciutto|pancetta)\b/, ['meat', 'pork']],
  [/\b(bacon|sausage|salami|pepperoni|hot ?dog|deli|lunchmeat|jerky)\b/, ['processed_meat']],
  [/\b(chicken|turkey|duck|poultry)\b/, ['meat', 'poultry']],
  [/\b(salmon|tuna|cod|tilapia|trout|halibut|sardines?|anchov(?:y|ies)|mackerel|haddock|fish)\b/, ['fish']],
  [/\b(salmon|sardines?|mackerel|anchov(?:y|ies)|herring|trout)\b/, ['oily_fish']],
  [/\b(shrimp|prawns?|crab|lobster|clams?|mussels?|oysters?|scallops?|crawfish)\b/, ['shellfish']],
  [/\b(eggs?|omelet(?:te)?|frittata)\b/, ['egg']],
  [/\b(milk|cheese|yogurt|yoghurt|cream|butter|kefir|whey|cottage|mozzarella|cheddar|parmesan|feta|ricotta)\b/, ['dairy']],
  [/\b(milk|lactose)\b/, ['milk', 'lactose']],
  [/\b(butter)\b/, ['butter']],
  [/\b(bread|toast|bagel|pasta|noodles?|tortilla|wrap|pita|cracker|crackers|cereal|oatmeal|oats|granola|flour|pancakes?|waffles?|muffin|croissant|couscous|bulgur|barley|rye|wheat|pizza|bun|roll|pretzel)\b/, ['grain']],
  [/\b(bread|toast|bagel|pasta|noodles?|tortilla|wrap|pita|cracker|crackers|flour|pancakes?|waffles?|muffin|croissant|couscous|bulgur|barley|rye|wheat|pizza|bun|pretzel|seitan)\b/, ['gluten', 'wheat']],
  [/\b(rice|risotto)\b/, ['grain', 'rice']],
  [/\b(corn|popcorn|polenta|cornbread|tortilla chips)\b/, ['corn']],
  [/\b(quinoa|oats|oatmeal|brown rice|whole[- ]wheat|whole[- ]grain)\b/, ['whole_grain']],
  [/\b(beans?|lentils?|chickpeas?|hummus|edamame|peas)\b/, ['legume']],
  [/\b(tofu|tempeh|edamame|soy|miso)\b/, ['soy', 'legume']],
  [/\b(peanuts?|peanut butter)\b/, ['peanut', 'legume']],
  [/\b(almonds?|walnuts?|cashews?|pecans?|pistachios?|hazelnuts?|macadamia)\b/, ['tree_nut']],
  [/\b(sesame|tahini)\b/, ['sesame', 'seed']],
  [/\b(chia|flax|pumpkin seeds?|sunflower seeds?)\b/, ['seed']],
  [/\b(potato(?:es)?|fries|sweet potato|yam|corn)\b/, ['starchy_vegetable', 'vegetable']],
  [/\b(tomato(?:es)?|peppers?|eggplant|paprika)\b/, ['nightshade', 'vegetable']],
  [/\b(tomato(?:es)?)\b/, ['tomato']],
  [/\b(spinach|kale|broccoli|cauliflower|lettuce|salad|zucchini|cucumber|asparagus|cabbage|celery|carrots?|onions?|mushrooms?|greens|brussels|squash|green beans|avocado|arugula)\b/, ['vegetable']],
  [/\b(apple|banana|orange|berries|blueberr(?:y|ies)|strawberr(?:y|ies)|raspberr(?:y|ies)|grapes?|mango|pineapple|peach|pear|melon|watermelon|cherr(?:y|ies)|kiwi|fruit)\b/, ['fruit']],
  [/\b(blueberr(?:y|ies)|strawberr(?:y|ies)|raspberr(?:y|ies)|blackberr(?:y|ies)|berries)\b/, ['berries']],
  [/\b(banana|grapes?|mango|pineapple|dates?|raisins?|dried fruit)\b/, ['high_sugar_fruit']],
  [/\b(orange|lemon|lime|grapefruit|citrus)\b/, ['citrus']],
  [/\b(olive oil)\b/, ['olive_oil']],
  [/\b(fried|crispy|tempura)\b/, ['fried']],
  [/\b(candy|cookies?|cake|brownies?|donuts?|doughnuts?|ice cream|chocolate|syrup|soda|sweetened|dessert|pastry|pie|frosting)\b/, ['added_sugar']],
  [/\b(soda|cola|energy drink|sweet tea|juice)\b/, ['sweetened_beverage']],
  [/\b(honey)\b/, ['honey']],
  [/\b(chocolate|cocoa)\b/, ['chocolate']],
  [/\b(coffee|espresso|latte|cappuccino)\b/, ['coffee', 'caffeine']],
  [/\b(beer|wine|vodka|whiskey|cocktail|margarita|tequila|rum|gin)\b/, ['alcohol']],
  [/\b(beer)\b/, ['beer']],
  [/\b(kimchi|sauerkraut|kombucha|pickles?|pickled)\b/, ['fermented']],
  [/\b(jalape[nñ]o|sriracha|hot sauce|spicy|chili)\b/, ['spicy']],
];

/** Tags the name alone supports (exported for the suite). */
export function tagsFromName(name: string): string[] {
  // Nut and seed butters are not dairy; neutralise the word before matching.
  const text = name.toLowerCase().replace(/\b(peanut|almond|cashew|nut|seed|sunflower|apple|cocoa)[- ]butter\b/g, '$1 spread');
  const out = new Set<string>();
  for (const [pattern, tags] of KEYWORD_TAGS) {
    if (pattern.test(text)) for (const tag of tags) out.add(tag);
  }
  return [...out];
}

function tagsFromApprovedSection(foodId: string | undefined): string[] {
  if (!foodId) return [];
  const itemId = APPROVED_MATCH_BY_FOOD[foodId];
  if (!itemId) return [];
  const category = CATEGORY_BY_ITEM_ID.get(itemId);
  return category ? [...(SECTION_TAGS[category.id] ?? [])] : [];
}

/** Seeded catalog foods carry this prefix; only they were reviewed against the Approved Foods list. */
const SEEDED_CATALOG_PREFIX = 'fd_';

/**
 * Whether a food's membership on the Approved Foods list is known (true/false)
 * or not (undefined).
 *
 * A recorded approval is positive evidence wherever it comes from. The
 * reverse is not true: shared catalog search hits routinely carry
 * `approved: false` (and snapshots `catalogApproved: false`) meaning only
 * that no approval was recorded — not that the food was reviewed and left
 * off the list. Only the seeded catalog was reviewed, so a false flag counts
 * as "not approved" for seeded ids alone; everything else stays unknown and
 * shows no badge during the protocol.
 */
export function approvedFlagFor(food: DescribableFood): boolean | undefined {
  const id = food.id ?? food.refId;
  if (isApprovedFood(id)) return true;
  if (food.approved === true || food.catalogApproved === true) return true;
  if (id?.startsWith(SEEDED_CATALOG_PREFIX) && (food.approved === false || food.catalogApproved === false)) return false;
  return undefined;
}

export function describeFood(food: DescribableFood): FoodDescription {
  const id = food.id ?? food.refId;
  const ingredientTags = (food.ingredients ?? []).flatMap(ingredient => tagsFromName(ingredient));
  const tags = new Set<string>([...tagsFromApprovedSection(id), ...tagsFromName(food.name), ...ingredientTags]);
  const out: FoodDescription = { name: food.name };
  if (tags.size > 0) out.tags = [...tags];
  if (food.ingredients && food.ingredients.length > 0) out.ingredients = food.ingredients;
  if (typeof food.carbs === 'number' && Number.isFinite(food.carbs)) out.carbsPerServing = food.carbs;
  if (typeof food.calories === 'number' && Number.isFinite(food.calories)) out.caloriesPerServing = food.calories;
  const grams = food.servingGrams ?? food.catalog?.servingGrams;
  if (typeof grams === 'number' && grams > 0) out.servingGrams = grams;
  const approved = approvedFlagFor(food);
  if (approved !== undefined) out.thinnrApproved = approved;
  return out;
}

/** A recipe (seeded or coach-saved) as the classifier sees it: ingredient names count. */
export function describeRecipe(recipe: { id: string; name: string; calories: number; carbs: number; ingredients: ReadonlyArray<{ name: string }> }): DescribableFood {
  return { id: recipe.id, name: recipe.name, calories: recipe.calories, carbs: recipe.carbs, ingredients: recipe.ingredients.map(ingredient => ingredient.name) };
}
