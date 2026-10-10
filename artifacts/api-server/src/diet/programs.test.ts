/**
 * Pure diet-program rules: catalog contract, phase derivation, the goal + BMR
 * calculator, the food-fit classifier (through the shared parity fixture),
 * and the safety screening rules. These are the owner's decisions written as
 * assertions, so a rule change has to change a test on purpose.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FACTORS,
  DIET_BY_SLUG,
  DIET_CATALOG,
  FERTILITY_PREGNANCY_SLUG,
  GLP1_COMPANION_SLUG,
  JUST_TRACKING_SLUG,
  LOADING_DAY_CALORIES,
  MAINTENANCE_STEP_CALORIES,
  MAINTENANCE_STEP_DAYS,
  PROTOCOL_LENGTH_DAYS,
  SELECTABLE_DIET_COUNT,
  calculateTargets,
  classifyFood,
  derivePhase,
  evaluateDietChoice,
  mifflinStJeor,
  parseFitRules,
  pregnancyWarningFor,
  programDayBetween,
  questionsForDiet,
  suggestedDefaultSlug,
  type DietChoiceContext,
  type TargetInput,
} from "@workspace/diet-programs";
import { PARITY_CASES } from "@workspace/diet-programs/fixtures";

const facts = (slug: string) => {
  const entry = DIET_BY_SLUG.get(slug);
  if (!entry) throw new Error(`missing catalog entry ${slug}`);
  return entry;
};

describe("diet catalog", () => {
  it("ships the 26 owner-named diets plus just tracking, each with content and parseable fit rules", () => {
    expect(DIET_CATALOG).toHaveLength(SELECTABLE_DIET_COUNT + 1);
    expect(DIET_CATALOG.filter((entry) => entry.slug !== JUST_TRACKING_SLUG)).toHaveLength(26);
    const slugs = new Set(DIET_CATALOG.map((entry) => entry.slug));
    for (const required of [
      "intermittent_fasting", GLP1_COMPANION_SLUG, "mediterranean", "keto", "low_glycemic", "whole_food_plant_based", "flexitarian", "paleo",
      "whole30", "anti_inflammatory", "carnivore", "dash", "volumetrics", "low_fodmap", "perimenopause_menopause", FERTILITY_PREGNANCY_SLUG,
      "mind", "gerd_reflux", "portfolio", "nordic", "low_purine", "low_oxalate", "aip", "guided_elimination", "low_histamine", "specific_carbohydrate", JUST_TRACKING_SLUG,
    ]) expect(slugs.has(required), required).toBe(true);
    for (const entry of DIET_CATALOG) {
      expect(entry.name.trim().length, entry.slug).toBeGreaterThan(0);
      expect(entry.summary.trim().length, entry.slug).toBeGreaterThan(0);
      expect(["simple", "moderate", "advanced"]).toContain(entry.complexity);
      expect(parseFitRules(entry.fitRules), entry.slug).not.toBeNull();
      if (entry.slug !== JUST_TRACKING_SLUG) {
        expect(entry.ruleSheet.length, entry.slug).toBeGreaterThan(0);
        expect(entry.sampleDay.length, entry.slug).toBeGreaterThan(0);
      }
    }
  });

  it("maps the owner's screening and pregnancy rules onto the right diets", () => {
    for (const slug of ["intermittent_fasting", "keto"]) expect(facts(slug).screeningQuestions, slug).toContain("medication");
    for (const slug of ["carnivore", "whole30", "aip", "guided_elimination"]) expect(facts(slug).screeningQuestions, slug).toContain("eating_disorder");
    for (const slug of ["intermittent_fasting", "keto", "carnivore", "whole30", "guided_elimination"]) expect(facts(slug).pregnancyBlocked, slug).toBe(true);
    expect(facts(FERTILITY_PREGNANCY_SLUG).pregnancyBlocked).toBe(false);
    expect(facts("mediterranean").pregnancyBlocked).toBe(false);
    expect(facts(JUST_TRACKING_SLUG).screeningQuestions).toEqual([]);
  });
});

describe("phase derivation", () => {
  it("counts whole days from the current episode (the app's long-standing rule), maintenance from day 43", () => {
    expect(programDayBetween("2026-01-01", "2026-01-01")).toBe(1);
    expect(programDayBetween("2026-01-01", "2026-01-03")).toBe(2);
    expect(programDayBetween("2026-01-01", "2025-12-01")).toBe(1);
    expect(programDayBetween(null, "2026-01-05")).toBe(1);
    const day42 = derivePhase({ episodeStartedOn: "2026-01-01", todayKey: "2026-02-12", programId: "thinnr" });
    expect(day42).toMatchObject({ programDay: PROTOCOL_LENGTH_DAYS, phase: "protocol", maintenanceDay: 0, dietPickerLocked: true, phaseName: "Metabolic Transition Phase" });
    const day43 = derivePhase({ episodeStartedOn: "2026-01-01", todayKey: "2026-02-13", programId: "thinnr" });
    expect(day43).toMatchObject({ programDay: 43, phase: "maintenance", maintenanceDay: 1, dietPickerLocked: false, phaseName: "Metabolic Normalization Phase" });
  });

  it("a restart moves the calendar back to day one and locks the picker again", () => {
    const before = derivePhase({ episodeStartedOn: "2025-10-01", todayKey: "2026-03-01", programId: "thinnr" });
    expect(before.phase).toBe("maintenance");
    const after = derivePhase({ episodeStartedOn: "2026-03-01", todayKey: "2026-03-01", programId: "thinnr" });
    expect(after).toMatchObject({ programDay: 1, phase: "protocol", dietPickerLocked: true });
  });

  it("GLP-1 and tracking-only programs never lock the picker", () => {
    expect(derivePhase({ episodeStartedOn: "2026-03-01", todayKey: "2026-03-01", programId: "glp1" }).dietPickerLocked).toBe(false);
    expect(derivePhase({ episodeStartedOn: "2026-03-01", todayKey: "2026-03-01", programId: "none" })).toMatchObject({ phase: "maintenance", maintenanceDay: 1 });
  });
});

describe("target calculator", () => {
  const base: TargetInput = {
    gender: "female", ageYears: 40, heightInches: 65, weightLb: 180, goalWeightLb: 150, activityLevel: "light",
    phase: "maintenance", programDay: 43, maintenanceDay: 1, cameFromProtocol: true,
  };

  it("uses Mifflin-St Jeor with the activity factor", () => {
    // 10*81.65kg + 6.25*165.1cm - 5*40 - 161 = 1487.4
    expect(mifflinStJeor("female", 40, 65, 180)).toBe(1487);
    expect(mifflinStJeor("male", 40, 65, 180)).toBe(1653);
    const result = calculateTargets({ ...base, activityLevel: "moderate" });
    expect(result.bmr).toBe(1487);
    expect(result.maintenanceCalories).toBe(Math.round((1487 * ACTIVITY_FACTORS.moderate) / 10) * 10);
    expect(result.missing).toEqual([]);
  });

  it("protocol days 1-2 are loading days; later protocol days hold the deficit", () => {
    const loading = calculateTargets({ ...base, phase: "protocol", programDay: 2, maintenanceDay: 0 });
    expect(loading.calculated.calories).toBe(LOADING_DAY_CALORIES);
    const thinning = calculateTargets({ ...base, phase: "protocol", programDay: 10, maintenanceDay: 0 });
    expect(thinning.calculated.calories).toBeLessThan(loading.calculated.calories);
    expect(thinning.calculated.calories).toBeLessThan(thinning.maintenanceCalories as number);
    expect(thinning.rampStep).toBe(0);
  });

  it("maintenance ramps calories up one step per week toward the maintenance level and then holds", () => {
    const hold: TargetInput = { ...base, goalWeightLb: 180 };
    const week1 = calculateTargets({ ...hold, maintenanceDay: 1 });
    const week2 = calculateTargets({ ...hold, maintenanceDay: MAINTENANCE_STEP_DAYS + 1 });
    expect(week1.ramping).toBe(true);
    expect(week2.rampStep).toBe(1);
    expect(week2.calculated.calories - week1.calculated.calories).toBe(MAINTENANCE_STEP_CALORIES);
    const settled = calculateTargets({ ...hold, maintenanceDay: 400 });
    expect(settled.calculated.calories).toBe(settled.maintenanceCalories);
    expect(settled.ramping).toBe(false);
    expect(settled.goalDirection).toBe("hold");
  });

  it("goal weight direction caps the ramp: still losing stays below maintenance, gaining goes above", () => {
    const losing = calculateTargets({ ...base, maintenanceDay: 400 });
    expect(losing.goalDirection).toBe("lose");
    expect(losing.calculated.calories).toBeLessThan(losing.maintenanceCalories as number);
    const gaining = calculateTargets({ ...base, goalWeightLb: 200, maintenanceDay: 400 });
    expect(gaining.goalDirection).toBe("gain");
    expect(gaining.calculated.calories).toBeGreaterThan(gaining.maintenanceCalories as number);
  });

  it("patient overrides win field by field and are reported", () => {
    const result = calculateTargets(base, { calories: 1800, protein: null, waterOz: 90 });
    expect(result.effective.calories).toBe(1800);
    expect(result.effective.waterOz).toBe(90);
    expect(result.effective.protein).toBe(result.calculated.protein);
    expect(result.overridden).toEqual(["calories", "waterOz"]);
  });

  it("names the missing inputs and falls back without inventing a BMR", () => {
    const result = calculateTargets({ ...base, gender: null, activityLevel: null });
    expect(result.missing).toEqual(["gender", "activityLevel"]);
    expect(result.bmr).toBeNull();
    expect(result.calculated.calories).toBeGreaterThan(0);
  });
});

describe("food-fit classifier", () => {
  it("returns the fixture verdicts (the mobile app runs the same cases)", () => {
    for (const testCase of PARITY_CASES) {
      const result = classifyFood(testCase.food, testCase.context);
      expect(result.verdict, testCase.id).toBe(testCase.expected);
      for (const code of testCase.expectReasons ?? []) expect(result.reasons.map((r) => r.code), testCase.id).toContain(code);
    }
  });

  it("protocol phase uses the Approved Foods list and ignores the diet", () => {
    const approved = classifyFood({ name: "Chicken breast", tags: ["poultry"], thinnrApproved: true }, { dietSlug: "carnivore", phase: "protocol" });
    expect(approved.verdict).toBe("fits");
    const notApproved = classifyFood({ name: "Ribeye", tags: ["meat", "red_meat"], thinnrApproved: false }, { dietSlug: "carnivore", phase: "protocol" });
    expect(notApproved.verdict).toBe("does_not_fit");
    expect(notApproved.reasons.map((r) => r.code)).toContain("protocol:not_approved");
    expect(classifyFood({ name: "Mystery" }, { dietSlug: null, phase: "protocol" }).verdict).toBe("unknown");
  });

  it("severe allergies count may-contain, mild ones only direct ingredients, and lists layer over any diet", () => {
    const food = { name: "Trail mix", tags: ["tree_nut", "whole_grain"], mayContain: ["milk"] };
    const severe = classifyFood(food, { dietSlug: "mediterranean", phase: "maintenance", preferences: [{ list: "allergy", key: "milk", label: "Milk", severity: "severe" }] });
    expect(severe.verdict).toBe("does_not_fit");
    const mild = classifyFood(food, { dietSlug: "mediterranean", phase: "maintenance", preferences: [{ list: "allergy", key: "milk", label: "Milk", severity: "mild" }] });
    expect(mild.verdict).toBe("fits");
    const disliked = classifyFood(food, { dietSlug: null, phase: "maintenance", preferences: [{ list: "dislike", key: "trail-mix", label: "Trail mix", custom: true }] });
    expect(disliked.verdict).toBe("does_not_fit");
    expect(disliked.reasons.some((r) => r.source === "dislike")).toBe(true);
  });

  it("HQ-edited fit rules from the database override the catalog for that slug", () => {
    const strict = parseFitRules({ mode: "exclude", excludeTags: ["fish"] });
    expect(strict).not.toBeNull();
    const result = classifyFood({ name: "Grilled salmon", tags: ["fish"] }, { dietSlug: "mediterranean", phase: "maintenance", fitRulesBySlug: { mediterranean: strict! } });
    expect(result.verdict).toBe("does_not_fit");
  });
});

describe("safety screening rules", () => {
  const ctx = (over: Partial<DietChoiceContext> = {}): DietChoiceContext => ({ phase: "maintenance", programId: "thinnr", gender: "female", answers: {}, actor: "patient", ...over });

  it("locks every pick, including staff picks, while the THINNR protocol runs", () => {
    expect(evaluateDietChoice(facts("mediterranean"), ctx({ phase: "protocol" }))).toEqual({ kind: "locked", reason: "protocol" });
    expect(evaluateDietChoice(facts("mediterranean"), ctx({ phase: "protocol", actor: "staff" }))).toEqual({ kind: "locked", reason: "protocol" });
    expect(evaluateDietChoice(facts("mediterranean"), ctx({ phase: "protocol", programId: "glp1" })).kind).toBe("allowed");
  });

  it("asks pregnancy only of female patients and requires an answer (skip allowed) before a pick lands", () => {
    expect(questionsForDiet(facts("keto"), "female").sort()).toEqual(["medication", "pregnancy"]);
    expect(questionsForDiet(facts("keto"), "male")).toEqual(["medication"]);
    expect(evaluateDietChoice(facts("keto"), ctx())).toEqual({ kind: "needs_answers", questions: expect.arrayContaining(["medication", "pregnancy"]) });
    expect(evaluateDietChoice(facts("keto"), ctx({ answers: { medication: "no", pregnancy: "skipped" } })).kind).toBe("allowed");
  });

  it("a yes to pregnancy blocks the fasting / keto / carnivore / Whole30 / elimination family and suggests the fertility plan", () => {
    for (const slug of ["intermittent_fasting", "keto", "carnivore", "whole30", "guided_elimination"]) {
      const answers = { pregnancy: "yes" as const, medication: "no" as const, eating_disorder: "no" as const };
      expect(evaluateDietChoice(facts(slug), ctx({ answers })), slug).toEqual({ kind: "blocked_pregnancy", suggestedSlug: FERTILITY_PREGNANCY_SLUG });
    }
    expect(evaluateDietChoice(facts("mediterranean"), ctx({ answers: { pregnancy: "yes" } })).kind).toBe("allowed");
    expect(pregnancyWarningFor("keto")).toBe(true);
    expect(pregnancyWarningFor("dash")).toBe(false);
    expect(pregnancyWarningFor(null)).toBe(false);
  });

  it("a yes to a medication or eating-disorder question parks the pick for provider review", () => {
    expect(evaluateDietChoice(facts("keto"), ctx({ gender: "male", answers: { medication: "yes" } }))).toEqual({ kind: "pending_block", questions: ["medication"] });
    expect(evaluateDietChoice(facts("whole30"), ctx({ gender: "male", answers: { eating_disorder: "yes" } }))).toEqual({ kind: "pending_block", questions: ["eating_disorder"] });
  });

  it("allowed picks name the care-team signals; just tracking only reports the change", () => {
    const oversight = DIET_CATALOG.find((entry) => entry.oversightNote && entry.screeningQuestions.length === 0 && !entry.pregnancyBlocked);
    expect(oversight).toBeDefined();
    expect(evaluateDietChoice(oversight!, ctx())).toEqual({ kind: "allowed", notifyCareTeam: ["diet_changed", "oversight_recommended"] });
    expect(evaluateDietChoice(facts(JUST_TRACKING_SLUG), ctx())).toEqual({ kind: "allowed", notifyCareTeam: ["diet_changed"] });
    expect(evaluateDietChoice(facts("mediterranean"), ctx())).toEqual({ kind: "allowed", notifyCareTeam: ["diet_changed"] });
  });

  it("suggests GLP-1 companion for GLP-1 patients and just tracking otherwise", () => {
    expect(suggestedDefaultSlug("glp1")).toBe(GLP1_COMPANION_SLUG);
    expect(suggestedDefaultSlug("thinnr")).toBe(JUST_TRACKING_SLUG);
    expect(suggestedDefaultSlug(null)).toBe(JUST_TRACKING_SLUG);
  });
});
