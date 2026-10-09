import { describe, expect, it } from "vitest";
import {
  isoWeekMonday,
  isoWeekOf,
  nextWeeklyRunInstant,
  previousIsoWeek,
  scoreChangeFrom,
  scoreChangeLabel,
  weekMondayLabel,
  weeklyRunMoment,
} from "./weekly";

const NY = "America/New_York";

describe("ISO weeks", () => {
  it("labels weeks Monday-first with the week-1 rule (week containing January 4th)", () => {
    expect(isoWeekOf(2026, 10, 12)).toBe("2026-W42"); // Monday
    expect(isoWeekOf(2026, 10, 11)).toBe("2026-W41"); // Sunday still belongs to the week before
    expect(isoWeekOf(2026, 1, 1)).toBe("2026-W01"); // Thursday
    expect(isoWeekOf(2027, 1, 1)).toBe("2026-W53"); // Friday; 2026 has 53 ISO weeks
    expect(isoWeekOf(2027, 1, 4)).toBe("2027-W01");
    expect(isoWeekOf(2024, 12, 30)).toBe("2025-W01"); // Monday of the week containing 2025-01-04
  });

  it("round-trips through the week's Monday and steps back a week", () => {
    expect(isoWeekMonday("2026-W42").toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(isoWeekMonday("2025-W01").toISOString().slice(0, 10)).toBe("2024-12-30");
    expect(previousIsoWeek("2026-W42")).toBe("2026-W41");
    expect(previousIsoWeek("2027-W01")).toBe("2026-W53");
    expect(previousIsoWeek("2026-W01")).toBe("2025-W52"); // 2026-W01 starts 2025-12-29; 2025 has 52 weeks
    expect(() => isoWeekMonday("2026-42")).toThrow(/ISO week/);
    expect(weekMondayLabel("2026-W42")).toBe("Monday, October 12, 2026");
  });
});

describe("Monday 09:00 due rule in the organization's zone", () => {
  it("is due only once the local clock reads Monday at or after 09:00", () => {
    // 2026-10-12 is a Monday; Eastern is EDT (UTC-4) in October.
    expect(weeklyRunMoment(new Date("2026-10-12T12:59:00Z"), NY)).toMatchObject({ due: false, weekday: 1, minutes: 8 * 60 + 59, isoWeek: "2026-W42" });
    expect(weeklyRunMoment(new Date("2026-10-12T13:00:00Z"), NY)).toMatchObject({ due: true, localDate: "2026-10-12", weekMonday: "2026-10-12" });
    expect(weeklyRunMoment(new Date("2026-10-12T23:59:00Z"), NY).due).toBe(true);
    // Monday 23:30 Eastern is already Tuesday in UTC — still due on the local calendar.
    expect(weeklyRunMoment(new Date("2026-10-13T03:30:00Z"), NY)).toMatchObject({ due: true, localDate: "2026-10-12" });
    // Tuesday 00:00 local: not due, and the ISO week is unchanged.
    expect(weeklyRunMoment(new Date("2026-10-13T04:00:00Z"), NY)).toMatchObject({ due: false, weekday: 2, isoWeek: "2026-W42" });
    // Sunday evening local, even though UTC already reads Monday.
    expect(weeklyRunMoment(new Date("2026-10-12T02:00:00Z"), NY)).toMatchObject({ due: false, weekday: 0, isoWeek: "2026-W41" });
  });

  it("follows the wall clock across the spring-forward week (09:00 EDT = 13:00Z)", () => {
    // DST began Sunday 2026-03-08; Monday 2026-03-09 09:00 Eastern is 13:00Z.
    expect(weeklyRunMoment(new Date("2026-03-09T13:59:00Z"), NY).due).toBe(true);
    expect(weeklyRunMoment(new Date("2026-03-09T12:59:00Z"), NY).due).toBe(false);
    expect(weeklyRunMoment(new Date("2026-03-09T13:00:00Z"), NY)).toMatchObject({ due: true, isoWeek: "2026-W11" });
    // The Monday before the change still needs 14:00Z (EST).
    expect(weeklyRunMoment(new Date("2026-03-02T13:30:00Z"), NY).due).toBe(false);
    expect(weeklyRunMoment(new Date("2026-03-02T14:00:00Z"), NY).due).toBe(true);
  });

  it("follows the wall clock across the fall-back week (09:00 EST = 14:00Z)", () => {
    // DST ended Sunday 2026-11-01; Monday 2026-11-02 09:00 Eastern is 14:00Z.
    expect(weeklyRunMoment(new Date("2026-11-02T13:00:00Z"), NY)).toMatchObject({ due: false, minutes: 8 * 60 });
    expect(weeklyRunMoment(new Date("2026-11-02T13:59:00Z"), NY).due).toBe(false);
    expect(weeklyRunMoment(new Date("2026-11-02T14:00:00Z"), NY)).toMatchObject({ due: true, isoWeek: "2026-W45" });
    // The Monday before the change is still EDT.
    expect(weeklyRunMoment(new Date("2026-10-26T13:00:00Z"), NY).due).toBe(true);
  });

  it("falls back to UTC for an unknown zone and respects other zones", () => {
    expect(weeklyRunMoment(new Date("2026-10-12T09:00:00Z"), "Not/AZone").due).toBe(true);
    expect(weeklyRunMoment(new Date("2026-10-12T08:59:00Z"), "Not/AZone").due).toBe(false);
    expect(weeklyRunMoment(new Date("2026-10-12T16:00:00Z"), "America/Los_Angeles")).toMatchObject({ due: true, minutes: 9 * 60 });
  });
});

describe("next weekly run instant (queue expiry)", () => {
  it("is the following Monday 09:00 local, never the Monday morning already under way", () => {
    expect(nextWeeklyRunInstant(new Date("2026-10-12T13:00:00Z"), NY).toISOString()).toBe("2026-10-19T13:00:00.000Z");
    expect(nextWeeklyRunInstant(new Date("2026-10-12T20:17:30Z"), NY).toISOString()).toBe("2026-10-19T13:00:00.000Z");
    // From Monday 08:30 local the first due instant is the same morning.
    expect(nextWeeklyRunInstant(new Date("2026-10-12T12:30:00Z"), NY).toISOString()).toBe("2026-10-12T13:00:00.000Z");
    // From a Wednesday, the coming Monday.
    expect(nextWeeklyRunInstant(new Date("2026-10-14T18:00:00Z"), NY).toISOString()).toBe("2026-10-19T13:00:00.000Z");
  });

  it("lands on 09:00 local across both DST changes", () => {
    expect(nextWeeklyRunInstant(new Date("2026-03-02T14:00:00Z"), NY).toISOString()).toBe("2026-03-09T13:00:00.000Z");
    expect(nextWeeklyRunInstant(new Date("2026-10-26T13:00:00Z"), NY).toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("score change", () => {
  it("compares against the prior snapshot and stays null without one", () => {
    const prior = new Map([["a", 88], ["b", 40]]);
    expect(scoreChangeFrom(prior, { providerId: "a", score: 100 })).toEqual({ priorWeekScore: 88, scoreChange: 12 });
    expect(scoreChangeFrom(prior, { providerId: "b", score: 31 })).toEqual({ priorWeekScore: 40, scoreChange: -9 });
    expect(scoreChangeFrom(prior, { providerId: "zzz", score: 50 })).toEqual({ priorWeekScore: null, scoreChange: null });
    expect(scoreChangeLabel(12)).toBe("+12 vs last week");
    expect(scoreChangeLabel(-9)).toBe("−9 vs last week");
    expect(scoreChangeLabel(0)).toBe("no change");
    expect(scoreChangeLabel(null)).toBe("—");
  });
});
