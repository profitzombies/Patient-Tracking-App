/**
 * Simulated new-patient onboarding: answer model, step flow, and helpers.
 *
 * Field-for-field this mirrors the clinic's real signup flow (20 reference
 * screenshots), restyled to Cobalt Ledger. Everything is mock: verification
 * and provider codes are fixed, nothing persists, and all dates derive from
 * the shared demo anchor date — never the device clock.
 */
import { normalizePhone } from '../lib/phone';
import { addDays, formatDateKey, toDateKey, TODAY } from './patient-data';
import {
  derivePhase,
  DIET_BY_SLUG,
  unansweredQuestions,
  type ActivityLevel,
  type ScreeningAnswer,
  type ScreeningQuestion,
} from '../lib/diet-fit';

// ─── Mock codes ──────────────────────────────────────────────────────────────

export const MOCK_VERIFICATION_CODE = '123456';
export const MOCK_PROVIDER_CODE = '123456';

// ─── Answer model ────────────────────────────────────────────────────────────

export type ContactMethod = 'phone' | 'email';
export type HeightUnit = 'imperial' | 'metric';
export type ProgramChoice = 'thinnr' | 'glp1' | 'none';
export type Gender = 'male' | 'female';
export type YesNo = 'yes' | 'no';
export type ReminderSlot = 'morning' | 'afternoon' | 'evening';

export interface OnboardingAnswers {
  name: string;
  email: string;
  phone: string;
  contactMethod: ContactMethod;
  contactValue: string;
  verified: boolean;
  providerLinked: boolean;
  faceId: 'enabled' | 'skipped' | null;
  heightUnit: HeightUnit;
  heightFt: number;
  heightIn: number;
  heightCm: number;
  currentWeight: string; // raw input, unit follows heightUnit (lb / kg)
  gender: Gender | null;
  birthMonth: number | null; // 1-12
  birthDay: string;
  birthYear: string;
  program: ProgramChoice | null;
  started: YesNo | null;
  startOffsetDays: number; // days after the demo anchor date
  /** Canonical local calendar date used by real accounts. */
  programStartDate: string;
  goalWeight: string;
  healthApp: 'connected' | 'skipped' | null;
  notifications: 'enabled' | 'later' | null;
  reminderMorning: string;
  reminderAfternoon: string;
  reminderEvening: string;
  /** GLP-1 only: weekly injection day (0 = Sunday … 6 = Saturday) and clock label. */
  injectionDay: number | null;
  injectionTime: string;
  /** Diet framework picked at the end of onboarding (null = not picked / picker locked). */
  dietSlug: string | null;
  /** Safety-screening answers the chosen diet asked for. */
  dietAnswers: Partial<Record<ScreeningQuestion, ScreeningAnswer>>;
  /** Intermittent fasting preset id + eating-window start, Whole30 start day. */
  fastingPreset: string | null;
  fastingStart: string;
  whole30StartDate: string;
  activityLevel: ActivityLevel | null;
  /** Allergies are required: either at least one item or an explicit "None". */
  allergiesNone: boolean;
  allergies: PreferenceAnswer[];
  sensitivities: PreferenceAnswer[];
  restrictions: PreferenceAnswer[];
  dislikes: PreferenceAnswer[];
}

/** One list item answered during onboarding; custom items carry only a label. */
export interface PreferenceAnswer {
  key: string | null;
  label: string;
  severity?: 'mild' | 'severe';
}

export const PREFERENCE_ANSWER_KEYS = ['allergies', 'sensitivities', 'restrictions', 'dislikes'] as const;
export type PreferenceAnswerKey = (typeof PREFERENCE_ANSWER_KEYS)[number];

/** Custom list entries carry no catalog key; they are tagged as the patient's own words. */
export function customPreferenceLabel(raw: string): string | null {
  const label = raw.trim().replace(/\s+/g, ' ');
  return label.length === 0 ? null : label.slice(0, 80);
}

export function samePreference(a: PreferenceAnswer, b: PreferenceAnswer): boolean {
  if (a.key && b.key) return a.key === b.key;
  return !a.key && !b.key && a.label.trim().toLowerCase() === b.label.trim().toLowerCase();
}

export const DEFAULT_ANSWERS: OnboardingAnswers = {
  name: '',
  email: '',
  phone: '',
  contactMethod: 'phone',
  contactValue: '',
  verified: false,
  providerLinked: false,
  faceId: null,
  heightUnit: 'imperial',
  heightFt: 5,
  heightIn: 6,
  heightCm: 168,
  currentWeight: '',
  gender: null,
  birthMonth: null,
  birthDay: '',
  birthYear: '',
  program: null,
  started: null,
  startOffsetDays: 0,
  programStartDate: '',
  goalWeight: '',
  healthApp: null,
  notifications: null,
  reminderMorning: '8:00 AM',
  reminderAfternoon: '3:00 PM',
  reminderEvening: '10:00 PM',
  injectionDay: null,
  injectionTime: '9:00 AM',
  dietSlug: null,
  dietAnswers: {},
  fastingPreset: null,
  fastingStart: '12:00',
  whole30StartDate: '',
  activityLevel: null,
  allergiesNone: false,
  allergies: [],
  sensitivities: [],
  restrictions: [],
  dislikes: [],
};

// ─── Step flow ───────────────────────────────────────────────────────────────

export type StepKey =
  | 'welcome'
  | 'identity'
  | 'contact'
  | 'verify'
  | 'provider-code'
  | 'face-id'
  | 'password'
  | 'height'
  | 'weight'
  | 'gender'
  | 'birthday'
  | 'program'
  | 'started'
  | 'start-date'
  | 'goal-weight'
  | 'health-app'
  | 'notifications'
  | 'injection-day'
  | 'reminder-morning'
  | 'reminder-afternoon'
  | 'reminder-evening'
  | 'diet'
  | 'allergies'
  | 'restrictions'
  | 'dislikes'
  | 'complete';

const onMedication = (a: OnboardingAnswers): boolean =>
  a.program === 'thinnr' || a.program === 'glp1';
const onProtocol = (a: OnboardingAnswers): boolean => a.program === 'thinnr';
const onInjection = (a: OnboardingAnswers): boolean => a.program === 'glp1';

interface StepDef {
  key: StepKey;
  when?: (a: OnboardingAnswers) => boolean;
}

export const STEP_FLOW: StepDef[] = [
  { key: 'welcome' },
  { key: 'identity' },
  { key: 'contact' },
  { key: 'verify' },
  { key: 'provider-code' },
  { key: 'face-id' },
  { key: 'password' },
  { key: 'height' },
  { key: 'weight' },
  { key: 'gender' },
  { key: 'birthday' },
  { key: 'program' },
  { key: 'started', when: onMedication },
  // Real accounts always confirm the authoritative start date; visibleSteps
  // preserves the demo's original "not yet" branch.
  { key: 'start-date', when: onMedication },
  { key: 'goal-weight' },
  { key: 'health-app' },
  { key: 'notifications' },
  // Weekly injections ask for the day; the daily protocol asks for its
  // three dose times. Both seed the account's medication list at completion.
  { key: 'injection-day', when: onInjection },
  { key: 'reminder-morning', when: onProtocol },
  { key: 'reminder-afternoon', when: onProtocol },
  { key: 'reminder-evening', when: onProtocol },
  // Diet, then the four preference lists — in the slot the old single diet
  // step held, right before completion (owner decision 2026-10-09).
  { key: 'diet' },
  { key: 'allergies' },
  { key: 'restrictions' },
  { key: 'dislikes' },
  { key: 'complete' },
];

export function visibleSteps(a: OnboardingAnswers, realAccount = false): StepKey[] {
  const accountSetup = new Set<StepKey>(['contact', 'verify', 'provider-code', 'face-id', 'password']);
  return STEP_FLOW.filter(
    s =>
      (realAccount ? !accountSetup.has(s.key) : s.key !== 'identity') &&
      (s.key !== 'start-date' ||
        (realAccount ? onMedication(a) : onMedication(a) && a.started === 'no')) &&
      (!s.when || s.when(a)),
  ).map(s => s.key);
}

/** Position of a step in the full (unconditional) flow order. */
export function stepOrderIndex(key: StepKey): number {
  return STEP_FLOW.findIndex(s => s.key === key);
}

/**
 * A step may only render when it is visible for the current answers AND not
 * beyond the furthest step the user has legitimately reached — blocks both
 * deep links that skip ahead and stale history entries for steps hidden by a
 * later answer change (e.g. switching program to "none" after picking a
 * start date).
 */
export function isStepAccessible(a: OnboardingAnswers, furthest: StepKey, key: StepKey, realAccount = false): boolean {
  return visibleSteps(a, realAccount).includes(key) && stepOrderIndex(key) <= stepOrderIndex(furthest);
}

/** Where to send a guarded-off route: the latest visible step not beyond `furthest`. */
export function guardTarget(a: OnboardingAnswers, furthest: StepKey, realAccount = false): StepKey {
  const limit = stepOrderIndex(furthest);
  const visible = visibleSteps(a, realAccount);
  for (let i = visible.length - 1; i >= 0; i--) {
    if (stepOrderIndex(visible[i]) <= limit) return visible[i];
  }
  return 'welcome';
}

// ─── Password rules ──────────────────────────────────────────────────────────

// Mirrors the claim-account flow's canonical rule set (8+ chars, upper,
// lower, symbol) so every surface that teaches password rules teaches the
// same ones.
export interface PasswordChecks {
  length: boolean;
  upper: boolean;
  lower: boolean;
  symbol: boolean;
}

export function passwordChecks(pw: string): PasswordChecks {
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    symbol: /[^A-Za-z0-9]/.test(pw),
  };
}

export function allPasswordChecksPass(pw: string): boolean {
  const c = passwordChecks(pw);
  return c.length && c.upper && c.lower && c.symbol;
}

/** Mirrors the real flow's "this password cannot be used" security rejection. */
export function isBlockedPassword(pw: string): boolean {
  const lower = pw.toLowerCase();
  return ['password', '123456', 'qwerty', 'letmein', 'abc123'].some(c => lower.includes(c));
}

// ─── Contact helpers ─────────────────────────────────────────────────────────

export function isValidContact(method: ContactMethod, value: string): boolean {
  if (method === 'phone') return value.replace(/\D/g, '').length >= 10;
  return /^\S+@\S+\.\S+$/.test(value.trim());
}

/** Canonical comparison form: E.164 for phones, trimmed lowercase for email. */
export function canonicalContact(method: ContactMethod, value: string | null | undefined): string {
  if (!value) return '';
  return method === 'phone' ? normalizePhone(value) : value.trim().toLowerCase();
}

/**
 * True when two contact values name the same address/number, however each
 * was formatted ("+15551234567" matches "(555) 123-4567"). Empty never matches.
 */
export function contactsMatch(
  method: ContactMethod,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = canonicalContact(method, a);
  return left !== '' && left === canonicalContact(method, b);
}

/**
 * Reduces typed or stored input to the 10-digit US national number when it
 * carries a +1 / leading-1 country code, so "+1 555 123 4567" and autofilled
 * E.164 values never shift into the area code under formatPhoneNumber.
 */
export function usNationalDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (value.trim().startsWith('+1') || (digits.length === 11 && digits.startsWith('1'))) {
    return digits.slice(1);
  }
  return digits;
}

/** Display form of a phone number that may be stored as E.164 (+1…). */
export function formatUsPhone(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  // Non-US numbers on file stay as stored rather than being forced into a US mask.
  if (trimmed.startsWith('+') && !trimmed.startsWith('+1')) return trimmed;
  return formatPhoneNumber(usNationalDigits(trimmed));
}

/** Formats a phone number progressively as the user enters it. */
export function formatPhoneNumber(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 10);
  if (!digits) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function maskContact(method: ContactMethod, value: string): string {
  if (method === 'phone') {
    const digits = value.replace(/\D/g, '');
    return `(•••) •••-${digits.slice(-4) || '••••'}`;
  }
  const [user = '', domain = ''] = value.trim().split('@');
  return `${user.slice(0, 1)}•••@${domain || '•••'}`;
}

// ─── Birthday validation (against the demo anchor, never device clock) ──────

export const MONTH_LABELS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export interface BirthdayValidation {
  complete: boolean;
  error: string | null;
}

export function validateBirthday(
  month: number | null,
  dayStr: string,
  yearStr: string,
  useLocalClock = false,
): BirthdayValidation {
  if (!month || !dayStr.trim() || !yearStr.trim()) return { complete: false, error: null };
  const day = Number(dayStr);
  const year = Number(yearStr);
  if (!Number.isInteger(day) || !Number.isInteger(year) || yearStr.trim().length < 4) {
    return { complete: true, error: 'Enter a valid date.' };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!real) return { complete: true, error: 'Enter a valid date.' };

  const today = useLocalClock ? new Date() : TODAY;
  const todayYear = useLocalClock ? today.getFullYear() : today.getUTCFullYear();
  const todayMonth = (useLocalClock ? today.getMonth() : today.getUTCMonth()) + 1;
  const todayDay = useLocalClock ? today.getDate() : today.getUTCDate();
  let age = todayYear - year;
  const hadBirthday =
    todayMonth > month ||
    (todayMonth === month && todayDay >= day);
  if (!hadBirthday) age -= 1;

  if (age < 18) return { complete: true, error: 'Members must be at least 18 years old.' };
  if (age > 100) return { complete: true, error: 'Enter a valid birth year.' };
  return { complete: true, error: null };
}

// ─── Weight helpers ──────────────────────────────────────────────────────────

export function weightUnitFor(heightUnit: HeightUnit): 'lb' | 'kg' {
  return heightUnit === 'metric' ? 'kg' : 'lb';
}

export function weightBounds(unit: 'lb' | 'kg'): { min: number; max: number } {
  return unit === 'lb' ? { min: 80, max: 500 } : { min: 36, max: 227 };
}

export function parseWeight(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Program start date (anchored to the fixed demo date) ───────────────────

export const QUICK_START_OFFSETS = [0, 1, 2, 3, 4];

export function startDateKeyFor(offset: number): string {
  return toDateKey(addDays(TODAY, offset));
}

/** Real accounts use this device's local calendar, never the demo anchor. */
export function localStartDateKeyFor(offset: number, now = new Date()): string {
  const localNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
  return `${localNoon.getFullYear()}-${String(localNoon.getMonth() + 1).padStart(2, '0')}-${String(localNoon.getDate()).padStart(2, '0')}`;
}

export function isValidDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function startDateLabelFor(offset: number, includeYear = false): string {
  return formatDateKey(startDateKeyFor(offset), includeYear);
}

export function quickStartTitle(offset: number): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return `In ${offset} days`;
}

// ─── Medication reminders ────────────────────────────────────────────────────

export const REMINDER_META: Record<
  ReminderSlot,
  { title: string; window: string; field: 'reminderMorning' | 'reminderAfternoon' | 'reminderEvening' }
> = {
  morning: { title: 'Morning dose', window: '6:00 – 9:00 AM', field: 'reminderMorning' },
  afternoon: { title: 'Afternoon dose', window: '12:00 – 3:00 PM', field: 'reminderAfternoon' },
  evening: { title: 'Evening dose', window: '7:00 – 10:00 PM', field: 'reminderEvening' },
};

function formatTime(h24: number, minutes: 0 | 30): string {
  const suffix = h24 >= 12 ? 'PM' : 'AM';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${minutes === 0 ? '00' : '30'} ${suffix}`;
}

export const INJECTION_DAY_OPTIONS: { label: string; value: number }[] = [
  { label: 'Sunday', value: 0 },
  { label: 'Monday', value: 1 },
  { label: 'Tuesday', value: 2 },
  { label: 'Wednesday', value: 3 },
  { label: 'Thursday', value: 4 },
  { label: 'Friday', value: 5 },
  { label: 'Saturday', value: 6 },
];

/** Injection reminder clock choices: every half hour from 6:00 AM to 10:00 PM. */
export function injectionTimeOptions(): string[] {
  const out: string[] = [];
  for (let h = 6; h <= 22; h++) {
    out.push(formatTime(h, 0));
    if (h < 22) out.push(formatTime(h, 30));
  }
  return out;
}

export function reminderOptions(slot: ReminderSlot): string[] {
  const ranges: Record<ReminderSlot, [number, number]> = {
    morning: [6, 10],
    afternoon: [12, 16],
    evening: [19, 23],
  };
  const [start, end] = ranges[slot];
  const out: string[] = [];
  for (let h = start; h <= end; h++) {
    out.push(formatTime(h, 0));
    if (h < end) out.push(formatTime(h, 30));
  }
  return out;
}

// ─── Static content ──────────────────────────────────────────────────────────

export const VALUE_PROPS = [
  'Track meals, water, and weight in one place',
  'Calorie and macro targets set by your care team',
  'Medication reminders that fit your schedule',
  'Weekly check-ins your provider actually reviews',
  'Recipes matched to your plan',
  'Progress photos and trends over time',
];

export const HEALTH_APP_BENEFITS = [
  'Approved daily step counts can be imported',
  'Approved weight measurements can be imported',
  'Your measurements stay scoped to your patient account',
  'Only the categories you approve are requested',
];

export const NOTIFICATION_ITEMS = [
  'Medication dose reminders',
  'Daily logging nudges',
  'Check-in day alerts',
  'Messages from your care team',
];

// ─── Diet step rules ─────────────────────────────────────────────────────────

/**
 * Whether the diet picker is locked for these answers on `todayKey`: the
 * THINNR protocol owns the plan until it finishes (future and day-one start
 * dates both read as day 1, hence locked). GLP-1 and tracking-only patients
 * pick right away.
 */
export function dietPickerLockedFor(a: OnboardingAnswers, todayKey: string): boolean {
  if (a.program !== 'thinnr') return false;
  return derivePhase({ episodeStartedOn: a.programStartDate || null, todayKey, programId: 'thinnr' }).dietPickerLocked;
}

/** Screening questions the chosen diet still needs before Next may advance. */
export function openDietQuestions(a: OnboardingAnswers): ScreeningQuestion[] {
  const entry = a.dietSlug ? DIET_BY_SLUG.get(a.dietSlug) : null;
  if (!entry) return [];
  return unansweredQuestions(entry, {
    phase: 'maintenance',
    programId: a.program,
    gender: a.gender,
    answers: a.dietAnswers,
    actor: 'patient',
  });
}

export type DietStepBlocker = 'diet' | 'questions' | 'activity' | null;

/** What still blocks the diet step's Next (null = may advance). */
export function dietStepBlocker(a: OnboardingAnswers, locked: boolean): DietStepBlocker {
  if (!locked) {
    if (!a.dietSlug) return 'diet';
    if (openDietQuestions(a).length > 0) return 'questions';
  }
  if (!a.activityLevel) return 'activity';
  return null;
}

export const DIET_STEP_HINTS: Record<Exclude<DietStepBlocker, null>, string> = {
  diet: 'Pick a diet, or "No specific diet, just tracking".',
  questions: 'Answer the short safety question(s) for this diet first.',
  activity: 'Pick the activity level that fits you best.',
};

/** Allergies are the one required list: at least one item or an explicit None. */
export function allergiesStepComplete(a: OnboardingAnswers): boolean {
  return a.allergiesNone || a.allergies.length > 0;
}

export const ALLERGIES_STEP_HINT = 'Add at least one allergy, or tap "None".';

export const PROGRAM_OPTIONS: {
  key: ProgramChoice;
  title: string;
  body: string;
  icon: 'zap' | 'activity' | 'compass';
}[] = [
  {
    key: 'thinnr',
    title: 'THINNR Protocol',
    body: 'Medication protocol with coaching from your care team.',
    icon: 'zap',
  },
  {
    key: 'glp1',
    title: 'GLP-1 Program',
    body: 'GLP-1 medication program managed by your provider.',
    icon: 'activity',
  },
  {
    key: 'none',
    title: 'No program yet',
    body: 'Track food, water, and weight on your own for now.',
    icon: 'compass',
  },
];

export function programTitle(program: ProgramChoice | null): string {
  return PROGRAM_OPTIONS.find(p => p.key === program)?.title ?? '—';
}
