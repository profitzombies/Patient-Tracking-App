import { describe, expect, it } from "vitest";
import type { MedicationRecord } from "../medications/schedule";
import {
  deriveSuggestionSignals,
  selectReviewedReport,
  resultDirection,
  type SuggestionFacts,
} from "./product-signals";

const TODAY = "2026-09-17";

function shift(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function med(name: string, extra: Partial<MedicationRecord> = {}): MedicationRecord {
  return {
    id: name,
    name,
    form: "injection",
    dose: null,
    scheduleKind: "daily",
    times: ["08:00"],
    weekday: null,
    notes: null,
    startDate: "2026-08-01",
    stopDate: null,
    source: "patient",
    version: null,
    ...extra,
  } as MedicationRecord;
}

/** A well-behaved patient: steady loss, aligned meals every day, water and protein on target. */
function baseline(): SuggestionFacts {
  const weighIns = Array.from({ length: 21 }, (_, i) => ({ dateKey: shift(TODAY, -20 + i), weight: 210 - i * 0.4 }));
  const entries = [];
  for (let back = 13; back >= 0; back--) {
    const dateKey = shift(TODAY, -back);
    entries.push({ dateKey, kind: "recipe" as const, refId: "rec_baked_salmon", protein: 45 });
    entries.push({ dateKey, kind: "recipe" as const, refId: "rec_roast_chicken", protein: 45 });
    entries.push({ dateKey, kind: "recipe" as const, refId: "rec_lentil_soup", protein: 30 });
  }
  return {
    todayKey: TODAY,
    programDay: 20,
    weighIns,
    entries,
    waterDays: Array.from({ length: 7 }, (_, i) => ({ dateKey: shift(TODAY, -i), oz: 70 })),
    targets: { protein: 120, waterOz: 64 },
    medications: [],
    bloodwork: [],
  };
}

const ids = (facts: SuggestionFacts) => deriveSuggestionSignals(facts).map((s) => s.id);

describe("deriveSuggestionSignals", () => {
  it("emits nothing for a patient whose data gives no reason", () => {
    expect(ids(baseline())).toEqual([]);
  });

  it("detects a stall from flat weigh-ins and regain from rising ones", () => {
    const flat = baseline();
    flat.weighIns = flat.weighIns.map((w) => ({ ...w, weight: 200 }));
    const flatSignals = deriveSuggestionSignals(flat);
    expect(flatSignals.map((s) => s.id)).toContain("stall");
    expect(flatSignals.map((s) => s.id)).not.toContain("weight_regain");
    expect(flatSignals.find((s) => s.id === "stall")?.detail).toMatch(/held within/);

    const rising = baseline();
    rising.weighIns = rising.weighIns.map((w, i) => ({ ...w, weight: 195 + i * 0.3 }));
    const risingIds = ids(rising);
    expect(risingIds).toContain("stall");
    expect(risingIds).toContain("weight_regain");
  });

  it("needs enough recent weigh-ins before it calls a stall", () => {
    const sparse = baseline();
    sparse.weighIns = [{ dateKey: shift(TODAY, -1), weight: 200 }, { dateKey: shift(TODAY, -2), weight: 200 }];
    expect(ids(sparse)).not.toContain("stall");
  });

  it("flags repeated off-plan meals from the diary classification", () => {
    const facts = baseline();
    facts.entries = facts.entries.map((e, i) => (i % 2 === 0 ? { ...e, refId: "rec_yogurt_bowl" } : e));
    const signals = deriveSuggestionSignals(facts);
    expect(signals.map((s) => s.id)).toContain("off_plan_meals");
    expect(signals.find((s) => s.id === "off_plan_meals")?.detail).toMatch(/off plan/);
  });

  it("flags lapsed logging, low protein, and low water over the last week", () => {
    const lapsed = baseline();
    lapsed.entries = lapsed.entries.filter((e) => e.dateKey <= shift(TODAY, -5));
    expect(ids(lapsed)).toContain("low_logging");

    const lowProtein = baseline();
    lowProtein.entries = lowProtein.entries.map((e) => ({ ...e, protein: 20 }));
    const proteinSignals = deriveSuggestionSignals(lowProtein);
    expect(proteinSignals.map((s) => s.id)).toContain("low_protein");
    expect(proteinSignals.find((s) => s.id === "low_protein")?.detail).toContain("120 g target");

    const lowWater = baseline();
    lowWater.waterDays = lowWater.waterDays.map((d) => ({ ...d, oz: 20 }));
    expect(ids(lowWater)).toContain("low_water");
  });

  it("marks the program complete past the protocol length", () => {
    const facts = baseline();
    facts.programDay = 50;
    expect(ids(facts)).toContain("program_complete");
    facts.programDay = 42;
    expect(ids(facts)).not.toContain("program_complete");
  });

  it("reads medication families from active records only, without doses", () => {
    const facts = baseline();
    facts.medications = [
      med("Semaglutide", { dose: "0.5 mg" }),
      med("Metformin", { form: "tablet" }),
      med("Eliquis", { form: "tablet", stopDate: "2026-08-15" }),
    ];
    const signals = deriveSuggestionSignals(facts);
    const byId = new Map(signals.map((s) => [s.id, s.detail]));
    expect(byId.get("glp1_medication")).toContain("Semaglutide");
    expect(byId.get("glp1_medication")).not.toContain("0.5 mg");
    expect(byId.get("diabetes_medication")).toContain("Metformin");
    expect(byId.has("blood_thinner_medication")).toBe(false);
  });

  it("groups flagged bloodwork by marker family and honours direction", () => {
    const facts = baseline();
    facts.bloodwork = [
      { testName: "Glucose", valueText: "118", referenceRange: "70-99", labFlag: "H" },
      { testName: "Vitamin B12", valueText: "180", referenceRange: "232-1245", labFlag: null },
      { testName: "LDL Cholesterol", valueText: "85", referenceRange: "<100", labFlag: null },
      { testName: "Ferritin", valueText: "300", referenceRange: "30-400", labFlag: null },
      { testName: "Creatinine", valueText: "1.6", referenceRange: "0.7-1.3", labFlag: null },
    ];
    const signals = deriveSuggestionSignals(facts);
    const got = signals.map((s) => s.id);
    expect(got).toContain("bloodwork_glucose_high");
    expect(got).toContain("bloodwork_b12_low");
    expect(got).toContain("bloodwork_kidney_flag");
    expect(got).not.toContain("bloodwork_lipids_high");
    expect(got).not.toContain("bloodwork_iron_low");
    expect(signals.find((s) => s.id === "bloodwork_glucose_high")?.detail).toMatch(/Glucose flagged high/);
  });
});

describe("selectReviewedReport", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  it("ignores unreviewed reports entirely, even when they are the newest", () => {
    expect(selectReviewedReport([
      { id: "new-unreviewed", reviewed_at: null, report_date: "2026-09-10" },
      { id: "old-reviewed", reviewed_at: "2026-05-02T10:00:00Z", report_date: "2026-05-01" },
    ], now)?.id).toBe("old-reviewed");
    expect(selectReviewedReport([{ id: "only-unreviewed", reviewed_at: null, report_date: "2026-09-10" }], now)).toBeNull();
  });
  it("picks the newest reviewed report by lab date, falling back to the review date", () => {
    expect(selectReviewedReport([
      { id: "a", reviewed_at: "2026-09-01T10:00:00Z", report_date: "2026-03-01" },
      { id: "b", reviewed_at: "2026-06-01T10:00:00Z", report_date: "2026-05-20" },
      { id: "c", reviewed_at: "2026-08-15T10:00:00Z", report_date: null },
    ], now)?.id).toBe("c");
  });
  it("drops a reviewed report that is older than the freshness window", () => {
    expect(selectReviewedReport([{ id: "stale", reviewed_at: "2026-09-01T10:00:00Z", report_date: "2025-01-15" }], now)).toBeNull();
    expect(selectReviewedReport([{ id: "fresh", reviewed_at: "2026-09-01T10:00:00Z", report_date: "2025-10-15" }], now)?.id).toBe("fresh");
  });
});

describe("resultDirection", () => {
  it("trusts the lab flag first", () => {
    expect(resultDirection({ testName: "x", valueText: "5", referenceRange: "1-10", labFlag: "H" })).toBe("high");
    expect(resultDirection({ testName: "x", valueText: "5", referenceRange: "1-10", labFlag: "LOW" })).toBe("low");
    expect(resultDirection({ testName: "x", valueText: "50", referenceRange: "1-10", labFlag: "N" })).toBeNull();
  });

  it("falls back to simple reference ranges and never guesses", () => {
    expect(resultDirection({ testName: "x", valueText: "12 mg/dL", referenceRange: "1 - 10", labFlag: null })).toBe("high");
    expect(resultDirection({ testName: "x", valueText: "0.5", referenceRange: "1-10", labFlag: null })).toBe("low");
    expect(resultDirection({ testName: "x", valueText: "120", referenceRange: "<100", labFlag: null })).toBe("high");
    expect(resultDirection({ testName: "x", valueText: "25", referenceRange: ">30", labFlag: null })).toBe("low");
    expect(resultDirection({ testName: "x", valueText: "Positive", referenceRange: "Negative", labFlag: null })).toBeNull();
    expect(resultDirection({ testName: "x", valueText: "7", referenceRange: null, labFlag: null })).toBeNull();
  });
});
