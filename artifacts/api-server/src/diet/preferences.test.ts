/**
 * Spoken allergy / sensitivity labels resolve to catalog keys before they are
 * saved, so the classifier's tag and ingredient rules apply to them. A label
 * the catalog does not know stays a custom item; dislikes always do.
 */
import { describe, expect, it } from "vitest";
import { classifyFood, inferFoodTags, resolvePreferenceKey } from "@workspace/diet-programs";
import { parsePreferenceItem } from "./service";

describe("resolvePreferenceKey", () => {
  it("maps the allergen, its plural, and the foods patients name for the group", () => {
    const cases: Array<[string, string]> = [
      ["tree nuts", "tree_nut"], ["Tree Nuts", "tree_nut"], ["nuts", "tree_nut"], ["almonds", "tree_nut"], ["cashews", "tree_nut"],
      ["peanuts", "peanut"], ["peanut butter", "peanut"], ["Peanut", "peanut"],
      ["shellfish", "shellfish"], ["shrimp", "shellfish"], ["prawns", "shellfish"], ["crab", "shellfish"],
      ["dairy", "milk"], ["milk", "milk"], ["cow's milk", "milk"],
      ["eggs", "egg"], ["soy", "soy"], ["soya", "soy"], ["wheat", "wheat"], ["gluten", "gluten"],
      ["fish", "fish"], ["sesame seeds", "sesame"], ["sulphites", "sulfites"], ["maize", "corn"], ["raw eggs", "egg"],
      ["tree_nut", "tree_nut"],
    ];
    for (const [label, key] of cases) expect(resolvePreferenceKey("allergy", label), label).toBe(key);
  });

  it("maps sensitivities the same way and leaves unknown foods custom", () => {
    expect(resolvePreferenceKey("sensitivity", "dairy")).toBe("lactose");
    expect(resolvePreferenceKey("sensitivity", "lactose")).toBe("lactose");
    expect(resolvePreferenceKey("sensitivity", "gluten")).toBe("gluten");
    expect(resolvePreferenceKey("sensitivity", "coffee")).toBe("caffeine");
    expect(resolvePreferenceKey("sensitivity", "spicy food")).toBe("spicy");
    expect(resolvePreferenceKey("sensitivity", "artificial sweeteners")).toBe("artificial_sweeteners");
    expect(resolvePreferenceKey("sensitivity", "onions")).toBeNull();
    expect(resolvePreferenceKey("allergy", "kiwi")).toBeNull();
    expect(resolvePreferenceKey("allergy", "")).toBeNull();
  });

  it("never resolves dislikes or restrictions", () => {
    expect(resolvePreferenceKey("dislike", "peanuts")).toBeNull();
    expect(resolvePreferenceKey("restriction", "shellfish")).toBeNull();
  });
});

describe("parsePreferenceItem resolves free-text labels", () => {
  it("stores a recognised allergy under its catalog key and canonical label", () => {
    expect(parsePreferenceItem({ list: "allergy", label: "tree nuts", severity: "severe" })).toEqual({
      ok: true, value: { list: "allergy", itemKey: "tree_nut", label: "Tree nuts", isCustom: false, severity: "severe" },
    });
    expect(parsePreferenceItem({ list: "allergy", label: "peanuts", severity: "mild" })).toEqual({
      ok: true, value: { list: "allergy", itemKey: "peanut", label: "Peanut", isCustom: false, severity: "mild" },
    });
    expect(parsePreferenceItem({ list: "sensitivity", label: "dairy" })).toEqual({
      ok: true, value: { list: "sensitivity", itemKey: "lactose", label: "Lactose", isCustom: false, severity: null },
    });
  });

  it("keeps unknown labels custom and never resolves dislikes", () => {
    expect(parsePreferenceItem({ list: "allergy", label: "kiwi", severity: "mild" })).toEqual({
      ok: true, value: { list: "allergy", itemKey: "custom:kiwi", label: "kiwi", isCustom: true, severity: "mild" },
    });
    expect(parsePreferenceItem({ list: "dislike", label: "peanuts" })).toEqual({
      ok: true, value: { list: "dislike", itemKey: "custom:peanuts", label: "peanuts", isCustom: true, severity: null },
    });
  });

  it("an explicit catalog key still wins and an unknown key is still rejected", () => {
    expect(parsePreferenceItem({ list: "allergy", key: "shellfish", severity: "mild" })).toMatchObject({ ok: true, value: { itemKey: "shellfish", label: "Shellfish" } });
    expect(parsePreferenceItem({ list: "allergy", key: "bogus", severity: "mild" })).toMatchObject({ ok: false, field: "key" });
  });

  it("the resolved item blocks member foods the literal label would have missed", () => {
    const parsed = parsePreferenceItem({ list: "allergy", label: "tree nuts", severity: "mild" });
    if (!parsed.ok) throw new Error(parsed.error);
    const prefs = [{ list: parsed.value.list, key: parsed.value.itemKey, label: parsed.value.label, custom: parsed.value.isCustom, severity: parsed.value.severity }];
    const food = { name: "almond-crusted salmon", tags: inferFoodTags("almond-crusted salmon") };
    const almond = classifyFood(food, { dietSlug: null, phase: "maintenance", preferences: prefs });
    expect(almond.verdict).toBe("does_not_fit");
    expect(almond.reasons.map((r) => r.code)).toContain("allergy:tree_nut");
    // The literal custom label never matches "almond", which is the gap the resolver closes.
    const literal = classifyFood(food, { dietSlug: null, phase: "maintenance", preferences: [{ list: "allergy", key: "tree_nuts", label: "tree nuts", custom: true, severity: "mild" }] });
    expect(literal.reasons.filter((r) => r.source === "allergy")).toEqual([]);
  });
});
