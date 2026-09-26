/**
 * App payments — what offices pay THINNR for the app. Pure helpers shared by
 * the HQ page, its demo data and the regression script (no React, no DOM).
 *
 * The server owns every money rule: which dates a charge lands on, what it
 * costs, what counts as at risk. This module only shapes windows, filters the
 * office list, words the flags, and folds the server's charge list into the
 * month view the forecast-vs-collected table needs.
 */
import { addDaysToKey } from '@/lib/date-range-keys';
import { boardState, trialEndingSoon } from '@/lib/office-access';
import type {
  AppChargeRisk,
  AppChargeType,
  AppCollectedMonth,
  AppPaymentFlag,
  AppPaymentInstrument,
  AppPaymentLastPayment,
  AppScheduledCharge,
  OfficeAccessBoardRow,
} from '@/lib/billing-types';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- wording

export const FLAG_LABELS: Record<AppPaymentFlag, string> = {
  no_method: 'No usable payment method',
  card_expiring: 'Card expires before the charge',
  bank_unverified: 'Bank not verified',
};

export const RISK_LABELS: Record<AppChargeRisk, string> = {
  ...FLAG_LABELS,
  past_due: 'Office is past due',
  restricted: 'Office is restricted',
  setup_incomplete: 'Payment setup not finished',
};

export const CHARGE_TYPE_LABELS: Record<AppChargeType, string> = {
  trial_conversion: 'Trial conversion',
  renewal: 'Renewal',
};

export const LAST_PAYMENT_LABELS: Record<AppPaymentLastPayment['outcome'], string> = {
  succeeded: 'Paid',
  failed: 'Failed',
  processing: 'Clearing',
  reversed: 'Refunded',
  offline: 'Paid offline',
};

const BRAND_LABELS: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', diners: 'Diners', jcb: 'JCB', unionpay: 'UnionPay',
};

/** "Visa ···· 4242 · exp 04/31" or "Harbor Bank ···· 6789". */
export function instrumentLabel(instrument: AppPaymentInstrument): string {
  const last4 = instrument.last4 ? ` ···· ${instrument.last4}` : '';
  if (instrument.kind === 'bank') return `${instrument.bankName || 'Bank account'}${last4}`;
  const brand = instrument.brand ? BRAND_LABELS[instrument.brand.toLowerCase()] ?? instrument.brand : 'Card';
  const exp = instrument.expMonth && instrument.expYear
    ? ` · exp ${String(instrument.expMonth).padStart(2, '0')}/${String(instrument.expYear).slice(-2)}`
    : '';
  return `${brand}${last4}${exp}`;
}

export function bankStatusLabel(instrument: AppPaymentInstrument): string | null {
  if (instrument.kind !== 'bank') return null;
  return instrument.verificationStatus === 'verified' ? 'Verified' : instrument.verificationStatus === 'failed' ? 'Verification failed' : 'Pending verification';
}

// ---------------------------------------------------------------- windows

export type WindowChoice = '30' | '60' | '90' | '12m' | 'custom';
export const WINDOW_CHOICES: { value: WindowChoice; label: string }[] = [
  { value: '30', label: 'Next 30 days' },
  { value: '60', label: 'Next 60 days' },
  { value: '90', label: 'Next 90 days' },
  { value: '12m', label: 'Next 12 months' },
  { value: 'custom', label: 'Custom range' },
];

/** The export system's longest range; the page never asks for more. */
export const MAX_WINDOW_DAYS = 366;

export interface DayWindow { start: string; end: string }

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const keyMs = (key: string) => Date.parse(`${key}T00:00:00Z`);
export function isDayKey(value: string | null | undefined): value is string {
  return Boolean(value && KEY_RE.test(value) && !Number.isNaN(keyMs(value)) && new Date(keyMs(value)).toISOString().slice(0, 10) === value);
}

/** Inclusive days in a window. */
export function windowDays(window: DayWindow): number {
  return Math.round((keyMs(window.end) - keyMs(window.start)) / DAY_MS) + 1;
}

/** Same day next year, less one day (a year of days, inclusive). */
function yearAhead(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const next = new Date(Date.UTC(y + 1, m - 1, d));
  if (next.getUTCDate() !== d) next.setUTCDate(0);
  return addDaysToKey(next.toISOString().slice(0, 10), -1);
}

/**
 * The window a choice covers, starting today. Custom ranges come from the URL
 * and are refused (null) when malformed, backwards or longer than the cap.
 */
export function forecastWindow(choice: WindowChoice, today: string, custom?: { from?: string | null; to?: string | null }): DayWindow | null {
  if (choice === 'custom') {
    const from = custom?.from;
    const to = custom?.to;
    if (!isDayKey(from) || !isDayKey(to) || keyMs(to) < keyMs(from)) return null;
    const window = { start: from, end: to };
    return windowDays(window) > MAX_WINDOW_DAYS ? null : window;
  }
  if (choice === '12m') return { start: today, end: yearAhead(today) };
  return { start: today, end: addDaysToKey(today, Number(choice) - 1) };
}

export function parseWindowChoice(value: string | null): WindowChoice {
  return WINDOW_CHOICES.some((option) => option.value === value) ? (value as WindowChoice) : '90';
}

/** Weeks read well up to about three months; beyond that, months. */
export function defaultBucket(window: DayWindow): 'week' | 'month' {
  return windowDays(window) <= 92 ? 'week' : 'month';
}

export type HistoryChoice = '3m' | '6m' | '12m';
export const HISTORY_CHOICES: { value: HistoryChoice; label: string }[] = [
  { value: '3m', label: 'Last 3 months' },
  { value: '6m', label: 'Last 6 months' },
  { value: '12m', label: 'Last 12 months' },
];

export function parseHistoryChoice(value: string | null): HistoryChoice {
  return HISTORY_CHOICES.some((option) => option.value === value) ? (value as HistoryChoice) : '6m';
}

/** Whole calendar months back to today: the 1st of the earliest month through today. */
export function historyWindow(choice: HistoryChoice, today: string): DayWindow {
  const months = Number(choice.replace('m', ''));
  const [y, m] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1 - (months - 1), 1)).toISOString().slice(0, 10);
  return { start, end: today };
}

// ---------------------------------------------------------------- office list

export interface OfficeFilters {
  /** A board state, 'ending_soon', or 'all'. */
  state: string;
  /** Included period ends within this many days. */
  trialWithin: number | null;
  /** Next charge is due within this many days (overdue counts as due). */
  dueWithin: number | null;
  /** 'any' for every problem, or one flag. */
  problem: AppPaymentFlag | 'any' | null;
}

export const WITHIN_CHOICES = [7, 14, 30, 60, 90] as const;

export function parseWithin(value: string | null): number | null {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 && n <= 366 ? n : null;
}

export function parseProblem(value: string | null): OfficeFilters['problem'] {
  if (value === 'any') return 'any';
  return value && value in FLAG_LABELS ? (value as AppPaymentFlag) : null;
}

export function flagsOf(row: OfficeAccessBoardRow): AppPaymentFlag[] {
  return row.paymentFlags ?? [];
}

/** Flags matter when money is still expected: not for lifetime offices or ones with no subscription work. */
export function hasPaymentProblem(row: OfficeAccessBoardRow): boolean {
  return !row.lifetime && row.state !== null && flagsOf(row).length > 0;
}

export function dueWithin(row: OfficeAccessBoardRow, days: number, now: Date): boolean {
  if (row.lifetime || !row.nextChargeAt) return false;
  const ms = Date.parse(row.nextChargeAt);
  return Number.isFinite(ms) && ms <= now.getTime() + days * DAY_MS;
}

export function filterOffices(rows: OfficeAccessBoardRow[], filters: OfficeFilters, endingSoonDays: number, now: Date = new Date()): OfficeAccessBoardRow[] {
  return rows.filter((row) => {
    if (filters.state === 'ending_soon' && !trialEndingSoon(row, endingSoonDays, now)) return false;
    if (filters.state && filters.state !== 'all' && filters.state !== 'ending_soon' && boardState(row) !== filters.state) return false;
    if (filters.trialWithin !== null && !trialEndingSoon(row, filters.trialWithin, now)) return false;
    if (filters.dueWithin !== null && !dueWithin(row, filters.dueWithin, now)) return false;
    if (filters.problem === 'any' && !hasPaymentProblem(row)) return false;
    if (filters.problem && filters.problem !== 'any' && !(hasPaymentProblem(row) && flagsOf(row).includes(filters.problem))) return false;
    return true;
  });
}

// ---------------------------------------------------------------- forecast vs collected

export interface MonthComparison {
  key: string;
  /** Net money actually collected (null for months still ahead). */
  collectedCents: number | null;
  failedCount: number | null;
  /** Estimated charges (null for months wholly in the past). */
  forecastCents: number | null;
  atRiskCents: number | null;
}

/**
 * Past months carry what was collected, months inside the forecast window
 * carry the estimate; the current month can carry both. Forecast months are
 * folded from the server's own charge list, so they agree with the timeline.
 */
export function compareMonths(collected: AppCollectedMonth[], charges: AppScheduledCharge[]): MonthComparison[] {
  const rows = new Map<string, MonthComparison>();
  const row = (key: string) => {
    const existing = rows.get(key);
    if (existing) return existing;
    const created: MonthComparison = { key, collectedCents: null, failedCount: null, forecastCents: null, atRiskCents: null };
    rows.set(key, created);
    return created;
  };
  for (const month of collected) {
    const target = row(month.key);
    target.collectedCents = month.netCents;
    target.failedCount = month.failedCount;
  }
  for (const charge of charges) {
    const target = row(charge.date.slice(0, 7));
    target.forecastCents = (target.forecastCents ?? 0) + charge.amountCents;
    target.atRiskCents = (target.atRiskCents ?? 0) + (charge.atRisk ? charge.amountCents : 0);
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const monthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "Sep 2026" for a month key, "Sep 21" for a week key. */
export function periodLabel(key: string): string {
  if (/^\d{4}-\d{2}$/.test(key)) return monthFormatter.format(new Date(`${key}-01T00:00:00Z`));
  if (KEY_RE.test(key)) return dayFormatter.format(new Date(`${key}T00:00:00Z`));
  return key;
}

/** A calendar date in UTC — the server's charge dates are UTC instants. */
export function chargeDay(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '—' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(ms));
}
