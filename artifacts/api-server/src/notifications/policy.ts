/**
 * Send policy: the patient's notification preferences applied to one outbox
 * row right before it is sent.
 *
 * Preferences live in patient_flags.notification_prefs (the same JSON object
 * onboarding and the account screen already write). This module reads two
 * keys the mobile account screen edits:
 *
 *   categories: { coachOutreach, checkInReminders, officeReminders }  (booleans, default ON)
 *   quietHours: { start: "HH:MM", end: "HH:MM" } | null                (patient-local time)
 *
 * Everything is default-on: a patient who never opened the settings screen
 * receives every category and has no quiet hours. Coach outreach additionally
 * honors the existing nudge opt-out flag (the check-in "pause nudges" switch).
 *
 * Quiet hours DEFER rather than drop: the row is re-queued for the moment the
 * window ends in the patient's timezone. Only when that moment would be past
 * the row's expiry is it suppressed outright (a reminder for "today" has no
 * value tomorrow morning).
 */
import type { NotificationCategory, PolicyContext, SuppressionReason } from "./types";

export interface CategoryPrefs {
  coachOutreach: boolean;
  checkInReminders: boolean;
  officeReminders: boolean;
}

export interface QuietHours {
  /** Minutes after local midnight, 0..1439. */
  startMinutes: number;
  endMinutes: number;
  /** Original strings for display. */
  start: string;
  end: string;
}

export interface ParsedPrefs {
  categories: CategoryPrefs;
  quietHours: QuietHours | null;
}

const CATEGORY_KEY: Record<NotificationCategory, keyof CategoryPrefs> = {
  coach_outreach: "coachOutreach",
  check_in_reminders: "checkInReminders",
  office_reminders: "officeReminders",
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = TIME_RE.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Tolerant parse: unknown/missing keys fall back to the default-on shape. */
export function parseNotificationPrefs(raw: unknown): ParsedPrefs {
  const prefs = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawCategories =
    prefs.categories && typeof prefs.categories === "object" && !Array.isArray(prefs.categories)
      ? (prefs.categories as Record<string, unknown>)
      : {};
  const flag = (key: keyof CategoryPrefs): boolean => rawCategories[key] !== false;
  const categories: CategoryPrefs = {
    coachOutreach: flag("coachOutreach"),
    checkInReminders: flag("checkInReminders"),
    officeReminders: flag("officeReminders"),
  };
  let quietHours: QuietHours | null = null;
  const rawQuiet = prefs.quietHours;
  if (rawQuiet && typeof rawQuiet === "object" && !Array.isArray(rawQuiet)) {
    const q = rawQuiet as Record<string, unknown>;
    const startMinutes = parseClockMinutes(q.start);
    const endMinutes = parseClockMinutes(q.end);
    if (startMinutes !== null && endMinutes !== null && startMinutes !== endMinutes) {
      quietHours = {
        startMinutes,
        endMinutes,
        start: String(q.start).trim(),
        end: String(q.end).trim(),
      };
    }
  }
  return { categories, quietHours };
}

/**
 * Validates the shape the mobile account screen writes so the flags route can
 * reject garbage before it lands in the JSON column. Returns null when valid.
 */
export function validateNotificationPrefsInput(raw: Record<string, unknown>): string | null {
  if (raw.categories !== undefined) {
    if (!raw.categories || typeof raw.categories !== "object" || Array.isArray(raw.categories)) {
      return "Notification categories are invalid.";
    }
    for (const [key, value] of Object.entries(raw.categories as Record<string, unknown>)) {
      if (!["coachOutreach", "checkInReminders", "officeReminders"].includes(key)) {
        return "Notification categories are invalid.";
      }
      if (typeof value !== "boolean") return "Notification categories are invalid.";
    }
  }
  if (raw.quietHours !== undefined && raw.quietHours !== null) {
    if (typeof raw.quietHours !== "object" || Array.isArray(raw.quietHours)) {
      return "Quiet hours are invalid.";
    }
    const q = raw.quietHours as Record<string, unknown>;
    if (parseClockMinutes(q.start) === null || parseClockMinutes(q.end) === null) {
      return "Quiet hours need a start and end time (HH:MM).";
    }
    if (parseClockMinutes(q.start) === parseClockMinutes(q.end)) {
      return "Quiet hours need different start and end times.";
    }
  }
  return null;
}

// ── Timezone helpers ────────────────────────────────────────────────────────

interface LocalClock {
  year: number;
  month: number;
  day: number;
  minutes: number;
  /** Offset of the zone from UTC at `at`, in minutes (New York in summer: -240). */
  offsetMinutes: number;
}

function safeTimeZone(timeZone: string | null | undefined): string {
  if (typeof timeZone === "string" && timeZone.trim().length > 0) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      // fall through to UTC
    }
  }
  return "UTC";
}

export function localClock(at: Date, timeZone: string | null | undefined): LocalClock {
  const zone = safeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  // Offset = local wall clock (as if UTC) minus the true instant, in minutes.
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, at.getUTCSeconds(), at.getUTCMilliseconds());
  const offsetMinutes = Math.round((asUtc - at.getTime()) / 60_000);
  return { year, month, day, minutes: hour * 60 + minute, offsetMinutes };
}

/** True when `minutes` lies in the [start, end) window (wrapping midnight). */
export function inQuietWindow(minutes: number, quiet: QuietHours): boolean {
  if (quiet.startMinutes < quiet.endMinutes) {
    return minutes >= quiet.startMinutes && minutes < quiet.endMinutes;
  }
  // Wraps midnight, e.g. 22:00 -> 07:00.
  return minutes >= quiet.startMinutes || minutes < quiet.endMinutes;
}

/** Wall clock of a LocalClock as a comparable UTC-encoded stamp. */
function wallStamp(clock: LocalClock): number {
  return Date.UTC(clock.year, clock.month - 1, clock.day) + clock.minutes * 60_000;
}

/**
 * The instant the current quiet window ends, given `at` is inside it.
 *
 * The end is a LOCAL wall-clock time, so its UTC instant must use the zone
 * offset in force AT THAT WALL TIME, not at `at`: a 22:00-07:00 window that
 * spans a daylight-saving change would otherwise end an hour late (spring)
 * or, worse, an hour early (fall) while the patient is still inside it.
 * Nonexistent wall times (spring-forward gap) resolve to the first instant
 * after the gap; ambiguous ones (fall-back repeat) resolve to the later
 * occurrence, so the window is never cut short.
 */
export function quietWindowEnd(at: Date, timeZone: string | null | undefined, quiet: QuietHours): Date {
  const clock = localClock(at, timeZone);
  // End falls on the same local day unless the window wraps and we're past
  // the start (evening side), in which case it ends tomorrow.
  const endsTomorrow = quiet.startMinutes > quiet.endMinutes && clock.minutes >= quiet.startMinutes;
  const dayOffset = endsTomorrow ? 1 : 0;
  const localEnd = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day + dayOffset,
    Math.floor(quiet.endMinutes / 60),
    quiet.endMinutes % 60,
  );
  const guess = new Date(localEnd - clock.offsetMinutes * 60_000);
  // Candidate offsets: the one at `at`, the one at the first guess, and the
  // ones a day either side of it (covers every DST transition shape).
  const offsets = new Set<number>([clock.offsetMinutes]);
  for (const probe of [guess, new Date(guess.getTime() - 86_400_000), new Date(guess.getTime() + 86_400_000)]) {
    offsets.add(localClock(probe, timeZone).offsetMinutes);
  }
  const exact: number[] = [];
  const after: number[] = [];
  const before: number[] = [];
  for (const offset of offsets) {
    const candidate = localEnd - offset * 60_000;
    const wall = wallStamp(localClock(new Date(candidate), timeZone));
    if (wall === localEnd) exact.push(candidate);
    else if (wall > localEnd) after.push(candidate);
    else before.push(candidate);
  }
  if (exact.length > 0) return new Date(Math.max(...exact));
  if (after.length === 0) return guess;
  // The wall time never happens (spring-forward gap): the clock jumps over it
  // somewhere between the last instant still before it and the first after.
  // Bisect to the minute for the first instant whose wall clock has passed it.
  let hi = Math.min(...after);
  if (before.length === 0) return new Date(hi);
  let lo = Math.max(...before);
  while (hi - lo > 60_000) {
    const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
    if (wallStamp(localClock(new Date(mid), timeZone)) >= localEnd) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

// ── The decision ────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { action: "send" }
  | { action: "defer"; until: Date; reason: SuppressionReason }
  | { action: "suppress"; reason: SuppressionReason }
  | { action: "opt_out"; reason: SuppressionReason };

export function evaluateSendPolicy(input: {
  category: NotificationCategory;
  context: PolicyContext;
  now: Date;
  expiresAt: Date;
}): PolicyDecision {
  const parsed = parseNotificationPrefs(input.context.prefs);
  if (input.category === "coach_outreach" && input.context.nudgeOptOut) {
    return { action: "opt_out", reason: "nudge_opt_out" };
  }
  if (!parsed.categories[CATEGORY_KEY[input.category]]) {
    return { action: "opt_out", reason: "category_off" };
  }
  if (parsed.quietHours) {
    const clock = localClock(input.now, input.context.timezone);
    if (inQuietWindow(clock.minutes, parsed.quietHours)) {
      const until = quietWindowEnd(input.now, input.context.timezone, parsed.quietHours);
      if (until.getTime() >= input.expiresAt.getTime()) {
        return { action: "suppress", reason: "quiet_hours" };
      }
      return { action: "defer", until, reason: "quiet_hours_deferred" };
    }
  }
  return { action: "send" };
}
