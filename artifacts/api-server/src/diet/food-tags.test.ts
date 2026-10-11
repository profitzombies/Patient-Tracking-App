/**
 * The free-text food tagger behind the coach's diet guard. It must be
 * conservative: a food it cannot place returns no tags (the classifier reads
 * that as "unknown", never "fits"), and misleading compounds ("almond milk",
 * "peanut butter", "turkey bacon") resolve to what they actually are.
 */
import { describe, expect, it } from "vitest";
import { classifyFood, inferFoodTags } from "@workspace/diet-programs";

const has = (name: string, ...tags: string[]) => {
  const got = new Set(inferFoodTags(name));
  for (const tag of tags) expect(got.has(tag as never), `${name} → ${tag} (got ${[...got].join(",")})`).toBe(true);
};
const lacks = (name: string, ...tags: string[]) => {
  const got = new Set(inferFoodTags(name));
  for (const tag of tags) expect(got.has(tag as never), `${name} ↛ ${tag} (got ${[...got].join(",")})`).toBe(false);
};

describe("inferFoodTags", () => {
  it("maps everyday foods to the allergen, animal and diet tags the lists key on", () => {
    has("grilled shrimp skewers", "shellfish");
    has("roast chicken thighs", "poultry", "meat");
    has("sharp cheddar cheese", "dairy", "aged_cheese");
    has("fettuccine alfredo", "dairy");
    has("crispy bacon", "pork", "processed_meat");
    has("steamed broccoli", "vegetable");
    has("thai peanut sauce", "peanut", "legume");
    has("sourdough toast", "wheat", "gluten");
    has("scrambled eggs", "egg");
    has("glass of red wine", "alcohol");
  });

  it("resolves misleading compounds to what the food actually is", () => {
    lacks("oatmeal with almond milk", "dairy", "milk");
    has("oatmeal with almond milk", "tree_nut");
    lacks("peanut butter on toast", "dairy", "butter");
    has("peanut butter on toast", "peanut");
    lacks("turkey bacon", "pork");
    has("turkey bacon", "poultry", "processed_meat");
    lacks("cauliflower rice bowl", "grain");
    lacks("coconut cream curry", "dairy");
  });

  it("honours free-from qualifiers", () => {
    lacks("gluten free bread", "gluten", "wheat");
    lacks("dairy free ice cream", "dairy", "lactose");
    lacks("decaf coffee", "caffeine");
    lacks("non alcoholic beer", "alcohol");
  });

  it("scopes a free-from qualifier to the component it describes, never the whole dish", () => {
    has("cheddar cheese with dairy-free bread", "dairy", "aged_cheese");
    lacks("gluten-free bread with cheddar cheese", "gluten", "wheat");
    has("gluten-free bread with cheddar cheese", "dairy");
    has("breaded chicken on gluten-free pasta", "gluten", "wheat");
    lacks("grilled chicken on gluten-free pasta", "gluten", "wheat");
    has("vegan brownie, scoop of ice cream", "dairy");
    has("steak and vegan cheese", "meat", "red_meat");
    has("salad topped with feta (gluten free dressing)", "dairy");
    expect(inferFoodTags("Pad Thai", ["gluten-free rice noodles", "crushed peanuts"])).toContain("peanut");
    expect(inferFoodTags("dairy free lasagna", ["cheese"])).toContain("dairy");
    lacks("vegan lasagna with cashew cream", "dairy", "meat");
    lacks("decaf latte with oat milk", "caffeine");
  });

  it("returns nothing for foods it cannot place, and the classifier reads that as unknown", () => {
    expect(inferFoodTags("zorbleweed casserole")).toEqual([]);
    expect(inferFoodTags("")).toEqual([]);
    const result = classifyFood({ name: "zorbleweed casserole", tags: [] }, { dietSlug: "mediterranean", phase: "maintenance", preferences: [{ list: "allergy", key: "peanut", label: "Peanuts", severity: "severe" }] });
    expect(result.verdict).toBe("unknown");
  });

  it("reads ingredient lines alongside the name", () => {
    expect(inferFoodTags("House Salad", ["topped with crumbled blue cheese and walnuts"])).toEqual(expect.arrayContaining(["dairy", "tree_nut"]));
  });
});

describe("classifyFood numeric rules without ingredient knowledge", () => {
  it("lets a Nutrition Facts panel fail a carb cap even when the food itself is unknown", () => {
    const over = classifyFood({ name: "packaged food", carbsPerServing: 37 }, { dietSlug: "keto", phase: "maintenance" });
    expect(over.verdict).toBe("does_not_fit");
    expect(over.reasons.map((r) => r.code)).toEqual(["diet:carbs_over_limit"]);
    const under = classifyFood({ name: "packaged food", carbsPerServing: 4 }, { dietSlug: "keto", phase: "maintenance" });
    expect(under.verdict).toBe("unknown");
  });
});
