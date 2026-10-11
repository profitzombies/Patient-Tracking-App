/**
 * The reply-side diet guard: per list type (allergy incl. severe "may
 * contain", sensitivity, restriction incl. kosher / halal combination rules,
 * dislike) and per surface (menu picks, recipe drafts, plate and label fit
 * lines, quick-reply chips). Pure functions; no network.
 */
import { describe, expect, it } from "vitest";
import { checkFood, filterChipLabels, guardMenuPayload, labelFitLine, plateFitLine, recipeDietProblems } from "./diet-guard";
import { ALLERGY_SEVERITY_CHIPS, LIST_OFFER_CHIPS, allergySeverityQuestion, detectListFollowup, detectListMention, listOfferLine } from "./diet-followups";
import { parsePreferenceItem } from "../diet/service";
import { classifierContextOf as ctx, type DietGrounding, type DietListItem } from "./diet-grounding";
import type { MenuScanPayload } from "./menu-scan";
import type { LabelDraft } from "./label-photo";

function grounding(overrides: Partial<DietGrounding> = {}): DietGrounding {
  return {
    phase: "maintenance",
    diet: { slug: "mediterranean", name: "Mediterranean", summary: "", complexity: "easy", ruleSheet: [] },
    fitRules: {},
    lists: [],
    cautions: [],
    fastingWindow: null,
    whole30Day: null,
    disclaimer: "Talk to your care team.",
    pendingAck: null,
    ...overrides,
  };
}

const item = (list: DietListItem["list"], key: string, label: string, severity: DietListItem["severity"] = null): DietListItem => ({
  list, key, label, custom: key.startsWith("custom:"), severity,
});

const PEANUT_SEVERE = item("allergy", "peanut", "Peanuts", "severe");
const PEANUT_MILD = item("allergy", "peanut", "Peanuts", "mild");
const SHELLFISH_MILD = item("allergy", "shellfish", "Shellfish", "mild");
const LACTOSE = item("sensitivity", "lactose", "Lactose");
const KOSHER = item("restriction", "kosher", "Kosher");
const HALAL = item("restriction", "halal", "Halal");
const VEGETARIAN = item("restriction", "vegetarian", "Vegetarian");
const BROCCOLI = item("dislike", "custom:broccoli", "broccoli");

const menu = (order: MenuScanPayload["order"], avoid: MenuScanPayload["avoid"] = []): MenuScanPayload => ({
  result: "ok", message: "Good options here.", order, avoid,
});

describe("checkFood per list type", () => {
  it("flags a direct allergen, and 'may contain' only for a severe allergy", () => {
    const severe = grounding({ lists: [PEANUT_SEVERE] });
    const mild = grounding({ lists: [PEANUT_MILD] });
    expect(checkFood("pad thai with peanuts", ctx(severe)).hits.map((h) => h.code)).toContain("allergy:peanut");
    expect(checkFood("granola bar", ctx(severe), { mayContain: ["peanut"] }).hits.map((h) => h.code)).toEqual(["allergy:may_contain:peanut"]);
    expect(checkFood("granola bar", ctx(mild), { mayContain: ["peanut"] }).hits).toEqual([]);
  });

  it("flags sensitivities, restrictions and dislikes by their own source", () => {
    const g = grounding({ lists: [LACTOSE, VEGETARIAN, BROCCOLI] });
    expect(checkFood("glass of milk", ctx(g)).hits.map((h) => h.source)).toContain("sensitivity");
    expect(checkFood("grilled chicken breast", ctx(g)).hits.map((h) => h.source)).toContain("restriction");
    expect(checkFood("steamed broccoli", ctx(g)).hits.map((h) => h.source)).toEqual(["dislike"]);
    expect(checkFood("lentil soup", ctx(g)).hits).toEqual([]);
  });

  it("enforces kosher and halal exclusions and the kosher meat-with-dairy combination", () => {
    const kosher = grounding({ lists: [KOSHER] });
    expect(checkFood("shrimp cocktail", ctx(kosher)).hits.map((h) => h.code)).toContain("restriction:kosher:excluded:shellfish");
    expect(checkFood("cheeseburger", ctx(kosher)).hits.some((h) => h.code.includes(":combination:"))).toBe(true);
    expect(checkFood("chicken parmesan with mozzarella", ctx(kosher)).hits.some((h) => h.code.includes(":combination:"))).toBe(true);
    expect(checkFood("grilled salmon with lemon", ctx(kosher)).hits).toEqual([]);

    const halal = grounding({ lists: [HALAL] });
    expect(checkFood("bacon wrapped dates", ctx(halal)).hits.map((h) => h.code)).toContain("restriction:halal:excluded:pork");
    expect(checkFood("beef stew with red wine", ctx(halal)).hits.map((h) => h.code)).toContain("restriction:halal:excluded:alcohol");
  });

  it("leaves a food it cannot place at unknown rather than fits", () => {
    const g = grounding({ lists: [PEANUT_SEVERE] });
    const check = checkFood("zorbleweed casserole", ctx(g));
    expect(check.hits).toEqual([]);
    expect(check.result.verdict).toBe("unknown");
  });

  it("a free-from qualifier on one component never clears an allergen in another", () => {
    const milk = grounding({ lists: [item("allergy", "milk", "Milk", "severe")] });
    expect(checkFood("cheddar cheese with dairy-free bread", ctx(milk)).hits.map((h) => h.code)).toContain("allergy:milk");
    expect(checkFood("vegan brownie, scoop of ice cream", ctx(milk)).hits.map((h) => h.code)).toContain("allergy:milk");
    expect(checkFood("dairy-free bread", ctx(milk)).hits).toEqual([]);
    const kosher = grounding({ lists: [KOSHER] });
    expect(checkFood("steak with vegan cheese", ctx(kosher)).hits).toEqual([]);
    expect(checkFood("vegan salad with grilled shrimp", ctx(kosher)).hits.map((h) => h.code)).toContain("restriction:kosher:excluded:shellfish");
  });
});

describe("mixed-ingredient dishes across surfaces", () => {
  const MILK_SEVERE = item("allergy", "milk", "Milk", "severe");
  const GLUTEN = item("sensitivity", "gluten", "Gluten");

  it("menu: a pick that pairs an allergen with a free-from side still moves to avoid", () => {
    const out = guardMenuPayload(menu([
      { name: "Cheddar Omelette with dairy-free toast", howToOrder: "Light butter", note: undefined },
      { name: "Gluten-free pancakes with regular syrup", howToOrder: "", note: undefined },
      { name: "Fruit bowl", howToOrder: "", note: undefined },
    ]), grounding({ lists: [MILK_SEVERE, GLUTEN] }));
    expect(out.payload.order.map((d) => d.name)).toEqual(["Fruit bowl"]);
    expect(out.payload.avoid.find((d) => d.name.startsWith("Cheddar"))?.reason).toMatch(/milk|dairy/i);
    expect(out.payload.avoid.find((d) => d.name.startsWith("Gluten-free"))?.reason).toMatch(/milk|dairy/i);
  });

  it("plate: the fit line says no when any item carries the allergen", () => {
    const line = plateFitLine([{ name: "cheddar cheese with dairy-free bread" }], grounding({ lists: [MILK_SEVERE] }));
    expect(line.verdict).toBe("does_not_fit");
    expect(line.text).toMatch(/milk|dairy/i);
    expect(plateFitLine([{ name: "dairy-free bread" }, { name: "sliced apple" }], grounding({ lists: [MILK_SEVERE] })).verdict).toBe("fits");
  });

  it("chips: a label naming an allergen next to a free-from food is dropped", () => {
    const g = grounding({ lists: [MILK_SEVERE] });
    expect(filterChipLabels(["Cheddar on dairy-free toast", "Dairy-free toast", "Yes please"], g)).toEqual(["Dairy-free toast", "Yes please"]);
  });

  it("recipes: an ingredient line with a free-from qualifier and an allergen is still a problem", () => {
    const g = grounding({ lists: [MILK_SEVERE] });
    const problems = recipeDietProblems({ name: "Toastie", ingredients: [{ name: "dairy-free bread" }, { name: "cheddar cheese and dairy-free spread" }] }, g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/"cheddar cheese and dairy-free spread".*allergy/);
  });
});

describe("coach-confirmed allergies block member foods on every surface", () => {
  /** Runs the chat confirm-to-add flow and returns the item exactly as the write would store it. */
  function confirmedInChat(text: string, severity: "mild" | "severe"): DietListItem {
    const mention = detectListMention(text, []);
    if (!mention || mention.list !== "allergy") throw new Error(`no allergy mention in ${JSON.stringify(text)}`);
    const offer = { role: "assistant" as const, content: `Noted.\n\n${listOfferLine(mention)}` };
    const first = detectListFollowup([offer, { role: "user", content: LIST_OFFER_CHIPS[0]! }]);
    expect(first).toEqual({ kind: "ask_severity", label: mention.label });
    const question = { role: "assistant" as const, content: allergySeverityQuestion(mention.label) };
    const followup = detectListFollowup([question, { role: "user", content: severity === "mild" ? ALLERGY_SEVERITY_CHIPS[0]! : ALLERGY_SEVERITY_CHIPS[1]! }]);
    if (!followup || followup.kind !== "add") throw new Error("confirmation did not add");
    // Same parse writeConfirmedListItem performs before addPreferenceItem.
    const parsed = parsePreferenceItem({ list: followup.list, label: followup.label, severity: followup.severity ?? undefined });
    if (!parsed.ok) throw new Error(parsed.error);
    return { list: parsed.value.list, key: parsed.value.itemKey, label: parsed.value.label, custom: parsed.value.isCustom, severity: parsed.value.severity };
  }

  it("stores spoken allergies under catalog keys", () => {
    expect(confirmedInChat("I have a mild allergy to tree nuts, is that ok", "mild")).toEqual({ list: "allergy", key: "tree_nut", label: "Tree nuts", custom: false, severity: "mild" });
    expect(confirmedInChat("btw I'm allergic to peanuts", "severe")).toEqual({ list: "allergy", key: "peanut", label: "Peanut", custom: false, severity: "severe" });
    expect(confirmedInChat("I'm allergic to shrimp", "mild")).toEqual({ list: "allergy", key: "shellfish", label: "Shellfish", custom: false, severity: "mild" });
  });

  it("tree nuts confirmed in chat: almond dishes are rejected on menu, plate, chips and recipes", () => {
    const g = grounding({ lists: [confirmedInChat("I have a mild allergy to tree nuts, is that ok", "mild")] });
    expect(checkFood("almond-crusted salmon", ctx(g)).hits.map((h) => h.code)).toContain("allergy:tree_nut");
    const out = guardMenuPayload(menu([
      { name: "Almond-crusted salmon", howToOrder: "", note: undefined },
      { name: "Walnut salad", howToOrder: "", note: undefined },
      { name: "Grilled chicken", howToOrder: "", note: undefined },
    ]), g);
    expect(out.payload.order.map((d) => d.name)).toEqual(["Grilled chicken"]);
    expect(out.payload.avoid.map((d) => d.name).sort()).toEqual(["Almond-crusted salmon", "Walnut salad"]);
    expect(out.payload.avoid[0]?.reason).toMatch(/tree nut/i);
    expect(plateFitLine([{ name: "almond butter toast" }], g).verdict).toBe("does_not_fit");
    expect(filterChipLabels(["Almond butter on toast", "Greek yogurt", "Yes please"], g)).toEqual(["Greek yogurt", "Yes please"]);
    const problems = recipeDietProblems({ name: "Pesto pasta", ingredients: [{ name: "pine nuts" }, { name: "basil" }] }, g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/"pine nuts".*allergy/);
  });

  it("peanuts confirmed severe in chat: peanut butter and may-contain foods are rejected", () => {
    const g = grounding({ lists: [confirmedInChat("btw I'm allergic to peanuts", "severe")] });
    expect(checkFood("peanut butter sandwich", ctx(g)).hits.map((h) => h.code)).toContain("allergy:peanut");
    expect(checkFood("granola bar", ctx(g), { mayContain: ["peanut"] }).hits.map((h) => h.code)).toEqual(["allergy:may_contain:peanut"]);
    const out = guardMenuPayload(menu([{ name: "Peanut butter smoothie", howToOrder: "", note: undefined }, { name: "Berry smoothie", howToOrder: "", note: undefined }]), g);
    expect(out.payload.order.map((d) => d.name)).toEqual(["Berry smoothie"]);
    expect(plateFitLine([{ name: "peanut butter on apple slices" }], g).verdict).toBe("does_not_fit");
    expect(filterChipLabels(["Peanut butter toast", "Oatmeal"], g)).toEqual(["Oatmeal"]);
    expect(recipeDietProblems({ name: "Satay", ingredients: [{ name: "peanut butter" }] }, g)).toHaveLength(1);
  });

  it("a food the catalog does not know stays custom and still matches its own name", () => {
    const kiwi = confirmedInChat("I'm allergic to kiwi", "mild");
    expect(kiwi).toMatchObject({ key: "custom:kiwi", custom: true });
    const g = grounding({ lists: [kiwi] });
    expect(checkFood("kiwi fruit salad", ctx(g)).hits.map((h) => h.code)).toContain("allergy:kiwi");
  });

  it("does not re-offer a member food once the group is recorded", () => {
    const treeNuts = confirmedInChat("I'm allergic to tree nuts", "mild");
    expect(detectListMention("I'm allergic to almonds too", [treeNuts])).toBeNull();
    expect(detectListMention("I'm allergic to shrimp", [treeNuts])).toEqual({ list: "allergy", label: "shrimp" });
  });
});

describe("guardMenuPayload", () => {
  it("moves list hits to avoid with the reason, drops dislikes, keeps clean picks", () => {
    const g = grounding({ lists: [SHELLFISH_MILD, KOSHER, BROCCOLI] });
    const out = guardMenuPayload(menu([
      { name: "Grilled Salmon", howToOrder: "Ask for no butter", note: undefined },
      { name: "Shrimp Scampi", howToOrder: "Light on the oil", note: undefined },
      { name: "Broccoli Side", howToOrder: "Steamed", note: undefined },
      { name: "Chicken Alfredo", howToOrder: "Half portion", note: undefined },
    ], [{ name: "Fried Calamari", reason: "Deep fried." }]), g);
    expect(out.payload.order.map((d) => d.name)).toEqual(["Grilled Salmon"]);
    expect(out.payload.avoid.map((d) => d.name)).toEqual(["Fried Calamari", "Shrimp Scampi", "Chicken Alfredo"]);
    expect(out.payload.avoid[1]!.reason).toMatch(/shellfish/i);
    expect(out.payload.avoid[2]!.reason).toMatch(/dairy|milk/i);
    expect(out.moved.map((m) => m.name)).toEqual(["Shrimp Scampi", "Broccoli Side", "Chicken Alfredo"]);
  });

  it("checks the diet's own rules too, and leaves non-ok payloads alone", () => {
    const keto = grounding({ diet: { slug: "keto", name: "Keto", summary: "", complexity: "hard", ruleSheet: [] } });
    const out = guardMenuPayload(menu([{ name: "Garlic Bread", howToOrder: "Extra garlic", note: undefined }]), keto);
    expect(out.payload.order).toEqual([]);
    expect(out.payload.avoid[0]).toMatchObject({ name: "Garlic Bread" });

    const notMenu: MenuScanPayload = { result: "not_menu", message: "Not a menu.", order: [], avoid: [] };
    expect(guardMenuPayload(notMenu, keto)).toEqual({ payload: notMenu, moved: [] });
  });

  it("does not move a hit that only fails the Approved Foods match during the protocol", () => {
    const g = grounding({ phase: "protocol", diet: null, lists: [PEANUT_SEVERE] });
    const out = guardMenuPayload(menu([
      { name: "Grilled Chicken Salad", howToOrder: "Dressing on the side", note: undefined },
      { name: "Thai Peanut Noodles", howToOrder: "", note: undefined },
    ]), g);
    expect(out.payload.order.map((d) => d.name)).toEqual(["Grilled Chicken Salad"]);
    expect(out.moved).toEqual([{ name: "Thai Peanut Noodles", code: "allergy:peanut" }]);
  });
});

describe("recipeDietProblems", () => {
  const recipe = (name: string, ...ingredients: string[]) => ({ name, ingredients: ingredients.map((n) => ({ name: n })) });

  it("names each offending ingredient and the list it hits", () => {
    const g = grounding({ lists: [PEANUT_SEVERE, LACTOSE, BROCCOLI] });
    const problems = recipeDietProblems(recipe("Stir fry", "chicken breast", "peanuts", "broccoli", "whole milk"), g);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/"peanuts".*allergy/);
    expect(problems[1]).toMatch(/"broccoli".*dislike/);
    expect(problems[2]).toMatch(/"whole milk".*sensitivity/);
  });

  it("rejects a kosher dish that pairs meat with dairy across ingredients", () => {
    const g = grounding({ lists: [KOSHER] });
    const problems = recipeDietProblems(recipe("Chicken bake", "chicken thighs", "cheddar cheese", "spinach"), g);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/dish as a whole.*(poultry|meat) with (dairy|milk)/);
    expect(recipeDietProblems(recipe("Chicken bake", "chicken thighs", "olive oil", "spinach"), g)).toEqual([]);
  });

  it("applies the diet's exclusions in maintenance only; protocol drafts enforce just the lists", () => {
    const vegan = grounding({ diet: { slug: "vegan_plant_based", name: "Plant-based", summary: "", complexity: "moderate", ruleSheet: [] }, fitRules: { vegan_plant_based: { mode: "exclude", excludeTags: ["meat", "poultry", "fish", "egg", "dairy"] } } });
    expect(recipeDietProblems(recipe("Omelette", "eggs", "spinach"), vegan)).toHaveLength(1);
    const protocol = grounding({ ...vegan, phase: "protocol" });
    expect(recipeDietProblems(recipe("Omelette", "eggs", "spinach"), protocol)).toEqual([]);
  });
});

describe("plateFitLine", () => {
  it("says no with the reason for a list hit (still logged)", () => {
    const line = plateFitLine([{ name: "shrimp tacos" }, { name: "side salad" }], grounding({ lists: [SHELLFISH_MILD] }));
    expect(line.verdict).toBe("does_not_fit");
    expect(line.text).toMatch(/^Fits your diet: no\. shrimp tacos: .*shellfish/i);
    expect(line.text).toMatch(/still logged/);
  });

  it("says yes when every item resolves clean, naming what it was checked against", () => {
    const line = plateFitLine([{ name: "grilled salmon" }, { name: "steamed spinach" }], grounding({ lists: [PEANUT_SEVERE] }));
    expect(line.verdict).toBe("fits");
    expect(line.text).toBe("Fits your diet: yes. Nothing on this plate hits Mediterranean and your food lists.");
  });

  it("says can't tell when an item cannot be placed", () => {
    const line = plateFitLine([{ name: "mystery casserole" }], grounding());
    expect(line.verdict).toBe("unknown");
    expect(line.text).toMatch(/can't tell for sure\. I couldn't match mystery casserole against Mediterranean and your food lists/);
  });

  it("during the protocol, an item verified on the Approved Foods list fits and an off-list one does not", () => {
    const g = grounding({ phase: "protocol", diet: null });
    expect(plateFitLine([{ name: "chicken breast", thinnrApproved: true }], g).verdict).toBe("fits");
    const off = plateFitLine([{ name: "garlic bread", thinnrApproved: false }], g);
    expect(off.verdict).toBe("does_not_fit");
    expect(off.text).toMatch(/Approved Foods/);
  });
});

describe("labelFitLine", () => {
  const draft: LabelDraft = { id: "label-1", servingSize: "2/3 cup (55g)", servingsPerContainer: 8, calories: 230, protein: 8, carbs: 37, fat: 8, fiber: 4, sugar: 12, sodium: 160, suggestedSlot: "snacks" };

  it("never says yes: the numbers can pass but the ingredient list is unseen", () => {
    const line = labelFitLine(draft, grounding({ lists: [PEANUT_SEVERE, LACTOSE, BROCCOLI] }));
    expect(line.verdict).toBe("unknown");
    expect(line.text).toMatch(/can't tell from the numbers alone/);
    expect(line.text).toMatch(/check the ingredient list for Peanuts, Lactose\./);
    expect(line.text).not.toMatch(/broccoli/);
  });

  it("says no when the printed numbers break the diet's own rule", () => {
    const keto = grounding({ diet: { slug: "keto", name: "Keto", summary: "", complexity: "hard", ruleSheet: [] } });
    const line = labelFitLine(draft, keto);
    expect(line.verdict).toBe("does_not_fit");
    expect(line.text).toMatch(/37 g of carbohydrate per serving is above the 10 g Keto allows/);
  });

  it("adds the Approved Foods reminder during the protocol", () => {
    expect(labelFitLine(draft, grounding({ phase: "protocol", diet: null })).text).toMatch(/Approved Foods list\.$/);
  });
});

describe("filterChipLabels", () => {
  it("drops chips that name a food the patient must not be offered, keeps the rest", () => {
    const g = grounding({ lists: [SHELLFISH_MILD, BROCCOLI] });
    expect(filterChipLabels(["Try the shrimp bowl", "Add broccoli", "Grilled chicken", "Yes please", "Something lighter"], g))
      .toEqual(["Grilled chicken", "Yes please", "Something lighter"]);
  });

  it("ignores protocol-only misses so ordinary chips survive the protocol phase", () => {
    const g = grounding({ phase: "protocol", diet: null, lists: [PEANUT_SEVERE] });
    expect(filterChipLabels(["Grilled chicken", "Peanut sauce"], g)).toEqual(["Grilled chicken"]);
  });
});
