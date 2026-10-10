/**
 * Classifier parity fixture.
 *
 * The API and the mobile app each run this fixture through their own import
 * of the classifier and compare verdicts case by case. The expected values
 * are the contract; change them deliberately, in the same commit as a rule
 * change, never to make a run pass.
 */
import type { ClassifierContext, FitVerdict, FoodDescription } from "../classifier";

export interface ParityCase {
  id: string;
  food: FoodDescription;
  context: ClassifierContext;
  expected: FitVerdict;
  /** Reason codes that must be present (subset). */
  expectReasons?: string[];
}

export const PARITY_CASES: readonly ParityCase[] = [
  {
    id: "mediterranean-salmon-fits",
    food: { name: "Grilled salmon", tags: ["fish", "oily_fish"] },
    context: { dietSlug: "mediterranean", phase: "maintenance" },
    expected: "fits",
  },
  {
    id: "mediterranean-processed-meat",
    food: { name: "Salami", tags: ["processed_meat", "red_meat", "high_sodium"] },
    context: { dietSlug: "mediterranean", phase: "maintenance" },
    expected: "does_not_fit",
    expectReasons: ["diet:excluded:processed_meat"],
  },
  {
    id: "mediterranean-red-meat-limit-note",
    food: { name: "Sirloin steak", tags: ["meat", "red_meat"] },
    context: { dietSlug: "mediterranean", phase: "maintenance" },
    expected: "fits",
    expectReasons: ["diet:limit:red_meat"],
  },
  {
    id: "keto-banana-carbs",
    food: { name: "Banana", tags: ["fruit", "high_sugar_fruit"], carbsPerServing: 27 },
    context: { dietSlug: "keto", phase: "maintenance" },
    expected: "does_not_fit",
  },
  {
    id: "keto-no-info-unknown",
    food: { name: "House special" },
    context: { dietSlug: "keto", phase: "maintenance" },
    expected: "unknown",
  },
  {
    id: "carnivore-include-mode",
    food: { name: "Broccoli", tags: ["vegetable"] },
    context: { dietSlug: "carnivore", phase: "maintenance" },
    expected: "does_not_fit",
  },
  {
    id: "carnivore-ribeye",
    food: { name: "Ribeye", tags: ["meat", "red_meat"] },
    context: { dietSlug: "carnivore", phase: "maintenance" },
    expected: "fits",
  },
  {
    id: "severe-peanut-may-contain",
    food: { name: "Granola bar", tags: ["whole_grain", "added_sugar"], mayContain: ["peanut"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "peanut", label: "Peanut", severity: "severe" }] },
    expected: "does_not_fit",
    expectReasons: ["allergy:may_contain:peanut"],
  },
  {
    id: "mild-peanut-may-contain-fits",
    food: { name: "Granola bar", tags: ["whole_grain", "added_sugar"], mayContain: ["peanut"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "peanut", label: "Peanut", severity: "mild" }] },
    expected: "fits",
  },
  {
    id: "mild-peanut-direct-hit",
    food: { name: "Peanut butter toast", tags: ["peanut", "wheat", "gluten"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "peanut", label: "Peanut", severity: "mild" }] },
    expected: "does_not_fit",
    expectReasons: ["allergy:peanut"],
  },
  {
    id: "milk-allergy-implied-by-cheese-tag",
    food: { name: "Cheddar", tags: ["dairy", "aged_cheese"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "milk", label: "Milk", severity: "mild" }] },
    expected: "does_not_fit",
  },
  {
    id: "tree-nut-allergy-named-in-ingredients-only",
    // Metadata-poor food: no tags, no allergen line — only a free-text ingredient list.
    food: { name: "Energy bites", ingredients: ["dates", "rolled oats", "almonds", "cocoa"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "tree_nut", label: "Tree nuts", severity: "mild" }] },
    expected: "does_not_fit",
    expectReasons: ["allergy:tree_nut"],
  },
  {
    id: "milk-allergy-ingredient-whole-word-only",
    // "milk powder" names milk as a whole word inside a longer ingredient name.
    food: { name: "Chocolate bar", ingredients: ["sugar", "cocoa butter", "milk powder", "vanilla"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "milk", label: "Milk", severity: "severe" }] },
    expected: "does_not_fit",
    expectReasons: ["allergy:milk"],
  },
  {
    id: "allergy-ingredients-without-the-allergen-fits",
    food: { name: "Fruit cup", ingredients: ["strawberries", "blueberries", "mint"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "allergy", key: "peanut", label: "Peanut", severity: "severe" }, { list: "allergy", key: "shellfish", label: "Shellfish", severity: "mild" }] },
    expected: "fits",
  },
  {
    id: "kosher-cheeseburger-combination",
    food: { name: "Cheeseburger", tags: ["meat", "red_meat", "dairy", "aged_cheese", "wheat", "gluten"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "restriction", key: "kosher", label: "Kosher" }] },
    expected: "does_not_fit",
    expectReasons: ["restriction:kosher:combination:meat+dairy"],
  },
  {
    id: "kosher-plain-burger-fits",
    food: { name: "Hamburger patty", tags: ["meat", "red_meat"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "restriction", key: "kosher", label: "Kosher" }] },
    expected: "fits",
  },
  {
    id: "halal-wine-sauce",
    food: { name: "Chicken in white wine sauce", tags: ["poultry", "alcohol"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "restriction", key: "halal", label: "Halal" }] },
    expected: "does_not_fit",
    expectReasons: ["restriction:halal:excluded:alcohol"],
  },
  {
    id: "gluten-free-restriction",
    food: { name: "Sourdough bread", tags: ["grain", "wheat", "gluten", "refined_grain"] },
    context: { dietSlug: "mediterranean", phase: "maintenance", preferences: [{ list: "restriction", key: "gluten_free", label: "Gluten-free" }] },
    expected: "does_not_fit",
    expectReasons: ["restriction:gluten_free:excluded:gluten"],
  },
  {
    id: "lactose-sensitivity",
    food: { name: "Latte", tags: ["milk", "dairy", "lactose", "coffee", "caffeine"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "sensitivity", key: "lactose", label: "Lactose" }] },
    expected: "does_not_fit",
  },
  {
    id: "custom-dislike-by-name",
    food: { name: "Cream of mushroom soup", tags: ["vegetable", "dairy"], ingredients: ["mushroom", "cream", "onion"] },
    context: { dietSlug: "just_tracking", phase: "maintenance", preferences: [{ list: "dislike", key: "custom:mushrooms", label: "Mushroom", custom: true }] },
    expected: "does_not_fit",
    expectReasons: ["dislike:custom:mushrooms"],
  },
  {
    id: "protocol-approved-food",
    food: { name: "Chicken breast", tags: ["poultry"], thinnrApproved: true },
    context: { dietSlug: "keto", phase: "protocol" },
    expected: "fits",
  },
  {
    id: "protocol-not-approved",
    food: { name: "Bagel", tags: ["grain", "wheat", "gluten", "refined_grain"], thinnrApproved: false },
    context: { dietSlug: null, phase: "protocol" },
    expected: "does_not_fit",
    expectReasons: ["protocol:not_approved"],
  },
  {
    id: "protocol-unmatched-unknown",
    food: { name: "Mystery casserole" },
    context: { dietSlug: null, phase: "protocol" },
    expected: "unknown",
  },
  {
    id: "low-fodmap-onion",
    food: { name: "French onion soup", tags: ["vegetable", "high_fodmap", "dairy"] },
    context: { dietSlug: "low_fodmap", phase: "maintenance" },
    expected: "does_not_fit",
  },
  {
    id: "whole30-honey",
    food: { name: "Honey roasted carrots", tags: ["vegetable", "honey", "added_sugar"] },
    context: { dietSlug: "whole30", phase: "maintenance" },
    expected: "does_not_fit",
  },
  {
    id: "volumetrics-energy-density",
    food: { name: "Potato chips", tags: ["starchy_vegetable", "fried", "high_sodium", "ultra_processed"], caloriesPerServing: 160, servingGrams: 28 },
    context: { dietSlug: "volumetrics", phase: "maintenance" },
    expected: "does_not_fit",
  },
  {
    id: "db-rules-override-catalog",
    food: { name: "Dark chocolate", tags: ["chocolate", "added_sugar"] },
    context: { dietSlug: "mediterranean", phase: "maintenance", fitRulesBySlug: { mediterranean: { mode: "exclude", excludeTags: ["chocolate"] } } },
    expected: "does_not_fit",
    expectReasons: ["diet:excluded:chocolate"],
  },
  {
    id: "no-diet-no-lists-fits",
    food: { name: "Apple", tags: ["fruit"] },
    context: { dietSlug: null, phase: "maintenance" },
    expected: "fits",
  },
];
