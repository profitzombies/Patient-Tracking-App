/**
 * Simulated new-patient onboarding: answer model, step flow, and helpers.
 *
 * Field-for-field this mirrors the clinic's real signup flow (20 reference
 * screenshots), restyled to Cobalt Ledger. Everything is mock: verification
 * and provider codes are fixed, nothing persists, and all dates derive from
 * the shared demo anchor date — never the device clock.
 */
import { addDays, formatDateKey, toDateKey, TODAY } from './patient-data';

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
  goalWeight: string;
  healthApp: 'connected' | 'skipped' | null;
  notifications: 'enabled' | 'later' | null;
  reminderMorning: string;
  reminderAfternoon: string;
  reminderEvening: string;
  diets: string[];
}

export const DEFAULT_ANSWERS: OnboardingAnswers = {
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
  goalWeight: '',
  healthApp: null,
  notifications: null,
  reminderMorning: '8:00 AM',
  reminderAfternoon: '3:00 PM',
  reminderEvening: '10:00 PM',
  diets: [],
};

// ─── Step flow ───────────────────────────────────────────────────────────────

export type StepKey =
  | 'welcome'
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
  | 'reminder-morning'
  | 'reminder-afternoon'
  | 'reminder-evening'
  | 'diets'
  | 'complete';

const onMedication = (a: OnboardingAnswers): boolean =>
  a.program === 'thinnr' || a.program === 'glp1';

interface StepDef {
  key: StepKey;
  when?: (a: OnboardingAnswers) => boolean;
}

export const STEP_FLOW: StepDef[] = [
  { key: 'welcome' },
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
  { key: 'start-date', when: a => onMedication(a) && a.started === 'no' },
  { key: 'goal-weight' },
  { key: 'health-app' },
  { key: 'notifications' },
  { key: 'reminder-morning', when: onMedication },
  { key: 'reminder-afternoon', when: onMedication },
  { key: 'reminder-evening', when: onMedication },
  { key: 'diets' },
  { key: 'complete' },
];

export function visibleSteps(a: OnboardingAnswers, realAccount = false): StepKey[] {
  const accountSetup = new Set<StepKey>(['contact', 'verify', 'provider-code', 'face-id', 'password']);
  return STEP_FLOW.filter(s => (!realAccount || !accountSetup.has(s.key)) && (!s.when || s.when(a))).map(s => s.key);
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

export interface PasswordChecks {
  length: boolean;
  upper: boolean;
  number: boolean;
  symbol: boolean;
}

export function passwordChecks(pw: string): PasswordChecks {
  return {
    length: pw.length >= 6,
    upper: /[A-Z]/.test(pw),
    number: /\d/.test(pw),
    symbol: /[^A-Za-z0-9]/.test(pw),
  };
}

export function allPasswordChecksPass(pw: string): boolean {
  const c = passwordChecks(pw);
  return c.length && c.upper && c.number && c.symbol;
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

  let age = TODAY.getUTCFullYear() - year;
  const hadBirthday =
    TODAY.getUTCMonth() + 1 > month ||
    (TODAY.getUTCMonth() + 1 === month && TODAY.getUTCDate() >= day);
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
  'Steps and activity sync automatically',
  'Weight entries flow into your trend line',
  'Workouts count toward your energy budget',
  'One place for your whole health picture',
];

export const NOTIFICATION_ITEMS = [
  'Medication dose reminders',
  'Daily logging nudges',
  'Check-in day alerts',
  'Messages from your care team',
];

export const DIET_OPTIONS: { key: string; label: string }[] = [
  { key: 'vegan', label: 'Vegan' },
  { key: 'vegetarian', label: 'Vegetarian' },
  { key: 'gluten-free', label: 'Gluten Free' },
];

export const DIET_NONE_KEY = 'none';

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
