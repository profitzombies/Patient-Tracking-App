/**
 * The diet grounding block: how the raw reads shape into one canonical
 * compartment (phase, diet, rule sheet, honest limits, fasting window,
 * Whole30 day, the four lists with severity flags, cautions, targets) and
 * when a diet change earns its one acknowledgement. Pure shaping; no network.
 */
import { describe, expect, it } from "vitest";
import { buildDietGrounding, dietChangeAckLine, describeEatingWindow, renderDietBlock, type RawDietGrounding } from "./diet-grounding";
import { buildSystemPrompt, patientContextLine, type PatientContext, type PatientDayTargets } from "./prompt";
import { getCompartmentById } from "./compartments";
import type { DietLibraryRow } from "../diet/library";
import type { PreferenceRecord } from "../diet/store";

const DISCLAIMER = "THINNR Coach is not a substitute for your care team.";
const TARGETS: PatientDayTargets = { calories: 1400, protein: 120, carbs: 90, fat: 50, waterOz: 80 };

function libraryRow(slug: string, name: string, extra: Partial<DietLibraryRow> = {}): DietLibraryRow {
  return {
    id: `lib-${slug}`, slug, name, summary: `${name} in one line.`, complexity: "moderate",
    rule_sheet: [`${name} rule one.`, `${name} rule two.`], sample_day: [], oversight_note: false, pregnancy_blocked: false,
    screening_questions: [], fit_rules: null, evidence_strength: "moderate", supervision_level: "none", sources: [],
    ...extra,
  } as DietLibraryRow;
}

function selection(slug: string, overrides: Partial<RawDietGrounding["active"] & object> = {}): NonNullable<RawDietGrounding["active"]> {
  return { id: `sel-${slug}`, dietSlug: slug, status: "active", settings: {}, startedAt: "2026-09-01T00:00:00Z", coachAcknowledgedAt: null, ...overrides };
}

function pref(list: PreferenceRecord["list"], itemKey: string, label: string, severity: PreferenceRecord["severity"] = null): PreferenceRecord {
  return { id: `p-${itemKey}`, list, itemKey, label, isCustom: itemKey.startsWith("custom:"), severity, enteredByRole: "patient", enteredByName: null, createdAt: "2026-09-01T00:00:00Z" };
}

function raw(overrides: Partial<RawDietGrounding> = {}): RawDietGrounding {
  return {
    active: selection("mediterranean"),
    previous: null,
    preferences: [],
    answers: {},
    library: [libraryRow("mediterranean", "Mediterranean"), libraryRow("just_tracking", "Just tracking"), libraryRow("low_fodmap", "Low FODMAP"), libraryRow("low_glycemic", "Low glycemic"), libraryRow("intermittent_fasting", "Intermittent fasting"), libraryRow("whole30", "Whole30")],
    disclaimer: DISCLAIMER,
    ...overrides,
  };
}

describe("buildDietGrounding", () => {
  it("carries the diet, rule sheet, lists with severity, cautions and disclaimer", () => {
    const g = buildDietGrounding(raw({
      preferences: [pref("allergy", "peanut", "Peanuts", "severe"), pref("dislike", "custom:broccoli", "broccoli")],
      answers: { medication: "yes", pregnancy: "no", eating_disorder: "skipped" },
    }), "maintenance", "2026-10-10");
    expect(g.phase).toBe("maintenance");
    expect(g.diet).toMatchObject({ slug: "mediterranean", name: "Mediterranean", ruleSheet: ["Mediterranean rule one.", "Mediterranean rule two."] });
    expect(g.lists).toEqual([
      { list: "allergy", key: "peanut", label: "Peanuts", custom: false, severity: "severe" },
      { list: "dislike", key: "custom:broccoli", label: "broccoli", custom: true, severity: null },
    ]);
    expect(g.cautions).toHaveLength(1);
    expect(g.cautions[0]).toMatch(/medication/);
    expect(g.disclaimer).toBe(DISCLAIMER);
    expect(g.fastingWindow).toBeNull();
    expect(g.whole30Day).toBeNull();
  });

  it("acknowledges an unacknowledged real diet once, naming the previous one when it changed", () => {
    const fresh = buildDietGrounding(raw(), "maintenance", "2026-10-10");
    expect(fresh.pendingAck).toEqual({ selectionId: "sel-mediterranean", newName: "Mediterranean", newSlug: "mediterranean", previousName: null });

    const switched = buildDietGrounding(raw({ previous: selection("low_fodmap", { status: "superseded" }) }), "maintenance", "2026-10-10");
    expect(switched.pendingAck?.previousName).toBe("Low FODMAP");

    const acked = buildDietGrounding(raw({ active: selection("mediterranean", { coachAcknowledgedAt: "2026-09-02T00:00:00Z" }) }), "maintenance", "2026-10-10");
    expect(acked.pendingAck).toBeNull();
  });

  it("never acknowledges 'just tracking' picked first, but does when it replaces a diet", () => {
    const first = buildDietGrounding(raw({ active: selection("just_tracking") }), "maintenance", "2026-10-10");
    expect(first.pendingAck).toBeNull();
    const stepped = buildDietGrounding(raw({ active: selection("just_tracking"), previous: selection("mediterranean", { status: "superseded" }) }), "maintenance", "2026-10-10");
    expect(stepped.pendingAck).toMatchObject({ newSlug: "just_tracking", previousName: "Mediterranean" });
    expect(dietChangeAckLine(stepped.pendingAck!)).toBe("Quick note: I see you've stepped off Mediterranean and are just tracking now, so I'll coach to your targets and your food lists from here.");
  });

  it("reads the fasting window and the Whole30 day from the selection settings", () => {
    const fasting = buildDietGrounding(raw({ active: selection("intermittent_fasting", { settings: { fastingWindow: { eatingStart: "12:00", eatingEnd: "20:00" } } }) }), "maintenance", "2026-10-10");
    expect(fasting.fastingWindow).toEqual({ eatingStart: "12:00", eatingEnd: "20:00" });
    expect(describeEatingWindow(fasting.fastingWindow!)).toBe("eating window 12:00–20:00 (about 8 hours eating, 16 fasting)");

    const whole30 = buildDietGrounding(raw({ active: selection("whole30", { settings: { whole30StartDate: "2026-10-01" } }) }), "maintenance", "2026-10-10");
    expect(whole30.whole30Day).toBe(10);
    expect(buildDietGrounding(raw({ active: selection("whole30", { settings: { whole30StartDate: "2026-10-10" } }) }), "maintenance", "2026-10-10").whole30Day).toBe(1);
    // A start date in the future counts nothing yet.
    expect(buildDietGrounding(raw({ active: selection("whole30", { settings: { whole30StartDate: "2026-10-20" } }) }), "maintenance", "2026-10-10").whole30Day).toBeNull();
    // Settings only count for the diet they belong to.
    expect(buildDietGrounding(raw({ active: selection("mediterranean", { settings: { fastingWindow: { eatingStart: "12:00", eatingEnd: "20:00" } } }) }), "maintenance", "2026-10-10").fastingWindow).toBeNull();
  });
});

describe("renderDietBlock", () => {
  const render = (overrides: Partial<RawDietGrounding>, phase: "protocol" | "maintenance" = "maintenance", dateKey = "2026-10-10") =>
    renderDietBlock(buildDietGrounding(raw(overrides), phase, dateKey), "Riley", TARGETS);

  it("renders phase, diet, rule sheet, the four lists in fixed order, list rules, cautions, targets and disclaimer", () => {
    const text = render({
      preferences: [
        pref("dislike", "custom:broccoli", "broccoli"),
        pref("restriction", "kosher", "Kosher"),
        pref("sensitivity", "lactose", "Lactose"),
        pref("allergy", "peanut", "Peanuts", "severe"),
        pref("allergy", "shellfish", "Shellfish", "mild"),
      ],
      answers: { pregnancy: "yes" },
    });
    const order = [
      "Diet and food lists (authoritative",
      "- Phase: maintenance",
      "- Diet: Mediterranean (complexity: moderate). Mediterranean in one line.",
      "- Rule sheet:",
      "  • Mediterranean rule one.",
      "- Allergies: Peanuts (SEVERE); Shellfish (mild).",
      "- Sensitivities: Lactose",
      "- Restrictions: Kosher:",
      "- Dislikes: broccoli.",
      "- List rules: never suggest",
      "Kosher and halal also forbid meat (including poultry) with dairy in one dish.",
      "- List changes: when Riley says they dislike",
      "- Cautions: Riley is pregnant",
      "- Daily targets (calculated from goals, body numbers, activity and phase, with any care-team overrides; independent of the diet): 1400 calories, 120g protein, 90g carbs, 50g fat, 80 oz water.",
      `- Disclaimer to attach when giving diet-specific guidance (once per reply, brief): ${DISCLAIMER}`,
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = text.indexOf(needle);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(text).not.toContain("Honest limit");
  });

  it("says the Approved Foods list rules during the protocol and that the diet resumes in maintenance", () => {
    const text = render({}, "protocol");
    expect(text).toContain("- Phase: THINNR protocol. During the protocol the THINNR Approved Foods list decides what fits; the Mediterranean choice below resumes in the maintenance phase.");
    expect(render({ active: null }, "protocol")).toContain("a diet choice only applies in maintenance");
    expect(render({ active: null })).toContain("- Diet: Riley has not chosen a diet yet.");
    expect(render({ active: selection("just_tracking") })).toContain("- Diet: Just tracking. No food rules beyond the lists below");
  });

  it("carries the honest phase-2 limit for FODMAP-type diets and sensitivities, and the low-glycemic judgment note", () => {
    const fodmap = render({ active: selection("low_fodmap") });
    expect(fodmap).toContain("- Honest limit: THINNR's curated FODMAP food data is not available yet.");
    expect(fodmap).toContain("Never invent numbers.");
    expect(fodmap.match(/Honest limit/g)).toHaveLength(1);

    const histamine = render({ preferences: [pref("sensitivity", "histamine", "Histamine")] });
    expect(histamine).toContain("- Honest limit: curated histamine data is not available yet; name obvious triggers only");
    // The same limit is not repeated when the diet already said it.
    expect(render({ active: selection("low_fodmap"), preferences: [pref("sensitivity", "fodmap", "FODMAP")] }).match(/Honest limit/g)).toHaveLength(1);

    const glycemic = render({ active: selection("low_glycemic") });
    expect(glycemic).toContain("- Judgment note: there is no curated glycemic index table here");
  });

  it("names the eating window or the Whole30 day, and asks for them when unset", () => {
    expect(render({ active: selection("intermittent_fasting", { settings: { fastingWindow: { eatingStart: "12:00", eatingEnd: "20:00" } } }) }))
      .toContain("- Fasting: eating window 12:00–20:00 (about 8 hours eating, 16 fasting), in Riley's local time.");
    expect(render({ active: selection("intermittent_fasting") })).toContain("- Fasting: no eating window saved yet.");
    expect(render({ active: selection("whole30", { settings: { whole30StartDate: "2026-10-01" } }) })).toContain("- Whole30: today is day 10 of 30.");
    expect(render({ active: selection("whole30", { settings: { whole30StartDate: "2026-09-01" } }) })).toContain("past the 30 days");
    expect(render({ active: selection("whole30") })).toContain("- Whole30: no start date saved yet.");
  });

  it("is byte-stable for the same inputs and strips prompt-breaking characters", () => {
    const a = render({ preferences: [pref("dislike", "custom:x", "we<ird>`food")] });
    const b = render({ preferences: [pref("dislike", "custom:x", "we<ird>`food")] });
    expect(a).toBe(b);
    expect(a).toContain("- Dislikes: weirdfood.");
  });
});

describe("prompt integration", () => {
  const today = { dateKey: "2026-10-10", calories: 500, protein: 50, carbs: 30, fat: 15, waterOz: 40, targets: TARGETS };

  it("adds the diet block after the today line for real accounts only; the demo prompt never carries it", () => {
    const diet = buildDietGrounding(raw({ preferences: [pref("allergy", "peanut", "Peanuts", "severe")] }), "maintenance", "2026-10-10");
    const real: PatientContext = { firstName: "Riley", phaseName: "Metabolic Normalization", programDay: 61, today, diet };
    const line = patientContextLine(real);
    expect(line.indexOf("Today so far (2026-10-10)")).toBeGreaterThan(0);
    expect(line.indexOf("Diet and food lists")).toBeGreaterThan(line.indexOf("Today so far"));
    expect(line).toContain("Peanuts (SEVERE)");

    const prompt = buildSystemPrompt([getCompartmentById("approved-foods")], real);
    expect(prompt.indexOf("Diet and food lists")).toBeLessThan(prompt.indexOf("Grounding rules:"));
    expect(prompt.indexOf("Grounding rules:")).toBeLessThan(prompt.indexOf("<source "));

    const demo: PatientContext = { firstName: "Emma", phaseName: "Phase 2", programDay: 40 };
    expect(buildSystemPrompt([getCompartmentById("approved-foods")], demo)).not.toContain("Diet and food lists");
    expect(patientContextLine({ ...real, diet: undefined })).not.toContain("Diet and food lists");
  });
});
