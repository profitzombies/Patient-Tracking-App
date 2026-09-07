import { describe, expect, it } from "vitest";
import {
  adherenceSummary,
  describeSchedule,
  doseStatuses,
  isScheduledOn,
  localDateKey,
  occurrencesBetween,
  occurrencesOn,
  parseClockLabel,
  seedMedicationsFor,
  validateMedicationInput,
  withinCorrectionWindow,
  zonedInstant,
  type DoseLogRecord,
  type MedicationRecord,
} from "./schedule";

const NY = "America/New_York";
const med = (overrides: Partial<MedicationRecord> = {}): MedicationRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "THINNR Protocol drops",
  form: "drops",
  dose: "1 mL under the tongue",
  scheduleKind: "daily",
  times: ["08:00", "15:00", "22:00"],
  weekday: null,
  notes: null,
  startDate: "2026-03-01",
  stopDate: null,
  source: "onboarding",
  version: null,
  ...overrides,
});
const weekly = med({
  id: "22222222-2222-4222-8222-222222222222",
  name: "GLP-1 injection",
  form: "injection",
  dose: "0.5 mg",
  scheduleKind: "weekly",
  times: ["09:00"],
  weekday: 1, // Monday
});
const log = (m: MedicationRecord, dueDate: string, dueTime: string, status: "taken" | "skipped"): DoseLogRecord => ({
  id: `log-${dueDate}-${dueTime}`,
  medicationId: m.id,
  dueDate,
  dueTime,
  status,
  source: "check_in",
  loggedAt: "2026-03-10T00:00:00Z",
});

describe("zonedInstant", () => {
  it("resolves local wall times with the zone offset in force that day", () => {
    expect(zonedInstant("2026-03-07", "08:00", NY).toISOString()).toBe("2026-03-07T13:00:00.000Z"); // EST
    expect(zonedInstant("2026-03-08", "08:00", NY).toISOString()).toBe("2026-03-08T12:00:00.000Z"); // EDT after spring-forward
    expect(zonedInstant("2026-11-01", "08:00", NY).toISOString()).toBe("2026-11-01T13:00:00.000Z"); // EST after fall-back
    expect(zonedInstant("2026-07-01", "08:00", "UTC").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedInstant("2026-07-01", "08:00", "Australia/Sydney").toISOString()).toBe("2026-06-30T22:00:00.000Z");
  });
  it("shifts skipped spring-forward times forward by the gap", () => {
    // 02:30 never happens on 2026-03-08 in New York: 02:00 EST -> 03:00 EDT, so 02:30 lands on 03:30 EDT.
    expect(zonedInstant("2026-03-08", "02:30", NY).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
  it("picks the first occurrence of a repeated fall-back time", () => {
    // 01:30 happens twice on 2026-11-01 in New York; the first is EDT.
    expect(zonedInstant("2026-11-01", "01:30", NY).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("falls back to UTC for unknown zones", () => {
    expect(zonedInstant("2026-07-01", "08:00", "Mars/Olympus").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(localDateKey(new Date("2026-07-01T23:30:00Z"), NY)).toBe("2026-07-01");
    expect(localDateKey(new Date("2026-07-01T23:30:00Z"), "Asia/Tokyo")).toBe("2026-07-02");
  });
});

describe("occurrences", () => {
  it("generates daily occurrences within start/stop and none outside", () => {
    const m = med({ startDate: "2026-03-02", stopDate: "2026-03-03" });
    const all = occurrencesBetween([m], "2026-03-01", "2026-03-05", NY);
    expect(all.map((o) => `${o.dueDate} ${o.dueTime}`)).toEqual([
      "2026-03-02 08:00", "2026-03-02 15:00", "2026-03-02 22:00",
      "2026-03-03 08:00", "2026-03-03 15:00", "2026-03-03 22:00",
    ]);
    expect(all[0].key).toBe(`${m.id}:2026-03-02:08:00`);
  });
  it("generates weekly occurrences on the chosen weekday only", () => {
    const all = occurrencesBetween([weekly], "2026-03-01", "2026-03-14", NY);
    expect(all.map((o) => o.dueDate)).toEqual(["2026-03-02", "2026-03-09"]);
    expect(isScheduledOn(weekly, "2026-03-03")).toBe(false);
    expect(isScheduledOn(weekly, "2026-03-09")).toBe(true);
  });
  it("keeps the wall clock across a daylight-saving change", () => {
    const [before] = occurrencesOn(med(), "2026-03-07", NY);
    const [after] = occurrencesOn(med(), "2026-03-08", NY);
    expect(before.dueAt).toBe("2026-03-07T13:00:00.000Z");
    expect(after.dueAt).toBe("2026-03-08T12:00:00.000Z");
  });
  it("sorts across medications by due instant and dedupes times", () => {
    const m = med({ times: ["15:00", "08:00", "08:00"] });
    const all = occurrencesBetween([weekly, m], "2026-03-02", "2026-03-02", NY);
    expect(all.map((o) => `${o.medicationId === m.id ? "drops" : "glp"} ${o.dueTime}`)).toEqual(["drops 08:00", "glp 09:00", "drops 15:00"]);
  });
});

describe("dose state and adherence", () => {
  it("classifies upcoming, due (in grace), missed, taken, and skipped", () => {
    const m = med();
    const logs = [log(m, "2026-03-10", "08:00", "taken"), log(m, "2026-03-10", "15:00", "skipped")];
    const now = new Date("2026-03-11T13:30:00Z"); // 09:30 EDT on the 11th
    const statuses = doseStatuses([m], logs, "2026-03-10", "2026-03-11", NY, now, 60);
    expect(statuses.map((s) => `${s.dueDate} ${s.dueTime} ${s.state}`)).toEqual([
      "2026-03-10 08:00 taken",
      "2026-03-10 15:00 skipped",
      "2026-03-10 22:00 missed",
      "2026-03-11 08:00 missed",
      "2026-03-11 15:00 upcoming",
      "2026-03-11 22:00 upcoming",
    ]);
    const inGrace = doseStatuses([m], [], "2026-03-11", "2026-03-11", NY, new Date("2026-03-11T12:30:00Z"), 60);
    expect(inGrace[0].state).toBe("due");
  });
  it("summarises adherence over a window counting only doses that came due", () => {
    const m = med();
    const logs = [log(m, "2026-03-10", "08:00", "taken"), log(m, "2026-03-10", "15:00", "taken"), log(m, "2026-03-11", "08:00", "skipped")];
    const now = new Date("2026-03-11T13:30:00Z");
    const summary = adherenceSummary([m], logs, "2026-03-10", "2026-03-11", NY, now, 60);
    expect(summary).toMatchObject({ due: 4, taken: 2, skipped: 1, missed: 1, rate: 50 });
    expect(summary.days).toEqual([
      { dateKey: "2026-03-10", due: 3, taken: 2, skipped: 0, missed: 1 },
      { dateKey: "2026-03-11", due: 1, taken: 0, skipped: 1, missed: 0 },
    ]);
  });
  it("reports null adherence when nothing has come due", () => {
    const summary = adherenceSummary([med({ startDate: "2026-04-01" })], [], "2026-03-01", "2026-03-30", NY, new Date("2026-03-15T00:00:00Z"));
    expect(summary.rate).toBeNull();
    expect(summary.due).toBe(0);
  });
  it("bounds corrections to the trailing seven days", () => {
    expect(withinCorrectionWindow("2026-03-10", "2026-03-10")).toBe(true);
    expect(withinCorrectionWindow("2026-03-03", "2026-03-10")).toBe(true);
    expect(withinCorrectionWindow("2026-03-02", "2026-03-10")).toBe(false);
    expect(withinCorrectionWindow("2026-03-11", "2026-03-10")).toBe(false);
  });
});

describe("validation, seeds, and labels", () => {
  it("normalises a valid medication and rejects bad shapes with a field", () => {
    const ok = validateMedicationInput({ id: med().id, name: "  Metformin ", form: "tablet", dose: "", scheduleKind: "daily", times: ["21:00", "08:00", "08:00"], startDate: "2026-03-01" });
    expect(ok).toMatchObject({ ok: true, value: { name: "Metformin", dose: null, times: ["08:00", "21:00"], weekday: null, stopDate: null } });
    expect(validateMedicationInput({ ...med(), scheduleKind: "weekly", weekday: null })).toMatchObject({ ok: false, field: "weekday" });
    expect(validateMedicationInput({ ...med(), times: ["8:00"] })).toMatchObject({ ok: false, field: "times" });
    expect(validateMedicationInput({ ...med(), stopDate: "2026-02-01" })).toMatchObject({ ok: false, field: "stopDate" });
    expect(validateMedicationInput({ ...med(), id: "nope" })).toMatchObject({ ok: false, field: "id" });
    expect(validateMedicationInput({ ...med(), form: "gummy" })).toMatchObject({ ok: false, field: "form" });
  });
  it("seeds the protocol drops for THINNR and a weekly injection for GLP-1", () => {
    let n = 0;
    const makeId = () => `33333333-3333-4333-8333-33333333333${n++}`;
    const drops = seedMedicationsFor({ programId: "thinnr", startDate: "2026-03-01", dailyTimes: ["08:30", "15:30", "22:30"] }, makeId);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ form: "drops", scheduleKind: "daily", times: ["08:30", "15:30", "22:30"], startDate: "2026-03-01" });
    const fallback = seedMedicationsFor({ programId: "thinnr", startDate: "2026-03-01", dailyTimes: ["bad"] }, makeId);
    expect(fallback[0].times).toEqual(["08:00", "15:00", "22:00"]);
    const glp = seedMedicationsFor({ programId: "glp1", startDate: "2026-03-01", injectionWeekday: 4, injectionTime: "18:00" }, makeId);
    expect(glp[0]).toMatchObject({ form: "injection", scheduleKind: "weekly", weekday: 4, times: ["18:00"] });
    expect(seedMedicationsFor({ programId: "glp1", startDate: "2026-03-01", injectionWeekday: null }, makeId)).toEqual([]);
    expect(seedMedicationsFor({ programId: "none", startDate: "2026-03-01" }, makeId)).toEqual([]);
  });
  it("describes schedules and parses clock labels", () => {
    expect(describeSchedule(med())).toBe("Daily at 8:00 AM, 3:00 PM, 10:00 PM");
    expect(describeSchedule(weekly)).toBe("Weekly on Monday at 9:00 AM");
    expect(parseClockLabel("12:30 AM")).toBe("00:30");
    expect(parseClockLabel("9:05 PM")).toBe("21:05");
    expect(parseClockLabel("25:00")).toBeNull();
  });
});
