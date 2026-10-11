/**
 * "Does this food fit?" — one pure classifier shared by the API and the app.
 *
 * Verdict order: a recorded allergy, restriction, sensitivity, the diet's own
 * rules, then dislikes. Every hit is collected as a reason; the verdict is
 * `does_not_fit` when any rule fires, `unknown` when a rule would need
 * information the food does not carry, otherwise `fits`.
 *
 * Severe allergies treat "may contain" lines as a hit; mild allergies and
 * every other list count direct ingredients (tags, allergen line, ingredient
 * names — a known allergen named in the ingredient list counts even when the
 * food carries no tags or allergen line) only. The THINNR protocol is not a diet entry: while a patient is in
 * the protocol phase the Approved Foods list is the fit source.
 */
import { DIET_BY_SLUG, type DietCatalogEntry, type DietFitRules } from "./catalog";
import {
  ALLERGEN_IMPLIED_BY_TAGS,
  ALLERGEN_INGREDIENT_TERMS,
  ALLERGEN_LABELS,
  RESTRICTION_BY_KEY,
  SENSITIVITY_BY_KEY,
  isFoodTag,
  type AllergenKey,
  type AllergySeverity,
  type FoodTag,
  type PreferenceList,
} from "./vocabulary";

export interface FoodDescription {
  name: string;
  /** Closed-vocabulary tags; unknown strings are ignored. */
  tags?: readonly string[];
  /** Allergen keys the food directly contains. */
  allergens?: readonly string[];
  /** Allergen keys from a "may contain" / shared-facility line. */
  mayContain?: readonly string[];
  /** Free-text ingredient names, lower-cased by the classifier. */
  ingredients?: readonly string[];
  /** Grams of carbohydrate per serving, when known. */
  carbsPerServing?: number;
  /** Calories per serving and serving weight, for energy density. */
  caloriesPerServing?: number;
  servingGrams?: number;
  /** True when the food is on the THINNR Approved Foods list; false when it is known not to be. */
  thinnrApproved?: boolean;
}

export interface PreferenceItemInput {
  list: PreferenceList;
  /** Catalog key (restriction / sensitivity / allergen key) or a slug for custom items. */
  key: string;
  label: string;
  custom?: boolean;
  severity?: AllergySeverity | null;
}

export interface ClassifierContext {
  /** Published diet slug, "just_tracking", or null for no diet. */
  dietSlug: string | null;
  /** When "protocol", the Approved Foods list decides and the diet is ignored. */
  phase?: "protocol" | "maintenance" | null;
  preferences?: readonly PreferenceItemInput[];
  /** Overrides the catalog rules for a slug (HQ-edited rules from the database). */
  fitRulesBySlug?: Readonly<Record<string, DietFitRules>>;
}

export type FitVerdict = "fits" | "does_not_fit" | "unknown";
export type FitReasonSource = "allergy" | "restriction" | "sensitivity" | "diet" | "dislike" | "protocol";
export interface FitReason {
  source: FitReasonSource;
  /** Stable machine code, e.g. allergy:peanut, diet:excluded:gluten, diet:limit:red_meat. */
  code: string;
  /** Plain-language explanation, free of patient data. */
  message: string;
  /** Hits keep the verdict at does_not_fit; notes leave it at fits. */
  kind: "hit" | "note" | "unknown";
}
export interface FitResult {
  verdict: FitVerdict;
  reasons: FitReason[];
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function foodTags(food: FoodDescription): Set<FoodTag> {
  const out = new Set<FoodTag>();
  for (const tag of food.tags ?? []) if (isFoodTag(tag)) out.add(tag);
  if (food.thinnrApproved) out.add("thinnr_approved");
  return out;
}

function foodText(food: FoodDescription): string {
  return [food.name, ...(food.ingredients ?? [])].map(normalize).join(" | ");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  if (!needle) return false;
  return haystack.split(" | ").some((part) => part === needle || part.includes(` ${needle} `) || part.startsWith(`${needle} `) || part.endsWith(` ${needle}`) || part === needle);
}

function hasInformation(food: FoodDescription, tags: Set<FoodTag>): boolean {
  return tags.size > 0 || (food.allergens?.length ?? 0) > 0 || (food.ingredients?.length ?? 0) > 0;
}

/** Ingredient names only (never the food's own name): a dish called "peanut-free brownie" is not an ingredient hit. */
function ingredientText(food: FoodDescription): string {
  return (food.ingredients ?? []).map(normalize).filter(Boolean).join(" | ");
}

function directAllergens(food: FoodDescription, tags: Set<FoodTag>): Set<string> {
  const out = new Set<string>((food.allergens ?? []).map(normalize).map((a) => a.replace(/ /g, "_")));
  for (const [key, implied] of Object.entries(ALLERGEN_IMPLIED_BY_TAGS) as Array<[AllergenKey, readonly FoodTag[]]>) {
    if (implied.some((tag) => tags.has(tag))) out.add(key);
  }
  // Metadata-poor foods: a free-text ingredient list still names the allergen.
  const ingredients = ingredientText(food);
  if (ingredients) {
    for (const [key, terms] of Object.entries(ALLERGEN_INGREDIENT_TERMS) as Array<[AllergenKey, readonly string[]]>) {
      if (!out.has(key) && terms.some((term) => containsPhrase(ingredients, term))) out.add(key);
    }
  }
  return out;
}

function allergyReasons(food: FoodDescription, tags: Set<FoodTag>, items: readonly PreferenceItemInput[]): FitReason[] {
  const reasons: FitReason[] = [];
  const direct = directAllergens(food, tags);
  const mayContain = new Set((food.mayContain ?? []).map(normalize).map((a) => a.replace(/ /g, "_")));
  const text = foodText(food);
  for (const item of items) {
    const severe = item.severity === "severe";
    const label = (ALLERGEN_LABELS as Record<string, string>)[item.key] ?? item.label;
    const hitDirect = direct.has(item.key) || (item.custom && containsPhrase(text, item.label));
    if (hitDirect) {
      reasons.push({ source: "allergy", code: `allergy:${item.key}`, kind: "hit", message: `Contains ${label.toLowerCase()}, a recorded ${severe ? "severe " : ""}allergy.` });
      continue;
    }
    if (severe && (mayContain.has(item.key) || (item.custom && (food.mayContain ?? []).some((m) => containsPhrase(normalize(m), item.label))))) {
      reasons.push({ source: "allergy", code: `allergy:may_contain:${item.key}`, kind: "hit", message: `May contain ${label.toLowerCase()}; counted as a hit for a severe allergy.` });
    }
  }
  return reasons;
}

function tagRuleReasons(source: FitReasonSource, keyPrefix: string, label: string, excludeTags: readonly FoodTag[], tags: Set<FoodTag>, combinations?: ReadonlyArray<readonly FoodTag[]>): FitReason[] {
  const reasons: FitReason[] = [];
  for (const tag of excludeTags) {
    if (tags.has(tag)) reasons.push({ source, code: `${keyPrefix}:excluded:${tag}`, kind: "hit", message: `${label} excludes ${tag.replace(/_/g, " ")}.` });
  }
  for (const combination of combinations ?? []) {
    if (combination.every((tag) => tags.has(tag))) {
      reasons.push({ source, code: `${keyPrefix}:combination:${combination.join("+")}`, kind: "hit", message: `${label} does not allow ${combination.map((t) => t.replace(/_/g, " ")).join(" with ")} in one dish.` });
    }
  }
  return reasons;
}

function restrictionReasons(food: FoodDescription, tags: Set<FoodTag>, items: readonly PreferenceItemInput[]): FitReason[] {
  const text = foodText(food);
  return items.flatMap((item) => {
    const def = RESTRICTION_BY_KEY.get(item.key);
    if (!def) {
      return item.custom && containsPhrase(text, item.label)
        ? [{ source: "restriction" as const, code: `restriction:custom:${item.key}`, kind: "hit" as const, message: `Contains ${item.label.toLowerCase()}, which you avoid.` }]
        : [];
    }
    return tagRuleReasons("restriction", `restriction:${def.key}`, def.label, def.excludeTags, tags, def.forbiddenCombinations);
  });
}

function sensitivityReasons(food: FoodDescription, tags: Set<FoodTag>, items: readonly PreferenceItemInput[]): FitReason[] {
  const text = foodText(food);
  return items.flatMap((item) => {
    const def = SENSITIVITY_BY_KEY.get(item.key);
    if (!def || def.excludeTags.length === 0) {
      return containsPhrase(text, item.label)
        ? [{ source: "sensitivity" as const, code: `sensitivity:custom:${item.key}`, kind: "hit" as const, message: `Contains ${item.label.toLowerCase()}, a recorded sensitivity.` }]
        : [];
    }
    return tagRuleReasons("sensitivity", `sensitivity:${def.key}`, `${def.label} sensitivity`, def.excludeTags, tags);
  });
}

function dislikeReasons(food: FoodDescription, tags: Set<FoodTag>, items: readonly PreferenceItemInput[]): FitReason[] {
  const text = foodText(food);
  return items.flatMap((item) => {
    const byTag = isFoodTag(item.key) && tags.has(item.key);
    return byTag || containsPhrase(text, item.label)
      ? [{ source: "dislike" as const, code: `dislike:${item.key}`, kind: "hit" as const, message: `Contains ${item.label.toLowerCase()}, which you dislike.` }]
      : [];
  });
}

function numericRuleReasons(entry: Pick<DietCatalogEntry, "name">, rules: DietFitRules, food: FoodDescription): FitReason[] {
  const reasons: FitReason[] = [];
  if (typeof rules.maxCarbsPerServing === "number" && typeof food.carbsPerServing === "number" && food.carbsPerServing > rules.maxCarbsPerServing) {
    reasons.push({ source: "diet", code: "diet:carbs_over_limit", kind: "hit", message: `${Math.round(food.carbsPerServing)} g of carbohydrate per serving is above the ${rules.maxCarbsPerServing} g ${entry.name} allows.` });
  }
  if (typeof rules.maxEnergyDensity === "number" && typeof food.caloriesPerServing === "number" && typeof food.servingGrams === "number" && food.servingGrams > 0) {
    const density = food.caloriesPerServing / food.servingGrams;
    if (density > rules.maxEnergyDensity) {
      reasons.push({ source: "diet", code: "diet:energy_dense", kind: "hit", message: `${density.toFixed(1)} calories per gram is denser than ${entry.name} recommends.` });
    }
  }
  return reasons;
}

export function dietRuleReasons(entry: Pick<DietCatalogEntry, "name" | "slug">, rules: DietFitRules, food: FoodDescription, tags: Set<FoodTag>): FitReason[] {
  const reasons: FitReason[] = [];
  const informed = hasInformation(food, tags);
  const hasRules = (rules.excludeTags?.length ?? 0) > 0 || rules.mode === "include" || (rules.forbiddenCombinations?.length ?? 0) > 0;
  // Printed numbers (a Nutrition Facts panel) can break a numeric rule on
  // their own, even when nothing is known about what the food is made of.
  const numeric = numericRuleReasons(entry, rules, food);
  if (!informed && hasRules) {
    if (numeric.length > 0) return numeric;
    reasons.push({ source: "diet", code: "diet:unknown_food", kind: "unknown", message: `Not enough is known about this food to check it against ${entry.name}.` });
    return reasons;
  }
  reasons.push(...tagRuleReasons("diet", "diet", entry.name, rules.excludeTags ?? [], tags, rules.forbiddenCombinations));
  if (rules.mode === "include" && tags.size > 0 && !(rules.includeTags ?? []).some((tag) => tags.has(tag))) {
    reasons.push({ source: "diet", code: "diet:not_included", kind: "hit", message: `${entry.name} only includes ${(rules.includeTags ?? []).slice(0, 4).map((t) => t.replace(/_/g, " ")).join(", ")} and similar foods.` });
  } else if (rules.mode === "include" && tags.size === 0) {
    reasons.push({ source: "diet", code: "diet:unknown_food", kind: "unknown", message: `Not enough is known about this food to check it against ${entry.name}.` });
  }
  reasons.push(...numeric);
  for (const tag of rules.limitTags ?? []) {
    if (tags.has(tag)) reasons.push({ source: "diet", code: `diet:limit:${tag}`, kind: "note", message: `${entry.name} asks you to limit ${tag.replace(/_/g, " ")}.` });
  }
  return reasons;
}

function protocolReasons(food: FoodDescription, tags: Set<FoodTag>): FitReason[] {
  if (food.thinnrApproved === true || tags.has("thinnr_approved")) return [];
  if (food.thinnrApproved === false) {
    return [{ source: "protocol", code: "protocol:not_approved", kind: "hit", message: "Not on the THINNR Approved Foods list for the protocol." }];
  }
  return [{ source: "protocol", code: "protocol:unknown_food", kind: "unknown", message: "Couldn't match this food to the THINNR Approved Foods list." }];
}

function verdictOf(reasons: FitReason[]): FitVerdict {
  if (reasons.some((reason) => reason.kind === "hit")) return "does_not_fit";
  if (reasons.some((reason) => reason.kind === "unknown")) return "unknown";
  return "fits";
}

/** Classify one food against the patient's diet, phase and four lists. */
export function classifyFood(food: FoodDescription, context: ClassifierContext): FitResult {
  const tags = foodTags(food);
  const preferences = context.preferences ?? [];
  const byList = (list: PreferenceList) => preferences.filter((item) => item.list === list);
  const reasons: FitReason[] = [
    ...allergyReasons(food, tags, byList("allergy")),
    ...restrictionReasons(food, tags, byList("restriction")),
    ...sensitivityReasons(food, tags, byList("sensitivity")),
  ];
  if (context.phase === "protocol") {
    reasons.push(...protocolReasons(food, tags));
  } else if (context.dietSlug) {
    const entry = DIET_BY_SLUG.get(context.dietSlug);
    const rules = context.fitRulesBySlug?.[context.dietSlug] ?? entry?.fitRules;
    if (entry && rules) reasons.push(...dietRuleReasons(entry, rules, food, tags));
    else if (rules) reasons.push(...dietRuleReasons({ name: context.dietSlug, slug: context.dietSlug }, rules, food, tags));
  }
  reasons.push(...dislikeReasons(food, tags, byList("dislike")));
  return { verdict: verdictOf(reasons), reasons };
}

/** Parse a stored fit_rules jsonb into the typed shape, dropping unknown tags. */
export function parseFitRules(value: unknown): DietFitRules | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const tags = (list: unknown): FoodTag[] => (Array.isArray(list) ? list.filter(isFoodTag) : []);
  const mode = raw.mode === "include" ? "include" : "exclude";
  const rules: DietFitRules = { mode, excludeTags: tags(raw.excludeTags), limitTags: tags(raw.limitTags) };
  if (mode === "include") rules.includeTags = tags(raw.includeTags);
  if (typeof raw.maxCarbsPerServing === "number" && Number.isFinite(raw.maxCarbsPerServing)) rules.maxCarbsPerServing = raw.maxCarbsPerServing;
  if (typeof raw.maxEnergyDensity === "number" && Number.isFinite(raw.maxEnergyDensity)) rules.maxEnergyDensity = raw.maxEnergyDensity;
  if (Array.isArray(raw.forbiddenCombinations)) {
    rules.forbiddenCombinations = raw.forbiddenCombinations.map(tags).filter((combo) => combo.length > 1);
  }
  return rules;
}
