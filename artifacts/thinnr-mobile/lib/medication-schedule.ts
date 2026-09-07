/**
 * Medication schedule core — shared by the API, the patient app, and the
 * operations web app.
 *
 * ONE definition of "when is a dose due" and "what state is that dose in"
 * lives here so the reminder the phone fires, the missed-dose backup the
 * server enqueues, and the adherence view the office reads all agree. The
 * three copies of this file must stay byte-identical; the API test-suite
 * (medication-schedule-parity.test.ts) fails when they drift.
 *
 * Rules:
 *  - Schedule times are the patient's LOCAL wall clock ("HH:MM", 24 h). A
 *    dose occurrence is identified by (medicationId, local due date, local
 *    due time); its instant is resolved against an IANA timezone with the
 *    zone offset in force AT THAT WALL TIME, so daylight-saving changes
 *    move the instant, never the wall clock the patient expects.
 *  - Daily schedules fire every day from startDate through stopDate
 *    (inclusive); weekly schedules fire on `weekday` (0 = Sunday) only.
 *  - A dose with no log is "upcoming" before its due time, "due" from its
 *    due time until the grace window closes, and "missed" after that. A
 *    logged dose is "taken" or "skipped" regardless of timing.
 *  - Adherence over a window counts every occurrence whose due instant has
 *    passed: rate = taken / (taken + skipped + missed), null when nothing
 *    has come due yet. Skipped is honest non-adherence, not a free pass.
 *
 * No imports: this file must load in Node, Metro, and Vite unchanged.
 */

export const MEDICATION_FORMS = ["tablet", "capsule", "drops", "injection", "liquid", "other"] as const;
export type MedicationForm = (typeof MEDICATION_FORMS)[number];

export const MEDICATION_FORM_LABELS: Record<MedicationForm, string> = {
  tablet: "Tablet",
  capsule: "Capsule",
  drops: "Drops",
  injection: "Injection",
  liquid: "Liquid",
  other: "Other",
};

export type MedicationScheduleKind = "daily" | "weekly";
export type MedicationSource = "onboarding" | "patient" | "office";
export type DoseLogStatus = "taken" | "skipped";
export type DoseLogSource = "reminder" | "check_in" | "account" | "office";

/** Sunday-first, matching JavaScript's Date#getDay(). */
export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export const MAX_DOSE_TIMES_PER_DAY = 6;
/** Late entries and corrections are accepted this many days back. */
export const DOSE_CORRECTION_WINDOW_DAYS = 7;
/** Minutes after the due time before an unlogged dose counts as missed. */
export const DEFAULT_MISSED_GRACE_MINUTES = 60;

export interface MedicationRecord {
  id: string;
  name: string;
  form: MedicationForm;
  /** Free text, e.g. "1 mL under the tongue" or "0.5 mg". */
  dose: string | null;
  scheduleKind: MedicationScheduleKind;
  /** Local "HH:MM" times, ascending, deduplicated. */
  times: string[];
  /** 0 = Sunday … 6 = Saturday; only for weekly schedules. */
  weekday: number | null;
  notes: string | null;
  /** YYYY-MM-DD, patient-local. */
  startDate: string;
  /** YYYY-MM-DD inclusive, or null while active. */
  stopDate: string | null;
  source: MedicationSource;
  /** Record version for optimistic office edits (the updated_at echo). */
  version: string | null;
}

export interface DoseLogRecord {
  id: string;
  medicationId: string;
  dueDate: string;
  dueTime: string;
  status: DoseLogStatus;
  source: DoseLogSource;
  loggedAt: string;
}

export interface DoseOccurrence {
  /** `${medicationId}:${dueDate}:${dueTime}` — stable across devices. */
  key: string;
  medicationId: string;
  dueDate: string;
  dueTime: string;
  /** ISO instant of the local due time in the given timezone. */
  dueAt: string;
}

export type DoseState = "upcoming" | "due" | "missed" | "taken" | "skipped";

export interface DoseStatus extends DoseOccurrence {
  state: DoseState;
  log: DoseLogRecord | null;
}

export interface AdherenceDay {
  dateKey: string;
  due: number;
  taken: number;
  skipped: number;
  missed: number;
}

export interface AdherenceSummary {
  fromDate: string;
  toDate: string;
  /** Occurrences whose due instant has passed (taken + skipped + missed). */
  due: number;
  taken: number;
  skipped: number;
  missed: number;
  /** round(100 * taken / due), null when nothing has come due. */
  rate: number | null;
  days: AdherenceDay[];
}

// ── Calendar helpers ────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

export function dayNumber(dateKey: string): number {
  return Math.floor(Date.parse(`${dateKey}T00:00:00Z`) / DAY_MS);
}

export function shiftDateKey(dateKey: string, days: number): string {
  return new Date((dayNumber(dateKey) + days) * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday for a calendar date (zone-independent). */
export function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function safeTimeZone(timeZone: string | null | undefined): string {
  if (typeof timeZone === "string" && timeZone.trim().length > 0) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      // fall through
    }
  }
  return "UTC";
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Zone offset from UTC in minutes at the instant (New York summer: -240). */
  offsetMinutes: number;
}

function wallClockAt(at: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, at.getUTCSeconds(), at.getUTCMilliseconds());
  return { year, month, day, hour, minute, offsetMinutes: Math.round((asUtc - at.getTime()) / 60_000) };
}

/** The patient-local calendar day at `at`. */
export function localDateKey(at: Date, timeZone: string | null | undefined): string {
  const clock = wallClockAt(at, safeTimeZone(timeZone));
  return `${clock.year}-${String(clock.month).padStart(2, "0")}-${String(clock.day).padStart(2, "0")}`;
}

/** Local "HH:MM" at `at`. */
export function localClockTime(at: Date, timeZone: string | null | undefined): string {
  const clock = wallClockAt(at, safeTimeZone(timeZone));
  return `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

/**
 * The instant of a local wall time in a zone. Uses the offset in force AT
 * that wall time. A wall time skipped by a spring-forward gap is shifted
 * forward by the gap (02:30 becomes 03:30 local); a wall time repeated by a
 * fall-back resolves to its first occurrence.
 */
export function zonedInstant(dateKey: string, time: string, timeZone: string | null | undefined): Date {
  const zone = safeTimeZone(timeZone);
  const [hour, minute] = time.split(":").map(Number);
  const wallUtc = Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)), hour, minute);
  const firstOffset = wallClockAt(new Date(wallUtc), zone).offsetMinutes;
  const first = wallUtc - firstOffset * 60_000;
  const secondOffset = wallClockAt(new Date(first), zone).offsetMinutes;
  if (secondOffset === firstOffset) return new Date(first);
  const second = wallUtc - secondOffset * 60_000;
  const thirdOffset = wallClockAt(new Date(second), zone).offsetMinutes;
  if (thirdOffset === secondOffset) {
    // Both candidates might be valid (fall-back repeat): keep the earlier.
    const firstValid = wallClockAt(new Date(first), zone).offsetMinutes === firstOffset;
    return new Date(firstValid ? Math.min(first, second) : second);
  }
  // Neither offset reproduces the wall time: the clock skipped it. Shift
  // forward by the gap (the later candidate), like the patient's own clock.
  return new Date(Math.max(first, second));
}

// ── Schedules ───────────────────────────────────────────────────────────────

export function isActiveOn(medication: Pick<MedicationRecord, "startDate" | "stopDate">, dateKey: string): boolean {
  if (dateKey < medication.startDate) return false;
  if (medication.stopDate && dateKey > medication.stopDate) return false;
  return true;
}

export function isScheduledOn(
  medication: Pick<MedicationRecord, "startDate" | "stopDate" | "scheduleKind" | "weekday">,
  dateKey: string,
): boolean {
  if (!isActiveOn(medication, dateKey)) return false;
  if (medication.scheduleKind === "weekly") return medication.weekday === weekdayOf(dateKey);
  return true;
}

export function occurrenceKey(medicationId: string, dueDate: string, dueTime: string): string {
  return `${medicationId}:${dueDate}:${dueTime}`;
}

export function occurrencesOn(medication: MedicationRecord, dateKey: string, timeZone: string | null | undefined): DoseOccurrence[] {
  if (!isScheduledOn(medication, dateKey)) return [];
  return normalizeTimes(medication.times).map((dueTime) => ({
    key: occurrenceKey(medication.id, dateKey, dueTime),
    medicationId: medication.id,
    dueDate: dateKey,
    dueTime,
    dueAt: zonedInstant(dateKey, dueTime, timeZone).toISOString(),
  }));
}

/** Every occurrence from `fromDate` through `toDate` (inclusive, local days). */
export function occurrencesBetween(
  medications: readonly MedicationRecord[],
  fromDate: string,
  toDate: string,
  timeZone: string | null | undefined,
): DoseOccurrence[] {
  const out: DoseOccurrence[] = [];
  if (toDate < fromDate) return out;
  for (let day = fromDate; day <= toDate; day = shiftDateKey(day, 1)) {
    for (const medication of medications) out.push(...occurrencesOn(medication, day, timeZone));
  }
  out.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/** Ascending, deduplicated, valid times only. */
export function normalizeTimes(times: readonly string[]): string[] {
  return [...new Set(times.filter(isClockTime))].sort();
}

// ── Dose state ──────────────────────────────────────────────────────────────

export function doseStateFor(
  occurrence: DoseOccurrence,
  log: DoseLogRecord | null | undefined,
  now: Date,
  graceMinutes: number = DEFAULT_MISSED_GRACE_MINUTES,
): DoseState {
  if (log) return log.status;
  const dueAt = Date.parse(occurrence.dueAt);
  if (now.getTime() < dueAt) return "upcoming";
  if (now.getTime() < dueAt + graceMinutes * 60_000) return "due";
  return "missed";
}

export function indexLogs(logs: readonly DoseLogRecord[]): Map<string, DoseLogRecord> {
  const map = new Map<string, DoseLogRecord>();
  for (const log of logs) map.set(occurrenceKey(log.medicationId, log.dueDate, log.dueTime), log);
  return map;
}

/** Occurrences in the window with their current state, sorted by due instant. */
export function doseStatuses(
  medications: readonly MedicationRecord[],
  logs: readonly DoseLogRecord[],
  fromDate: string,
  toDate: string,
  timeZone: string | null | undefined,
  now: Date,
  graceMinutes: number = DEFAULT_MISSED_GRACE_MINUTES,
): DoseStatus[] {
  const byKey = indexLogs(logs);
  return occurrencesBetween(medications, fromDate, toDate, timeZone).map((occurrence) => {
    const log = byKey.get(occurrence.key) ?? null;
    return { ...occurrence, log, state: doseStateFor(occurrence, log, now, graceMinutes) };
  });
}

export function adherenceSummary(
  medications: readonly MedicationRecord[],
  logs: readonly DoseLogRecord[],
  fromDate: string,
  toDate: string,
  timeZone: string | null | undefined,
  now: Date,
  graceMinutes: number = DEFAULT_MISSED_GRACE_MINUTES,
): AdherenceSummary {
  const days = new Map<string, AdherenceDay>();
  if (toDate >= fromDate) {
    for (let day = fromDate; day <= toDate; day = shiftDateKey(day, 1)) {
      days.set(day, { dateKey: day, due: 0, taken: 0, skipped: 0, missed: 0 });
    }
  }
  let taken = 0;
  let skipped = 0;
  let missed = 0;
  for (const status of doseStatuses(medications, logs, fromDate, toDate, timeZone, now, graceMinutes)) {
    const day = days.get(status.dueDate);
    if (!day) continue;
    if (status.state === "taken") { taken += 1; day.taken += 1; day.due += 1; }
    else if (status.state === "skipped") { skipped += 1; day.skipped += 1; day.due += 1; }
    else if (status.state === "missed") { missed += 1; day.missed += 1; day.due += 1; }
    // "due" (inside grace) and "upcoming" are not counted against anyone yet.
  }
  const due = taken + skipped + missed;
  return {
    fromDate,
    toDate,
    due,
    taken,
    skipped,
    missed,
    rate: due > 0 ? Math.round((100 * taken) / due) : null,
    days: [...days.values()],
  };
}

/** True when a (dueDate) is inside the correction window ending on `today`. */
export function withinCorrectionWindow(dueDate: string, today: string, windowDays: number = DOSE_CORRECTION_WINDOW_DAYS): boolean {
  return dueDate <= today && dueDate >= shiftDateKey(today, -windowDays);
}

// ── Presentation helpers ────────────────────────────────────────────────────

/** "8:00 AM" from "08:00". */
export function formatClockTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "08:00" from "8:00 AM" (null when unparseable). */
export function parseClockLabel(value: string): string | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$/i.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
  if (hour === 12) hour = 0;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "Daily at 8:00 AM, 3:00 PM, 10:00 PM" / "Weekly on Monday at 9:00 AM". */
export function describeSchedule(medication: Pick<MedicationRecord, "scheduleKind" | "times" | "weekday">): string {
  const times = normalizeTimes(medication.times).map(formatClockTime).join(", ");
  if (medication.scheduleKind === "weekly") {
    const day = medication.weekday !== null && medication.weekday >= 0 && medication.weekday <= 6 ? WEEKDAY_LABELS[medication.weekday] : "one day";
    return `Weekly on ${day} at ${times}`;
  }
  return `Daily at ${times}`;
}

/** "Protocol drops · 1 mL under the tongue" (dose omitted when blank). */
export function medicationLine(medication: Pick<MedicationRecord, "name" | "dose">): string {
  return medication.dose ? `${medication.name} · ${medication.dose}` : medication.name;
}

// ── Validation ──────────────────────────────────────────────────────────────

export interface MedicationInput {
  id: string;
  name: string;
  form: MedicationForm;
  dose: string | null;
  scheduleKind: MedicationScheduleKind;
  times: string[];
  weekday: number | null;
  notes: string | null;
  startDate: string;
  stopDate: string | null;
}

export type MedicationValidation = { ok: true; value: MedicationInput } | { ok: false; error: string; field: string };

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return undefined;
  return trimmed;
}

/** Shape-checks one medication; the same rules run on the phone and the API. */
export function validateMedicationInput(raw: unknown): MedicationValidation {
  const bad = (error: string, field: string): MedicationValidation => ({ ok: false, error, field });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("Medication is invalid.", "medication");
  const input = raw as Record<string, unknown>;
  if (typeof input.id !== "string" || !ID_RE.test(input.id)) return bad("Medication id is invalid.", "id");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 1 || name.length > 120) return bad("Enter a medication name (up to 120 characters).", "name");
  if (!(MEDICATION_FORMS as readonly unknown[]).includes(input.form)) return bad("Choose a medication form.", "form");
  const dose = optionalText(input.dose, 80);
  if (dose === undefined) return bad("Dose must be 80 characters or fewer.", "dose");
  const notes = optionalText(input.notes, 500);
  if (notes === undefined) return bad("Notes must be 500 characters or fewer.", "notes");
  if (input.scheduleKind !== "daily" && input.scheduleKind !== "weekly") return bad("Choose daily or weekly.", "scheduleKind");
  const rawTimes = Array.isArray(input.times) ? input.times : [];
  if (rawTimes.length === 0 || rawTimes.some((t) => !isClockTime(t))) return bad("Add at least one reminder time.", "times");
  const times = normalizeTimes(rawTimes as string[]);
  if (times.length > MAX_DOSE_TIMES_PER_DAY) return bad(`Up to ${MAX_DOSE_TIMES_PER_DAY} times a day.`, "times");
  let weekday: number | null = null;
  if (input.scheduleKind === "weekly") {
    if (typeof input.weekday !== "number" || !Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) {
      return bad("Choose the day of the week.", "weekday");
    }
    weekday = input.weekday;
  } else if (input.weekday !== undefined && input.weekday !== null) {
    return bad("Daily schedules don't take a weekday.", "weekday");
  }
  if (!isDateKey(input.startDate)) return bad("Start date is invalid.", "startDate");
  let stopDate: string | null = null;
  if (input.stopDate !== undefined && input.stopDate !== null) {
    if (!isDateKey(input.stopDate)) return bad("Stop date is invalid.", "stopDate");
    if (input.stopDate < input.startDate) return bad("Stop date can't be before the start date.", "stopDate");
    stopDate = input.stopDate;
  }
  return {
    ok: true,
    value: { id: input.id, name, form: input.form as MedicationForm, dose, scheduleKind: input.scheduleKind, times, weekday, notes, startDate: input.startDate, stopDate },
  };
}

// ── Onboarding seeds ────────────────────────────────────────────────────────

export interface SeedContext {
  /** 'thinnr' | 'glp1' | anything else = no seed. */
  programId: string | null | undefined;
  startDate: string;
  /** Local "HH:MM" times for the three protocol doses (defaults 08:00/15:00/22:00). */
  dailyTimes?: string[] | null;
  /** 0-6 for the GLP-1 injection day; null skips the weekly seed. */
  injectionWeekday?: number | null;
  /** Local "HH:MM" for the injection reminder (default 09:00). */
  injectionTime?: string | null;
}

export const PROTOCOL_DEFAULT_TIMES = ["08:00", "15:00", "22:00"];
export const INJECTION_DEFAULT_TIME = "09:00";

/** The medications a program choice implies; empty for "no program yet". */
export function seedMedicationsFor(context: SeedContext, makeId: () => string): MedicationInput[] {
  if (context.programId === "thinnr") {
    const times = normalizeTimes(context.dailyTimes ?? []);
    return [{
      id: makeId(),
      name: "THINNR Protocol drops",
      form: "drops",
      dose: "1 mL under the tongue",
      scheduleKind: "daily",
      times: times.length > 0 ? times : PROTOCOL_DEFAULT_TIMES,
      weekday: null,
      notes: "Shake the bottle, then hold the dose under your tongue. Space doses about 7 hours apart.",
      startDate: context.startDate,
      stopDate: null,
    }];
  }
  if (context.programId === "glp1") {
    const weekday = context.injectionWeekday;
    if (typeof weekday !== "number" || weekday < 0 || weekday > 6) return [];
    const time = isClockTime(context.injectionTime) ? context.injectionTime : INJECTION_DEFAULT_TIME;
    return [{
      id: makeId(),
      name: "GLP-1 injection",
      form: "injection",
      dose: null,
      scheduleKind: "weekly",
      times: [time],
      weekday,
      notes: "Dose as prescribed by your provider.",
      startDate: context.startDate,
      stopDate: null,
    }];
  }
  return [];
}
