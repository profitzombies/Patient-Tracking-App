import { describe, expect, it } from "vitest";
import { ATTENTION_REASON_CODES, evaluateAttention, type AttentionFacts } from "./attention";

const base: AttentionFacts = {
  asOfDate: "2026-10-11", activationStatus: "activated", activityKnown: true,
  accountCreatedDate: "2026-09-01", programStartDate: "2026-09-01",
  latestWeightDate: "2026-10-10", latestDiaryDate: "2026-10-10",
  latestWaterDate: "2026-10-10", latestCheckInDate: "2026-10-10",
  latestActivityDate: "2026-10-10",
};

describe("evaluateAttention", () => {
  it("emits every signal in contract order", () => {
    const result = evaluateAttention({
      ...base, latestWeightDate: "2026-10-04", latestDiaryDate: "2026-10-08",
      latestWaterDate: "2026-10-08", latestCheckInDate: "2026-10-04",
      latestActivityDate: "2026-09-27", activeMedicationStartDates: ["2026-10-01"],
      latestMedicationDoseDate: "2026-10-08", stall: { stalled: true },
      stallCrossedOnDate: "2026-10-08",
    });
    expect(result.reasons.map((reason) => reason.code)).toEqual([...ATTENTION_REASON_CODES]);
    expect(result.reasons.map((reason) => reason.days)).toEqual([7, 3, 3, 3, 3, 7, 14]);
    expect(result.signature).toBe([...ATTENTION_REASON_CODES].sort().join(","));
  });
  it("uses null days when an eligible activity has never been logged", () => {
    const result = evaluateAttention({ ...base, latestWeightDate: null });
    expect(result.reasons).toContainEqual({ code: "no_weight", label: "No weight logged", days: null });
  });
  it("does not invent zeros when activity facts are unknown", () => {
    expect(evaluateAttention({ ...base, activityKnown: false }).reasons).toEqual([]);
  });
  it.each(["paused", "discharged", "invited"])("never flags %s patients", (activationStatus) => {
    expect(evaluateAttention({ ...base, activationStatus, latestDiaryDate: null }).flagged).toBe(false);
  });
  it("never flags pending-deletion patients", () => {
    expect(evaluateAttention({ ...base, pendingDeletion: true, latestDiaryDate: null }).flagged).toBe(false);
  });
});