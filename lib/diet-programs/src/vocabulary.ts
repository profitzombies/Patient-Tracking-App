/**
 * Shared vocabulary for the diet programs library.
 *
 * Foods are described to the classifier with TAGS from this closed list
 * (what a food is made of or how it behaves), ALLERGEN keys (direct
 * ingredients and "may contain" lines), and free-text ingredient names.
 * Diet fit rules, restriction rules and sensitivity rules all refer to the
 * same tag names, so one tagging of a food answers every question at once.
 */

export const FOOD_TAGS = [
  // protein sources
  "meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish",
  "egg", "raw_egg",
  // dairy
  "dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "unpasteurized",
  // plants
  "vegetable", "starchy_vegetable", "nightshade", "fruit", "high_sugar_fruit", "berries", "citrus", "tomato", "legume", "soy", "peanut", "tree_nut", "seed", "sesame",
  // grains
  "grain", "whole_grain", "refined_grain", "gluten", "wheat", "corn", "rice",
  // fats and oils
  "olive_oil", "seed_oil", "high_fat", "fried", "trans_fat",
  // sugar, sweeteners, additives
  "added_sugar", "sweetener", "honey", "artificial_additive", "ultra_processed", "high_sodium",
  // drinks and stimulants
  "alcohol", "beer", "caffeine", "coffee", "carbonated", "sweetened_beverage",
  // condition-specific loads
  "high_fodmap", "high_histamine", "fermented", "leftover", "high_oxalate", "high_purine", "spicy", "acidic", "chocolate", "mint", "lactose",
  // program marker
  "thinnr_approved",
] as const;
export type FoodTag = (typeof FOOD_TAGS)[number];
const FOOD_TAG_SET: ReadonlySet<string> = new Set(FOOD_TAGS);
export function isFoodTag(value: unknown): value is FoodTag {
  return typeof value === "string" && FOOD_TAG_SET.has(value);
}

/** The nine US major allergens plus the extras patients most often record. */
export const ALLERGEN_KEYS = [
  "milk", "egg", "peanut", "tree_nut", "soy", "wheat", "fish", "shellfish", "sesame", "gluten", "mustard", "celery", "lupin", "sulfites", "corn",
] as const;
export type AllergenKey = (typeof ALLERGEN_KEYS)[number];
export const ALLERGEN_LABELS: Record<AllergenKey, string> = {
  milk: "Milk", egg: "Egg", peanut: "Peanut", tree_nut: "Tree nuts", soy: "Soy", wheat: "Wheat", fish: "Fish", shellfish: "Shellfish",
  sesame: "Sesame", gluten: "Gluten", mustard: "Mustard", celery: "Celery", lupin: "Lupin", sulfites: "Sulfites", corn: "Corn",
};
/**
 * Ingredient words that name an allergen. Used when a food carries only a
 * free-text ingredient list (no tags, no allergen line) so a recorded allergy
 * is still caught. Whole-word, case-insensitive matches against each
 * ingredient name; kept deliberately conservative (common names only).
 */
export const ALLERGEN_INGREDIENT_TERMS: Record<AllergenKey, readonly string[]> = {
  milk: ["milk", "cheese", "butter", "cream", "yogurt", "yoghurt", "whey", "casein", "lactose", "ghee", "buttermilk", "kefir"],
  egg: ["egg", "eggs", "egg white", "egg yolk", "albumen", "mayonnaise"],
  peanut: ["peanut", "peanuts", "peanut butter", "groundnut"],
  tree_nut: ["almond", "almonds", "walnut", "walnuts", "cashew", "cashews", "pecan", "pecans", "pistachio", "pistachios", "hazelnut", "hazelnuts", "macadamia", "brazil nut", "brazil nuts", "pine nut", "pine nuts"],
  soy: ["soy", "soya", "soybean", "soybeans", "tofu", "tempeh", "edamame", "soy sauce", "miso"],
  wheat: ["wheat", "flour", "wheat flour", "semolina", "durum", "spelt", "farro", "couscous", "bulgur", "seitan"],
  fish: ["fish", "salmon", "tuna", "cod", "tilapia", "anchovy", "anchovies", "sardine", "sardines", "trout", "halibut", "haddock", "mackerel", "fish sauce"],
  shellfish: ["shrimp", "prawn", "prawns", "crab", "lobster", "clam", "clams", "mussel", "mussels", "oyster", "oysters", "scallop", "scallops", "crawfish", "crayfish"],
  sesame: ["sesame", "tahini", "sesame oil", "sesame seeds"],
  gluten: ["wheat", "barley", "rye", "malt", "flour", "wheat flour", "semolina", "spelt", "farro", "couscous", "bulgur", "seitan", "brewer's yeast"],
  mustard: ["mustard", "mustard seed", "dijon"],
  celery: ["celery", "celeriac", "celery salt"],
  lupin: ["lupin", "lupine", "lupin flour"],
  sulfites: ["sulfite", "sulfites", "sulphite", "sulphites", "sulfur dioxide", "sodium metabisulfite"],
  corn: ["corn", "cornstarch", "corn starch", "corn syrup", "cornmeal", "maize", "polenta", "masa"],
};
/** Food tags that imply an allergen even when the food carries no allergen line. */
export const ALLERGEN_IMPLIED_BY_TAGS: Record<AllergenKey, readonly FoodTag[]> = {
  milk: ["dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "lactose"],
  egg: ["egg", "raw_egg"],
  peanut: ["peanut"],
  tree_nut: ["tree_nut"],
  soy: ["soy"],
  wheat: ["wheat"],
  fish: ["fish", "oily_fish", "high_mercury_fish", "raw_fish"],
  shellfish: ["shellfish"],
  sesame: ["sesame"],
  gluten: ["gluten", "wheat"],
  mustard: [],
  celery: [],
  lupin: [],
  sulfites: [],
  corn: ["corn"],
};

export type PreferenceList = "allergy" | "sensitivity" | "restriction" | "dislike";
export const PREFERENCE_LISTS: readonly PreferenceList[] = ["allergy", "sensitivity", "restriction", "dislike"];
export type AllergySeverity = "mild" | "severe";

export interface RestrictionDefinition {
  key: string;
  label: string;
  /** Foods carrying any of these tags do not fit. */
  excludeTags: readonly FoodTag[];
  /** Extra rules the coach follows; rendered as plain text. */
  rules: readonly string[];
  /** Tag combinations that may not appear on one food (kosher: meat with dairy). */
  forbiddenCombinations?: ReadonlyArray<readonly FoodTag[]>;
}

export const RESTRICTIONS: readonly RestrictionDefinition[] = [
  { key: "vegetarian", label: "Vegetarian", excludeTags: ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish"], rules: ["No meat, poultry, fish or shellfish. Eggs and dairy are fine."] },
  { key: "vegan", label: "Vegan", excludeTags: ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat", "fish", "oily_fish", "shellfish", "high_mercury_fish", "raw_fish", "egg", "raw_egg", "dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "honey", "lactose"], rules: ["No animal products at all, including eggs, dairy and honey."] },
  { key: "pescatarian", label: "Pescatarian", excludeTags: ["meat", "red_meat", "pork", "poultry", "processed_meat", "organ_meat"], rules: ["No meat or poultry. Fish, shellfish, eggs and dairy are fine."] },
  { key: "gluten_free", label: "Gluten-free", excludeTags: ["gluten", "wheat"], rules: ["No wheat, barley, rye or anything made from them. Check sauces and dressings."] },
  { key: "dairy_free", label: "Dairy-free", excludeTags: ["dairy", "milk", "aged_cheese", "high_fat_dairy", "butter", "lactose"], rules: ["No milk, cheese, yogurt, butter or cream."] },
  { key: "kosher", label: "Kosher", excludeTags: ["pork", "shellfish"], forbiddenCombinations: [["meat", "dairy"], ["poultry", "dairy"], ["red_meat", "dairy"], ["meat", "milk"], ["poultry", "milk"]], rules: ["No pork or shellfish.", "Meat and dairy are never served or cooked together; a dish with both does not fit.", "Only fish with fins and scales.", "Prefer certified kosher packaged foods."] },
  { key: "halal", label: "Halal", excludeTags: ["pork", "alcohol", "beer"], rules: ["No pork or pork-derived ingredients (gelatin, lard).", "No alcohol, including in cooking.", "Meat should be halal-slaughtered; when unsure, choose fish, eggs or plant protein."] },
  { key: "no_pork", label: "No pork", excludeTags: ["pork"], rules: ["No pork, bacon, ham or lard."] },
  { key: "no_red_meat", label: "No red meat", excludeTags: ["red_meat", "pork"], rules: ["No beef, lamb or pork. Poultry and fish are fine."] },
  { key: "no_alcohol", label: "No alcohol", excludeTags: ["alcohol", "beer"], rules: ["No alcoholic drinks and no alcohol in recipes."] },
  { key: "no_shellfish", label: "No shellfish", excludeTags: ["shellfish"], rules: ["No shrimp, crab, lobster, clams, mussels or oysters."] },
  { key: "low_sodium", label: "Low sodium", excludeTags: ["high_sodium", "processed_meat"], rules: ["Skip cured meats, canned soups and salty snacks; season with herbs and citrus."] },
];
export const RESTRICTION_BY_KEY: ReadonlyMap<string, RestrictionDefinition> = new Map(RESTRICTIONS.map((r) => [r.key, r]));

export interface SensitivityDefinition {
  key: string;
  label: string;
  excludeTags: readonly FoodTag[];
}
export const SENSITIVITIES: readonly SensitivityDefinition[] = [
  { key: "lactose", label: "Lactose", excludeTags: ["lactose", "milk"] },
  { key: "gluten", label: "Gluten (non-celiac)", excludeTags: ["gluten", "wheat"] },
  { key: "fodmap", label: "FODMAPs", excludeTags: ["high_fodmap"] },
  { key: "histamine", label: "Histamine", excludeTags: ["high_histamine", "fermented", "aged_cheese", "processed_meat", "leftover"] },
  { key: "caffeine", label: "Caffeine", excludeTags: ["caffeine", "coffee"] },
  { key: "nightshades", label: "Nightshades", excludeTags: ["nightshade", "tomato"] },
  { key: "sulfites", label: "Sulfites", excludeTags: [] },
  { key: "artificial_sweeteners", label: "Artificial sweeteners", excludeTags: ["sweetener"] },
  { key: "spicy", label: "Spicy food", excludeTags: ["spicy"] },
  { key: "fructose", label: "Fructose", excludeTags: ["high_sugar_fruit", "honey", "sweetened_beverage"] },
];
export const SENSITIVITY_BY_KEY: ReadonlyMap<string, SensitivityDefinition> = new Map(SENSITIVITIES.map((s) => [s.key, s]));

export const ACTIVITY_LEVELS = ["sedentary", "light", "moderate", "active", "very_active"] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];
export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: "Mostly sitting",
  light: "Light activity 1-3 days a week",
  moderate: "Moderate activity 3-5 days a week",
  active: "Hard activity 6-7 days a week",
  very_active: "Very hard activity or a physical job",
};
export function isActivityLevel(value: unknown): value is ActivityLevel {
  return typeof value === "string" && (ACTIVITY_LEVELS as readonly string[]).includes(value);
}

/** Where an activity-level answer came from. Mirrors the patient_activity_levels CHECK constraint exactly. */
export const ACTIVITY_SOURCES = ["diet_selection", "check_in", "settings", "staff"] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export const SCREENING_QUESTIONS = ["medication", "eating_disorder", "pregnancy"] as const;
export type ScreeningQuestion = (typeof SCREENING_QUESTIONS)[number];
export type ScreeningAnswer = "yes" | "no" | "skipped";
export const SCREENING_PROMPTS: Record<ScreeningQuestion, string> = {
  medication: "Do you take insulin or any medication for diabetes?",
  eating_disorder: "Have you ever been treated for, or do you currently struggle with, an eating disorder such as anorexia, bulimia or binge eating?",
  pregnancy: "Are you pregnant, trying to become pregnant, or breastfeeding?",
};
export function isScreeningQuestion(value: unknown): value is ScreeningQuestion {
  return typeof value === "string" && (SCREENING_QUESTIONS as readonly string[]).includes(value);
}
export function isScreeningAnswer(value: unknown): value is ScreeningAnswer {
  return value === "yes" || value === "no" || value === "skipped";
}

export const DIET_COMPLEXITIES = ["simple", "moderate", "advanced"] as const;
export type DietComplexity = (typeof DIET_COMPLEXITIES)[number];
export const EVIDENCE_STRENGTHS = ["strong", "moderate", "limited", "emerging"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];
export const SUPERVISION_LEVELS = ["none", "recommended", "required"] as const;
export type SupervisionLevel = (typeof SUPERVISION_LEVELS)[number];
export const REVIEW_STATUSES = ["draft", "reviewed", "published", "retired"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
