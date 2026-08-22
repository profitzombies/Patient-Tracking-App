/**
 * THINNR Approved Foods — structured, machine-readable approved-selections data.
 *
 * WORDING IS VERBATIM. Every `title`, `note`, `name`, `nameParts` fragment,
 * `portion`, and `benefit` string below is copied character-for-character from
 * `docs/thinnr-program/approved-foods.md` (the verbatim extract of the official
 * THINNR Protocol manual). Apparent typos and oddities — "Lean Group Pork",
 * "Brussel Sprouts", the stray paren in "…OILY FISH)" — are intentional and
 * must be preserved. Never reword, "fix", reorder, or re-case these strings.
 *
 * The automated check compares every string back to the source:
 *   pnpm --filter @workspace/thinnr-mobile run test:approved-foods
 *
 * This module is dependency-free (pure data) so scripts can import it outside
 * the Expo runtime. Future program-data extensions (phases, dosing, tracking
 * sheets) should build alongside it and keep category/item ids stable.
 */

export type ApprovedGroupId = 'protein' | 'normalization';

export interface ApprovedFoodItem {
  /** Stable id: `<categoryId>:<slug-of-name>`. */
  id: string;
  /** Verbatim item wording from the manual. */
  name: string;
  /**
   * Present only when the source wording wraps across interleaved two-column
   * lines. Each fragment appears verbatim in the source on its own line, and
   * `nameParts.join(' ')` equals `name`.
   */
  nameParts?: string[];
  /** Verbatim per-item amount wording (RECOMMENDED AMOUNT column, PDF page 9). */
  portion?: string;
  /** Verbatim KEY BENEFITS wording (PDF page 9 tables). */
  benefit?: string;
  /** True when the item appears as a `•` bullet in the source (vs. table row or sentence). */
  bulleted: boolean;
}

export interface ApprovedFoodCategory {
  id: string;
  /** Verbatim section heading from the manual. */
  title: string;
  /** Short UI label for filter chips (app chrome, not program wording). */
  shortLabel: string;
  /** Umbrella group the section belongs to, when the manual nests it under one. */
  group?: ApprovedGroupId;
  /** Verbatim guidance sentence tied to the section. */
  note?: string;
  /** Verbatim portion wording that applies to every item in the section. */
  itemPortion?: string;
  /** PDF page in the manual the section was extracted from. */
  sourcePage: number;
  items: ApprovedFoodItem[];
}

/** Umbrella group headings, verbatim from the manual. */
export const APPROVED_GROUPS: Record<ApprovedGroupId, { title: string; note?: string }> = {
  protein: {
    title: 'Thinnr-Approved Protein Selections (Must Be Consumed At Each Meal)',
    note: 'Please remember that the amount allowed during the metabolic thinning phase is 5-6 oz. If you are eating lunchmeat, it needs to be 93/7 or leaner or marked as “Heart Healthy.”',
  },
  normalization: {
    title: 'Additional Low-Glycemic & Anti-Inflammatory Foods That Can Be Added During The Thinnr Metabolic Normalization Phase',
  },
};

interface RawItem {
  name: string;
  nameParts?: string[];
  portion?: string;
  benefit?: string;
  bulleted?: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cat(
  id: string,
  title: string,
  shortLabel: string,
  sourcePage: number,
  opts: { group?: ApprovedGroupId; note?: string; itemPortion?: string; defaultBulleted?: boolean },
  rawItems: RawItem[],
): ApprovedFoodCategory {
  return {
    id,
    title,
    shortLabel,
    group: opts.group,
    note: opts.note,
    itemPortion: opts.itemPortion,
    sourcePage,
    items: rawItems.map(raw => ({
      id: `${id}:${slugify(raw.name)}`,
      name: raw.name,
      nameParts: raw.nameParts,
      portion: raw.portion,
      benefit: raw.benefit,
      bulleted: raw.bulleted ?? opts.defaultBulleted ?? true,
    })),
  };
}

export const APPROVED_FOOD_CATEGORIES: ApprovedFoodCategory[] = [
  cat('beef', 'APPROVED BEEF', 'Beef', 45, { group: 'protein', itemPortion: '5-6 oz.' }, [
    { name: 'Any ground beef that is 93/7 or leaner', nameParts: ['Any ground beef that is', '93/7 or leaner'] },
    { name: 'Bison' },
    { name: 'Elk' },
    { name: 'Filet Mignon' },
    { name: 'Lean Ground Sirloin' },
    { name: 'London Broil' },
    { name: 'Sirloin Strip Steak' },
    { name: 'Veal (ground)' },
    { name: 'Venison' },
  ]),
  cat('pork', 'APPROVED PORK', 'Pork', 45, { group: 'protein', itemPortion: '5-6 oz.' }, [
    { name: 'Lean Pork Loin' },
    { name: 'Lean Pork Chop' },
    { name: 'Lean Cuts Of Wild Boar' },
    { name: 'Lean Group Pork (Ground Pork Loin)' },
  ]),
  cat('poultry', 'APPROVED POULTRY', 'Poultry', 45, { group: 'protein', itemPortion: '5-6 oz.' }, [
    { name: 'Skinless White Meat Chicken Breast' },
    { name: 'Ground White Meat Chicken' },
    { name: 'Skinless White Meat Turkey' },
    { name: 'Ground White Meat Turkey' },
    { name: 'Turkey Tenderloin' },
    { name: 'Cornish Game Hen' },
    { name: 'Emu' },
    { name: 'Ostrich' },
  ]),
  cat('lunchmeat', 'APPROVED LUNCHMEAT', 'Lunchmeat', 45, { group: 'protein', itemPortion: '5-6 oz.' }, [
    {
      name: 'Any lunchmeat that is 93/7 or leaner or labeled as “Heart Healthy” is an approved selection.',
      bulleted: false,
    },
  ]),
  cat('seafood', 'APPROVED SEAFOOD', 'Seafood', 46, { group: 'protein', itemPortion: '5-6 oz.' }, [
    { name: 'Crab (Alaskan King, Queen, & Blue' },
    { name: 'Canned Tuna – Water Packed' },
    { name: 'Cod' },
    { name: 'Flounder' },
    { name: 'Grouper' },
    { name: 'Halibut' },
    { name: 'Lobster' },
    { name: 'Mahi Mahi' },
    { name: 'Monkfish' },
    { name: 'Roughy (Orange or White)' },
    { name: 'Perch' },
    { name: 'Pike' },
    { name: 'Sea Bass' },
    { name: 'Scallops' },
    { name: 'Shrimp' },
    { name: 'Swordfish' },
    { name: 'Tilapia' },
    { name: 'Walleye' },
  ]),
  cat('vegetables', 'Thinnr-Approved Vegetable Selection (Must Be Consumed At Each Meal)', 'Vegetables', 46, {}, [
    { name: 'Amaranth' },
    { name: 'Acorn Squash' },
    { name: 'Asparagus' },
    { name: 'Belgian Endive' },
    { name: 'Bitter Melon/Gourd' },
    { name: 'Boston Bib Lettuce' },
    { name: 'Broccoli' },
    { name: 'Broccoflower' },
    { name: 'Broccolini' },
    { name: 'Brussel Sprouts' },
    { name: 'Butter Lettuce' },
    { name: 'Carrots (3 oz.)' },
    { name: 'Cauliflower' },
    { name: 'Celery Root' },
    { name: 'Chayote Squash/Cho Cho' },
    { name: 'Cherry & Grape Tomatoes' },
    { name: 'Chinese Eggplant' },
    { name: 'Crookneck Squash' },
    { name: 'Eggplant' },
    { name: 'Fennel' },
    { name: 'Fiddlehead Ferns' },
    { name: 'Green Beans' },
    { name: 'Horseradish Root' },
    { name: 'Kale' },
    { name: 'Kohlrabi' },
    { name: 'Leeks' },
    { name: 'Snow Peas' },
    { name: 'Sugar Snap Peas' },
    { name: 'Pumpkin' },
    { name: 'Purple Asparagus' },
    { name: 'Radicchio' },
    { name: 'Radish Leaves' },
    { name: 'Radishes' },
    { name: 'Ramps (wild leeks)' },
    { name: 'Rhubarb' },
    { name: 'Chayote Squash' },
    { name: 'Spaghetti Squash' },
    { name: 'Summer Squash' },
    { name: 'Sweet Dumpling Squash' },
    { name: 'White Onion' },
    { name: 'Vidalia (Sweet) Onions' },
    { name: 'Zucchini' },
  ]),
  cat('fruits', 'Thinnr-Approved Fruit Selection (Must Be Consumed At Each Meal)', 'Fruits', 46, {}, [
    { name: 'Apple' },
    { name: 'Apricot' },
    { name: 'Bilberry' },
    { name: 'Blackberry' },
    { name: 'Blueberry' },
    { name: 'Boysenberry' },
    { name: 'Currant' },
    { name: 'Cherry' },
    { name: 'Cloud Fruit' },
    { name: 'Cranberry' },
    { name: 'Damson' },
    { name: 'Dragon Fruit' },
    { name: 'Elderberry' },
    { name: 'Grapefruit' },
    { name: 'Honeyberry' },
    { name: 'Huckleberry' },
    { name: 'Kiwi' },
    { name: 'Kumquat' },
    { name: 'Lemon' },
    { name: 'Lime' },
    { name: 'Loquat' },
    { name: 'Melon (all varieties)' },
    { name: 'Mulberry' },
    { name: 'Nectarine' },
    { name: 'Orange (all varieties)' },
    { name: 'Papaya' },
    { name: 'Peach' },
    { name: 'Pear' },
    { name: 'Plum' },
    { name: 'Pineberry' },
    { name: 'Pluot' },
    { name: 'Pomello' },
    { name: 'Purple Mangosteen' },
    { name: 'Quince' },
    { name: 'Raspberry' },
    { name: 'Sapodilla' },
    { name: 'Star Fruit' },
    { name: 'Strawberry' },
    { name: 'Tamarillo' },
  ]),
  cat('bread_grain', 'Optional Thinnr-Approved Bread/Grain', 'Bread/Grain', 47, {}, [
    { name: 'Melba toast' },
    { name: 'Melba toast snacks (Any Flavor)' },
    { name: 'Grissini breadstick' },
    { name: 'Ole’ brand ‘Extreme Wellness’ tortilla' },
    { name: 'Joseph’s Lavash Pita Bread' },
    { name: 'Flat Out Flavor It (1)' },
    { name: 'Wasa Bread (1-2 pieces)' },
  ]),
  cat(
    'free_vegetables',
    'Optional Thinnr-Approved Free Vegetables (Unlimited Quantity With Meals ONLY)',
    'Free Vegetables',
    47,
    {},
    [
      { name: 'Banana Peppers' },
      { name: 'Bitter Leaf' },
      { name: 'Bell Peppers' },
      { name: 'Bok Choy' },
      { name: 'Cabbage' },
      { name: 'Callaloo' },
      { name: 'Celery' },
      { name: 'Chives' },
      { name: 'Collard Greens' },
      { name: 'Cucumbers' },
      { name: 'Daikon Radish' },
      { name: 'Dandelion Greens' },
      { name: 'Garlic' },
      { name: 'Green Onion' },
      { name: 'Jalapeno Peppers' },
      { name: 'Iceberg Lettuce' },
      { name: 'Manoah Lettuce' },
      { name: 'Red Leaf Lettuce' },
      { name: 'Romaine Lettuce' },
      { name: 'Mushrooms' },
      { name: 'Red Onions' },
      { name: 'Sauerkraut' },
      { name: 'Spinach' },
      { name: 'Swiss Chard' },
      { name: 'Tomatillo' },
      { name: 'Tomato' },
      { name: 'Watercress' },
    ],
  ),
  cat('fats_oils', 'Thinnr-Approved Alternatives To Fats, Oils, And Butter', 'Fats & Oils', 47, {}, [
    { name: 'Any 0-Calorie Cooking Spray Is Approved', bulleted: false },
  ]),
  cat(
    'sauces_seasonings',
    'Thinnr-Approved Sauce, Seasoning, and Flavor Enhancer Selections',
    'Sauces & Seasonings',
    47,
    {},
    [
      {
        name: 'All 0-Calorie sauces, seasonings, and dressings are approved',
        nameParts: ['All 0-Calorie sauces, seasonings, and', 'dressings are approved'],
      },
      { name: '0-Calorie Coffee Creamer' },
      { name: '0-Calorie Coffee Flavoring' },
      { name: 'Salt' },
      { name: 'Pepper' },
      { name: 'Garlic' },
      { name: 'Low Sodium Soy Sauce' },
      {
        name: 'Braggs Amino Acids (alternative to soy sauce)',
        nameParts: ['Braggs Amino Acids (alternative to', 'soy sauce)'],
      },
      { name: 'Worcestershire Sauce' },
      { name: 'All Vinegars' },
      { name: 'All 0-Calorie Hot Sauces' },
      { name: 'All Fresh Or Dried Herbs' },
      { name: 'All 0-Calorie Seasoning Blend' },
      { name: 'All Powdered Taco & Fajita Seasonings' },
      { name: 'All 0-Calorie BBQ Rub' },
      { name: 'No Sugar Added Pico de Gallo' },
      { name: 'All Citrus Juice Citrus (1-2 tsp)' },
    ],
  ),
  cat(
    'norm_foods',
    'Low-Glycemic & Anti-Inflammatory Foods',
    'Normalization Foods',
    9,
    { group: 'normalization', defaultBulleted: false },
    [
      {
        name: 'EGGS (PASTURE-RAISED IF POSSIBLE)',
        portion: '1–2',
        benefit: 'High-quality protein, choline; anti-inflammatory if not fried in processed oils',
      },
      { name: 'SWEET POTATOES', portion: '3–6 oz', benefit: 'Slow-digesting carbs with beta-carotene' },
      { name: 'AVOCADO', portion: '½ medium avocado', benefit: 'Healthy fats + fiber; virtually no blood sugar spike' },
      { name: 'CHERRIES (TART)', portion: '3–6 oz', benefit: 'Potent anti-inflammatory compounds' },
      {
        name: 'LENTILS (GREEN/BROWN)',
        portion: '3 oz if eating other complex carbs; 5–6 oz if no other complex carbs',
        benefit: 'Low-GI, plant-based protein',
      },
      {
        name: 'QUINOA',
        portion: '3 oz if eating other complex carbs; 5–6 oz if no other complex carbs',
        benefit: 'Complete protein; lower GI than most grains',
      },
      { name: 'WILD-CAUGHT SALMON OR OTHER OILY FISH)', portion: '6–8 oz', benefit: 'Rich in omega-3 fatty acids' },
      { name: 'ATLANTIC OR SPANISH MACKEREL', portion: '6–8 oz', benefit: 'Omega-3-rich oily fish' },
      {
        name: 'RAW OR LIGHTLY ROASTED NUTS (ALMONDS, PISTACHIOS, WALNUTS)',
        portion: '1–2 oz',
        benefit: 'Healthy fats, fiber, and antioxidants',
      },
      { name: 'SEEDS (CHIA, FLAX, HEMP)', portion: '1–2 tbsp', benefit: 'Healthy fats, fiber, omega-3s' },
    ],
  ),
  cat(
    'norm_oils',
    'Healthy Oils/Fats (1–1.5 TBSP Per Day)',
    'Healthy Oils',
    9,
    { group: 'normalization', itemPortion: '1–1.5 TBSP Per Day', defaultBulleted: false },
    [
      { name: 'EXTRA-VIRGIN OLIVE OIL', benefit: 'Monounsaturated fats + polyphenols' },
      { name: 'AVOCADO OR AVOCADO OIL', benefit: 'Healthy monounsaturated fats' },
      { name: 'WALNUT OIL', benefit: 'Omega-3 and polyunsaturated fats' },
      { name: 'FLAXSEED OIL', benefit: 'Plant-based omega-3s (ALA)' },
      { name: 'HEMP SEED OIL', benefit: 'Balanced omega-3 and omega-6' },
      { name: 'SESAME OIL (COLD PRESSED ONLY)', benefit: 'Antioxidants + healthy fats' },
      { name: 'UNREFINED/VIRGIN COCONUT OIL', benefit: 'MCT fats for quick energy' },
      { name: 'SEEDS (CHIA, FLAX, HEMP)', benefit: 'Fiber + omega-3s' },
      { name: 'FATTY FISH (SALMON, MACKEREL, SARDINES)', benefit: 'Omega-3-rich protein source' },
      { name: 'ESSENTIAL FATTY ACID SUPPLEMENT', benefit: 'Follow dosing directions on the bottle' },
    ],
  ),
];

// ─── Lookups ─────────────────────────────────────────────────────────────────

export const APPROVED_ITEMS: ApprovedFoodItem[] = APPROVED_FOOD_CATEGORIES.flatMap(c => c.items);

const ITEM_BY_ID = new Map<string, ApprovedFoodItem>(APPROVED_ITEMS.map(item => [item.id, item]));

export const CATEGORY_BY_ITEM_ID = new Map<string, ApprovedFoodCategory>(
  APPROVED_FOOD_CATEGORIES.flatMap(c => c.items.map(item => [item.id, c] as const)),
);

function itemId(categoryId: string, name: string): string {
  const category = APPROVED_FOOD_CATEGORIES.find(c => c.id === categoryId);
  const item = category?.items.find(i => i.name === name);
  if (!item) throw new Error(`Approved item not found: ${categoryId} / ${name}`);
  return item.id;
}

/**
 * Seeded database foods that correspond to an approved item. Only `fd_*` ids
 * from FOOD_DB may appear here — patient-created foods (id prefix `custom_`)
 * must never map to an approved item, so they never earn the checkmark.
 */
export const APPROVED_MATCH_BY_FOOD: Record<string, string> = {
  fd_chicken_breast: itemId('poultry', 'Skinless White Meat Chicken Breast'),
  fd_ground_turkey: itemId('poultry', 'Ground White Meat Turkey'),
  fd_deli_turkey: itemId(
    'lunchmeat',
    'Any lunchmeat that is 93/7 or leaner or labeled as “Heart Healthy” is an approved selection.',
  ),
  fd_sirloin: itemId('beef', 'Sirloin Strip Steak'),
  fd_tuna_can: itemId('seafood', 'Canned Tuna – Water Packed'),
  fd_shrimp: itemId('seafood', 'Shrimp'),
  fd_cod: itemId('seafood', 'Cod'),
  fd_salmon: itemId('norm_foods', 'WILD-CAUGHT SALMON OR OTHER OILY FISH)'),
  fd_egg: itemId('norm_foods', 'EGGS (PASTURE-RAISED IF POSSIBLE)'),
  fd_sweet_potato: itemId('norm_foods', 'SWEET POTATOES'),
  fd_avocado: itemId('norm_foods', 'AVOCADO'),
  fd_quinoa: itemId('norm_foods', 'QUINOA'),
  fd_almonds: itemId('norm_foods', 'RAW OR LIGHTLY ROASTED NUTS (ALMONDS, PISTACHIOS, WALNUTS)'),
  fd_walnuts: itemId('norm_foods', 'RAW OR LIGHTLY ROASTED NUTS (ALMONDS, PISTACHIOS, WALNUTS)'),
  fd_broccoli: itemId('vegetables', 'Broccoli'),
  fd_asparagus: itemId('vegetables', 'Asparagus'),
  fd_zucchini: itemId('vegetables', 'Zucchini'),
  fd_brussels: itemId('vegetables', 'Brussel Sprouts'),
  fd_kale: itemId('vegetables', 'Kale'),
  fd_carrots: itemId('vegetables', 'Carrots (3 oz.)'),
  fd_cauli_rice: itemId('vegetables', 'Cauliflower'),
  fd_cherry_tomatoes: itemId('vegetables', 'Cherry & Grape Tomatoes'),
  fd_spinach: itemId('free_vegetables', 'Spinach'),
  fd_romaine: itemId('free_vegetables', 'Romaine Lettuce'),
  fd_cucumber: itemId('free_vegetables', 'Cucumbers'),
  fd_bell_pepper: itemId('free_vegetables', 'Bell Peppers'),
  fd_apple: itemId('fruits', 'Apple'),
  fd_blueberries: itemId('fruits', 'Blueberry'),
  fd_strawberries: itemId('fruits', 'Strawberry'),
  fd_raspberries: itemId('fruits', 'Raspberry'),
  fd_orange: itemId('fruits', 'Orange (all varieties)'),
  fd_watermelon: itemId('fruits', 'Melon (all varieties)'),
  fd_soy_sauce: itemId('sauces_seasonings', 'Low Sodium Soy Sauce'),
};

/**
 * Reverse lookup: approved item id → the database food logged when the item is
 * added to the diary from the Approved Foods list. When several foods match
 * one item (e.g. almonds and walnuts both match the nuts row), the first
 * mapping above wins.
 */
export const FOOD_BY_APPROVED_ITEM: Record<string, string> = (() => {
  const reverse: Record<string, string> = {};
  for (const [foodId, approvedId] of Object.entries(APPROVED_MATCH_BY_FOOD)) {
    if (!(approvedId in reverse)) reverse[approvedId] = foodId;
  }
  return reverse;
})();

/** True when a food id (seeded or custom) corresponds to an approved item. */
export function isApprovedFood(foodId: string | undefined): boolean {
  return foodId !== undefined && foodId in APPROVED_MATCH_BY_FOOD;
}

export function approvedItemForFood(foodId: string): ApprovedFoodItem | undefined {
  const id = APPROVED_MATCH_BY_FOOD[foodId];
  return id ? ITEM_BY_ID.get(id) : undefined;
}

/** Item-level portion wording, falling back to the section-wide wording. */
export function approvedPortion(item: ApprovedFoodItem, category: ApprovedFoodCategory): string | undefined {
  return item.portion ?? category.itemPortion;
}

/** One consistent, short explanation of what the checkmark badge means. */
export const APPROVED_BADGE_EXPLANATION = 'Approved for the THINNR program';
