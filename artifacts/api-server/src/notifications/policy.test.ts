import { describe, expect, it } from "vitest";
import {
  evaluateSendPolicy,
  inQuietWindow,
  localClock,
  parseNotificationPrefs,
  quietWindowEnd,
  validateNotificationPrefsInput,
} from "./policy";

const NY = "America/New_York";

describe("notification preference parsing", () => {
  it("defaults every category on and no quiet hours", () => {
    expect(parseNotificationPrefs(null)).toEqual({
      categories: { coachOutreach: true, checkInReminders: true, officeReminders: true },
      quietHours: null,
    });
    // Legacy prefs objects from onboarding carry only reminder keys.
    expect(parseNotificationPrefs({ notifications: "enabled", reminderMorning: true }).categories.coachOutreach).toBe(true);
  });

  it("reads explicit switches and a valid window; ignores malformed ones", () => {
    const parsed = parseNotificationPrefs({
      categories: { coachOutreach: false, checkInReminders: "no" },
      quietHours: { start: "22:00", end: "07:30" },
    });
    expect(parsed.categories).toEqual({ coachOutreach: false, checkInReminders: true, officeReminders: true });
    expect(parsed.quietHours).toMatchObject({ startMinutes: 22 * 60, endMinutes: 7 * 60 + 30 });
    expect(parseNotificationPrefs({ quietHours: { start: "25:00", end: "07:00" } }).quietHours).toBeNull();
    expect(parseNotificationPrefs({ quietHours: { start: "07:00", end: "07:00" } }).quietHours).toBeNull();
    expect(parseNotificationPrefs({ quietHours: "22-7" }).quietHours).toBeNull();
  });

  it("validates the shape the account screen writes", () => {
    expect(validateNotificationPrefsInput({ categories: { coachOutreach: false } })).toBeNull();
    expect(validateNotificationPrefsInput({ quietHours: null })).toBeNull();
    expect(validateNotificationPrefsInput({ quietHours: { start: "21:00", end: "06:00" } })).toBeNull();
    expect(validateNotificationPrefsInput({ categories: { marketing: true } })).toMatch(/categories/);
    expect(validateNotificationPrefsInput({ categories: { coachOutreach: "off" } })).toMatch(/categories/);
    expect(validateNotificationPrefsInput({ quietHours: { start: "9pm", end: "06:00" } })).toMatch(/HH:MM/);
    expect(validateNotificationPrefsInput({ quietHours: { start: "06:00", end: "06:00" } })).toMatch(/different/);
  });
});

describe("quiet hours in the patient's timezone", () => {
  const quiet = { startMinutes: 22 * 60, endMinutes: 7 * 60, start: "22:00", end: "07:00" };

  it("resolves the local wall clock and offset", () => {
    // 2026-07-01T03:30Z is 23:30 the previous evening in New York (EDT, -4h).
    const clock = localClock(new Date("2026-07-01T03:30:00Z"), NY);
    expect(clock).toMatchObject({ year: 2026, month: 6, day: 30, minutes: 23 * 60 + 30, offsetMinutes: -240 });
    // Unknown zones fall back to UTC instead of throwing.
    expect(localClock(new Date("2026-07-01T03:30:00Z"), "Mars/Olympus").minutes).toBe(3 * 60 + 30);
  });

  it("handles windows that wrap midnight", () => {
    expect(inQuietWindow(23 * 60, quiet)).toBe(true);
    expect(inQuietWindow(3 * 60, quiet)).toBe(true);
    expect(inQuietWindow(7 * 60, quiet)).toBe(false);
    expect(inQuietWindow(12 * 60, quiet)).toBe(false);
    const day = { startMinutes: 13 * 60, endMinutes: 15 * 60, start: "13:00", end: "15:00" };
    expect(inQuietWindow(14 * 60, day)).toBe(true);
    expect(inQuietWindow(16 * 60, day)).toBe(false);
  });

  it("computes the window end as an instant: evening side ends tomorrow, morning side today", () => {
    // 23:30 EDT June 30 -> ends 07:00 EDT July 1 = 11:00Z.
    expect(quietWindowEnd(new Date("2026-07-01T03:30:00Z"), NY, quiet).toISOString()).toBe("2026-07-01T11:00:00.000Z");
    // 05:00 EDT July 1 (09:00Z) -> ends 07:00 EDT July 1 = 11:00Z.
    expect(quietWindowEnd(new Date("2026-07-01T09:00:00Z"), NY, quiet).toISOString()).toBe("2026-07-01T11:00:00.000Z");
    // Winter: 23:30 EST Jan 10 (04:30Z Jan 11) -> 07:00 EST Jan 11 = 12:00Z.
    expect(quietWindowEnd(new Date("2026-01-11T04:30:00Z"), NY, quiet).toISOString()).toBe("2026-01-11T12:00:00.000Z");
  });

  it("uses the offset in force at the END wall time across daylight-saving transitions", () => {
    // Spring forward (NY, 2026-03-08 02:00 EST -> 03:00 EDT): 23:00 EST Mar 7
    // -> window ends 07:00 EDT Mar 8 = 11:00Z, not 12:00Z (the at-time offset).
    expect(quietWindowEnd(new Date("2026-03-08T04:00:00Z"), NY, quiet).toISOString()).toBe("2026-03-08T11:00:00.000Z");
    // Fall back (NY, 2026-11-01 02:00 EDT -> 01:00 EST): 23:00 EDT Oct 31
    // -> window ends 07:00 EST Nov 1 = 12:00Z. The at-time offset would say
    // 11:00Z, i.e. sending at 06:00 local, still inside quiet hours.
    expect(quietWindowEnd(new Date("2026-11-01T03:00:00Z"), NY, quiet).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    // Morning side of the transition night behaves the same.
    expect(quietWindowEnd(new Date("2026-11-01T08:00:00Z"), NY, quiet).toISOString()).toBe("2026-11-01T12:00:00.000Z");
    // Nonexistent end (02:30 never happens on spring-forward night): first
    // instant after the gap, 03:00 EDT = 07:00Z.
    const gap = { startMinutes: 0, endMinutes: 2 * 60 + 30, start: "00:00", end: "02:30" };
    expect(quietWindowEnd(new Date("2026-03-08T06:00:00Z"), NY, gap).toISOString()).toBe("2026-03-08T07:00:00.000Z");
    // Ambiguous end (01:30 happens twice on fall-back night): the LATER
    // occurrence, 01:30 EST = 06:30Z, so the window is never cut short.
    const repeat = { startMinutes: 23 * 60, endMinutes: 90, start: "23:00", end: "01:30" };
    expect(quietWindowEnd(new Date("2026-11-01T04:00:00Z"), NY, repeat).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    // Southern hemisphere / half-hour zone sanity: Adelaide 22:00-07:00 on
    // its spring-forward night (2026-10-04 02:00 -> 03:00) ends 07:00 ACDT = 20:30Z Oct 3.
    expect(quietWindowEnd(new Date("2026-10-03T13:30:00Z"), "Australia/Adelaide", quiet).toISOString()).toBe("2026-10-03T20:30:00.000Z");
  });
});

describe("send policy", () => {
  const base = { prefs: null, timezone: NY, nudgeOptOut: false };
  const expires = new Date("2026-07-03T00:00:00Z");

  it("sends by default", () => {
    expect(evaluateSendPolicy({ category: "coach_outreach", context: base, now: new Date("2026-07-01T16:00:00Z"), expiresAt: expires })).toEqual({ action: "send" });
  });

  it("honors the nudge opt-out for coach outreach only", () => {
    const ctx = { ...base, nudgeOptOut: true };
    expect(evaluateSendPolicy({ category: "coach_outreach", context: ctx, now: new Date("2026-07-01T16:00:00Z"), expiresAt: expires })).toEqual({ action: "opt_out", reason: "nudge_opt_out" });
    expect(evaluateSendPolicy({ category: "office_reminders", context: ctx, now: new Date("2026-07-01T16:00:00Z"), expiresAt: expires })).toEqual({ action: "send" });
  });

  it("treats a switched-off category as opted out", () => {
    const ctx = { ...base, prefs: { categories: { officeReminders: false } } };
    expect(evaluateSendPolicy({ category: "office_reminders", context: ctx, now: new Date("2026-07-01T16:00:00Z"), expiresAt: expires })).toEqual({ action: "opt_out", reason: "category_off" });
    expect(evaluateSendPolicy({ category: "check_in_reminders", context: ctx, now: new Date("2026-07-01T16:00:00Z"), expiresAt: expires })).toEqual({ action: "send" });
  });

  it("defers inside quiet hours and suppresses when the window outlives the row", () => {
    const ctx = { ...base, prefs: { quietHours: { start: "22:00", end: "07:00" } } };
    const late = new Date("2026-07-01T03:30:00Z"); // 23:30 EDT
    const deferred = evaluateSendPolicy({ category: "coach_outreach", context: ctx, now: late, expiresAt: expires });
    expect(deferred).toMatchObject({ action: "defer", reason: "quiet_hours_deferred" });
    if (deferred.action === "defer") expect(deferred.until.toISOString()).toBe("2026-07-01T11:00:00.000Z");
    expect(
      evaluateSendPolicy({ category: "coach_outreach", context: ctx, now: late, expiresAt: new Date("2026-07-01T10:00:00Z") }),
    ).toEqual({ action: "suppress", reason: "quiet_hours" });
    expect(evaluateSendPolicy({ category: "coach_outreach", context: ctx, now: new Date("2026-07-01T16:00:00Z"), expiresAt: expires })).toEqual({ action: "send" });
  });
});
