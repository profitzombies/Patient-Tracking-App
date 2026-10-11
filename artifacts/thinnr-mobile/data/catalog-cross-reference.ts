/**
 * Reviewed relationships between nutrition variants and official program
 * items. Official display copy remains solely in approved-foods.ts.
 *
 * A relationship is never inferred from a search string at runtime. This
 * module builds only from the reviewer-maintained item-name/USDA-query pairs
 * below, then records an explicit unsupported disposition for every remaining
 * official row. That makes additions to the official list fail verification
 * until they have a review outcome.
 */
import { APPROVED_FOOD_CATEGORIES } from './approved-foods';
import { USDA_ESSENTIALS, USDA_ESSENTIAL_BY_ID } from './usda-essentials';

export type ApprovedCatalogReview =
  | {
      approvedItemId: string;
      status: 'mapped';
      catalogIds: readonly string[];
      rationale: string;
    }
  | {
      approvedItemId: string;
      status: 'unsupported';
      catalogIds: readonly [];
      rationale: string;
    };

/**
 * Verbatim official item name -> reviewed USDA search alias. Constraints are
 * intentionally absent when the available SR row cannot prove them.
 */
const REVIEWED_GENERIC_ALIAS: Readonly<Record<string, string>> = {
  Bison: 'bison',
  'Lean Pork Loin': 'pork loin',
  'Lean Pork Chop': 'pork chop',
  Cod: 'cod',
  Flounder: 'flounder',
  Grouper: 'grouper',
  Halibut: 'halibut',
  Lobster: 'lobster',
  Monkfish: 'monkfish',
  'Roughy (Orange or White)': 'roughy',
  Perch: 'perch',
  Pike: 'pike',
  'Sea Bass': 'sea bass',
  Scallops: 'scallop',
  Shrimp: 'shrimp',
  Swordfish: 'swordfish',
  Tilapia: 'tilapia',
  Walleye: 'walleye',
  Asparagus: 'asparagus',
  Broccoli: 'broccoli',
  'Brussel Sprouts': 'brussels sprout',
  'Carrots (3 oz.)': 'carrot',
  Cauliflower: 'cauliflower',
  'Cherry & Grape Tomatoes': 'tomato',
  Eggplant: 'eggplant',
  Fennel: 'fennel',
  'Green Beans': 'green bean',
  Kale: 'kale',
  Leeks: 'leek',
  'Snow Peas': 'snow pea',
  Pumpkin: 'pumpkin',
  Radishes: 'radish',
  Rhubarb: 'rhubarb',
  'Spaghetti Squash': 'spaghetti squash',
  'Summer Squash': 'summer squash',
  'White Onion': 'onion',
  Zucchini: 'zucchini',
  Apple: 'apple',
  Apricot: 'apricot',
  Blackberry: 'blackberry',
  Blueberry: 'blueberry',
  Cherry: 'cherry',
  Cranberry: 'cranberry',
  Elderberry: 'elderberry',
  Grapefruit: 'grapefruit',
  Kiwi: 'kiwi',
  Kumquat: 'kumquat',
  Lemon: 'lemon',
  Lime: 'lime',
  'Melon (all varieties)': 'cantaloupe',
  Nectarine: 'nectarine',
  'Orange (all varieties)': 'orange',
  Papaya: 'papaya',
  Peach: 'peach',
  Pear: 'pear',
  Plum: 'plum',
  Quince: 'quince',
  Raspberry: 'raspberry',
  'Star Fruit': 'star fruit',
  Strawberry: 'strawberry',
  'Banana Peppers': 'pepper',
  'Bell Peppers': 'pepper',
  'Bok Choy': 'bok choy',
  Cabbage: 'cabbage',
  Celery: 'celery',
  Chives: 'chive',
  'Collard Greens': 'collard',
  Cucumbers: 'cucumber',
  Garlic: 'garlic',
  'Green Onion': 'onion',
  'Jalapeno Peppers': 'jalapeno',
  'Iceberg Lettuce': 'iceberg lettuce',
  'Romaine Lettuce': 'romaine',
  Mushrooms: 'mushroom',
  Sauerkraut: 'sauerkraut',
  Spinach: 'spinach',
  'Swiss Chard': 'swiss chard',
  Tomatillo: 'tomatillo',
  Tomato: 'tomato',
  Watercress: 'watercress',
  'Low Sodium Soy Sauce': 'soy sauce',
  'All Vinegars': 'vinegar',
  'EGGS (PASTURE-RAISED IF POSSIBLE)': 'egg',
  'SWEET POTATOES': 'sweet potato',
  AVOCADO: 'avocado',
  'LENTILS (GREEN/BROWN)': 'lentil',
  QUINOA: 'quinoa',
  'ATLANTIC OR SPANISH MACKEREL': 'mackerel',
  'RAW OR LIGHTLY ROASTED NUTS (ALMONDS, PISTACHIOS, WALNUTS)': 'almond',
  'SEEDS (CHIA, FLAX, HEMP)': 'chia seed',
  'EXTRA-VIRGIN OLIVE OIL': 'olive oil',
  'AVOCADO OR AVOCADO OIL': 'avocado',
  'WALNUT OIL': 'walnut',
  'FLAXSEED OIL': 'flaxseed',
  'SESAME OIL (COLD PRESSED ONLY)': 'sesame oil',
  'UNREFINED/VIRGIN COCONUT OIL': 'coconut oil',
  'FATTY FISH (SALMON, MACKEREL, SARDINES)': 'mackerel',
};

// Rows matching these descriptions do not prove the official constraint.
const UNSUITABLE_VARIANT =
  /salad|sweetened|juice drink|nectar|yogurt|muffin|bread|seed|oil|with vegetables|substitute|dried|powder/i;

function catalogIdsFor(alias: string): string[] {
  return USDA_ESSENTIALS
    .filter(food => food.aliases.includes(alias) && !UNSUITABLE_VARIANT.test(food.name))
    .map(food => food.id);
}

export const APPROVED_CATALOG_REVIEW: readonly ApprovedCatalogReview[] =
  APPROVED_FOOD_CATEGORIES.flatMap(category =>
    category.items.map(item => {
      const alias = REVIEWED_GENERIC_ALIAS[item.name];
      const catalogIds = alias ? catalogIdsFor(alias) : [];
      return catalogIds.length > 0
        ? {
            approvedItemId: item.id,
            status: 'mapped' as const,
            catalogIds,
            rationale: `Reviewed USDA generic variant for “${alias}”; official portions remain separate.`,
          }
        : {
            approvedItemId: item.id,
            status: 'unsupported' as const,
            catalogIds: [] as const,
            rationale: alias
              ? 'No retained USDA variant proves all wording or preparation constraints.'
              : 'Rule, branded item, supplement, obscure item, or no reviewed generic USDA variant.',
          };
    }),
  );

const REVIEW_BY_CATALOG_ID = new Map<string, string[]>();
for (const review of APPROVED_CATALOG_REVIEW) {
  if (review.status !== 'mapped') continue;
  for (const catalogId of review.catalogIds) {
    const ids = REVIEW_BY_CATALOG_ID.get(catalogId) ?? [];
    ids.push(review.approvedItemId);
    REVIEW_BY_CATALOG_ID.set(catalogId, ids);
  }
}

/**
 * The only catalog badge gateway. Unknown, branded, and patient/custom IDs
 * cannot pass because the ID must resolve to a reviewed USDA seed and an
 * explicit reviewed relationship.
 */
export function approvedItemIdsForCatalogFood(catalogId: string | undefined): readonly string[] {
  if (!catalogId || !USDA_ESSENTIAL_BY_ID.has(catalogId)) return [];
  return REVIEW_BY_CATALOG_ID.get(catalogId) ?? [];
}

/**
 * Existing fd_* references remain resolvable. A null value is intentional:
 * composite, branded, or restaurant library rows keep their historical snapshot
 * rather than being falsely represented as a USDA generic.
 */
export const LEGACY_FOOD_CATALOG_ALIAS: Readonly<Record<string, string | null>> = {
  fd_chicken_breast: 'chicken breast',
  fd_ground_turkey: 'ground turkey',
  fd_salmon: 'salmon',
  fd_tuna_can: null,
  fd_shrimp: 'shrimp',
  fd_cod: 'cod',
  fd_sirloin: 'sirloin',
  fd_egg: 'egg',
  fd_egg_whites: 'egg white',
  fd_tofu: 'tofu',
  fd_deli_turkey: 'turkey breast',
  fd_rotisserie: null,
  fd_greek_yogurt: 'yogurt',
  fd_cottage_cheese: 'cottage cheese',
  fd_cheddar: 'cheddar',
  fd_feta: 'feta',
  fd_mozzarella: 'mozzarella',
  fd_skim_milk: 'milk',
  fd_almond_milk: null,
  fd_string_cheese: null,
  fd_brown_rice: 'brown rice',
  fd_quinoa: 'quinoa',
  fd_oats: 'oat',
  fd_ww_bread: 'whole wheat bread',
  fd_ww_wrap: null,
  fd_ww_pasta: 'whole wheat pasta',
  fd_sweet_potato: 'sweet potato',
  fd_apple: 'apple',
  fd_banana: 'banana',
  fd_blueberries: 'blueberry',
  fd_strawberries: 'strawberry',
  fd_raspberries: 'raspberry',
  fd_orange: 'orange',
  fd_grapes: 'grape',
  fd_watermelon: 'watermelon',
  fd_avocado: 'avocado',
  fd_broccoli: 'broccoli',
  fd_spinach: 'spinach',
  fd_romaine: 'romaine',
  fd_carrots: 'carrot',
  fd_cucumber: 'cucumber',
  fd_bell_pepper: 'pepper',
  fd_cherry_tomatoes: 'tomato',
  fd_zucchini: 'zucchini',
  fd_asparagus: 'asparagus',
  fd_brussels: 'brussels sprout',
  fd_kale: 'kale',
  fd_cauli_rice: 'cauliflower',
  fd_almonds: 'almond',
  fd_walnuts: 'walnut',
  fd_peanut_butter: 'peanut butter',
  fd_almond_butter: null,
  fd_hummus: 'hummus',
  fd_protein_bar: null,
  fd_rice_cake: null,
  fd_dark_chocolate: null,
  fd_popcorn: 'popcorn',
  fd_protein_powder: null,
  fd_trail_mix: null,
  fd_coffee: 'coffee',
  fd_green_tea: 'green tea',
  fd_latte: null,
  fd_oj: 'orange juice',
  fd_kombucha: null,
  fd_sparkling: null,
  fd_olive_oil: 'olive oil',
  fd_butter: 'butter',
  fd_light_mayo: 'mayonnaise',
  fd_ranch_light: null,
  fd_vinaigrette: null,
  fd_honey: 'honey',
  fd_salsa: 'salsa',
  fd_soy_sauce: 'soy sauce',
  fd_turkey_sandwich: null,
  fd_burrito_bowl: null,
  fd_pizza_slice: null,
  fd_california_roll: null,
  fd_burger: null,
  fd_caesar_side: null,
};

/** Resolve an old ID without silently substituting unsupported composites. */
export function catalogFoodIdForLegacyId(legacyId: string): string | undefined {
  const alias = LEGACY_FOOD_CATALOG_ALIAS[legacyId];
  if (!alias) return undefined;
  return USDA_ESSENTIALS.find(food => food.aliases.includes(alias))?.id;
}