/**
 * The weekly Customer health run's calendar rules — pure, so the due rule can
 * be unit-tested across DST changes without a clock or a database.
 *
 * Everything is reckoned on the organization's default time zone wall clock
 * (Eastern for THINNR): the run is due once that clock reads Monday 09:00 or
 * later, and "this week" is the ISO week of that local date. The snapshot
 * tables and the email dedupe key share the ISO week label, so a restart or
 * a second tick on the same Monday cannot produce a second run or email.
 */
import { localClock } from "../notifications/policy";
import type { OfficeHealth } from "./scoring";

export const WEEKLY_SEND_MINUTES = 9 * 60;
const DAY_MS = 86_400_000;

/** ISO 8601 week label (`2026-W41`) for a calendar date; weeks start Monday. */
export function isoWeekOf(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  // Thursday of the same ISO week decides the week-numbering year.
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The Monday (UTC-encoded calendar date) an ISO week label starts on. */
export function isoWeekMonday(isoWeek: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek);
  if (!match) throw new Error(`Not an ISO week label: ${isoWeek}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  // ISO week 1 contains January 4th.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = jan4.getUTCDay() || 7;
  const week1Monday = jan4.getTime() - (jan4Weekday - 1) * DAY_MS;
  return new Date(week1Monday + (week - 1) * 7 * DAY_MS);
}

export function previousIsoWeek(isoWeek: string): string {
  const monday = isoWeekMonday(isoWeek);
  const previous = new Date(monday.getTime() - 7 * DAY_MS);
  return isoWeekOf(previous.getUTCFullYear(), previous.getUTCMonth() + 1, previous.getUTCDate());
}

export interface WeeklyRunMoment {
  /** The organization-local date the ISO week was reckoned from. */
  localDate: string;
  isoWeek: string;
  /** Monday of that ISO week, as a calendar date. */
  weekMonday: string;
  weekday: number;
  minutes: number;
  /** True once the local wall clock reads Monday at or after 09:00. */
  due: boolean;
}

/** Where `now` falls on the organization's calendar and whether the Monday run is due. */
export function weeklyRunMoment(now: Date, timeZone: string): WeeklyRunMoment {
  const clock = localClock(now, timeZone);
  const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
  const isoWeek = isoWeekOf(clock.year, clock.month, clock.day);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    localDate: `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`,
    isoWeek,
    weekMonday: isoWeekMonday(isoWeek).toISOString().slice(0, 10),
    weekday,
    minutes: clock.minutes,
    due: weekday === 1 && clock.minutes >= WEEKLY_SEND_MINUTES,
  };
}

/** Human label for the Monday a week's summary covers ("Monday, October 12, 2026"). */
export function weekMondayLabel(isoWeek: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(isoWeekMonday(isoWeek));
}

/**
 * Queued emails stop being worth sending once the following Monday's run
 * can replace them: the row expires at the next Monday 09:00 in the
 * organization's zone (found by walking the wall clock, so DST weeks are
 * right too).
 */
export function nextWeeklyRunInstant(now: Date, timeZone: string): Date {
  const start = weeklyRunMoment(now, timeZone);
  let probe = new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000);
  for (let guard = 0; guard < 9 * 24 * 60; guard++) {
    const moment = weeklyRunMoment(probe, timeZone);
    // The Monday morning already under way does not count: its run is this one.
    if (moment.due && (!start.due || moment.localDate !== start.localDate)) return probe;
    // Hour steps far from the target, minute steps once Monday 07:30 local has passed.
    const step = moment.weekday === 1 && moment.minutes >= WEEKLY_SEND_MINUTES - 90 ? 60_000 : 60 * 60_000;
    probe = new Date(probe.getTime() + step);
  }
  throw new Error("could not find the next weekly run instant");
}

/** Signed change in score against a prior-week snapshot; null when there is none. */
export function scoreChangeFrom(prior: Map<string, number>, office: Pick<OfficeHealth, "providerId" | "score">): { priorWeekScore: number | null; scoreChange: number | null } {
  const priorScore = prior.get(office.providerId);
  if (priorScore === undefined || !Number.isFinite(priorScore)) return { priorWeekScore: null, scoreChange: null };
  return { priorWeekScore: priorScore, scoreChange: office.score - priorScore };
}

/** "−12 vs last week", "+4 vs last week", "no change", or "—" before a prior snapshot exists. */
export function scoreChangeLabel(change: number | null): string {
  if (change === null) return "—";
  if (change === 0) return "no change";
  return `${change > 0 ? "+" : "−"}${Math.abs(change)} vs last week`;
}
