/**
 * Display vocabulary for office access subscriptions — what an office pays
 * THINNR. Shared by the account page's billing panel and the HQ board so both
 * read one state in the same words.
 *
 * The server owns every rule here; this module only decides how a state, a
 * plan and a paid-through source read on screen, and works out the date a
 * monthly or yearly term lands on so HQ never has to count days by hand.
 */
import type { PillTone } from '@/lib/billing-format';
import type {
  OfficeAccessBoardRow,
  OfficeAccessPlan,
  OfficeAccessSlot,
  OfficeAccessState,
  OfficeAccessTerms,
  PaidThroughSource,
} from '@/lib/billing-types';

/** An office no subscription work has touched yet. Honestly nothing, not zero. */
export const NOT_STARTED = 'not_started';
export type BoardState = OfficeAccessState | typeof NOT_STARTED;

export const ACCESS_STATE_LABELS: Record<BoardState, string> = {
  not_started: 'Not started',
  setup_incomplete: 'Setup incomplete',
  included_period: 'Included period',
  paid_current: 'Paid',
  past_due: 'In grace',
  restricted: 'Restricted',
};

export const ACCESS_STATE_TONES: Record<BoardState, PillTone> = {
  not_started: 'neutral',
  setup_incomplete: 'info',
  included_period: 'info',
  paid_current: 'good',
  past_due: 'warn',
  restricted: 'bad',
};

/** What the state means, in the words HQ would use on the phone. */
export const ACCESS_STATE_MEANING: Record<BoardState, string> = {
  not_started: 'No access subscription has been created for this office yet.',
  setup_incomplete: 'The office has not finished adding its bank account and cards.',
  included_period: 'Inside an included period — nothing is charged until it ends.',
  paid_current: 'Paid up. The next charge runs when the paid period ends.',
  past_due: 'A charge failed and the recovery window is running.',
  restricted: 'The recovery window closed unpaid. The office keeps its data at the restricted share.',
};

export const PLAN_LABELS: Record<OfficeAccessPlan, string> = { monthly: 'Monthly', yearly: 'Yearly' };

export const PAID_THROUGH_SOURCE_LABELS: Record<PaidThroughSource, string> = {
  stripe: 'Charged through Stripe',
  offline: 'Paid outside Stripe',
  hq_migration: 'Carried over from the old system',
};

export const SLOT_LABELS: Record<OfficeAccessSlot, string> = {
  bank: 'Bank account',
  card_primary: 'Primary card',
  card_backup: 'Backup card',
};

/** The state a row belongs to on the board, with "no work yet" as its own bucket. */
export function boardState(row: Pick<OfficeAccessTerms, 'state'>): BoardState {
  return row.state ?? NOT_STARTED;
}

export function accessStateLabel(state: OfficeAccessState | null): string {
  return ACCESS_STATE_LABELS[state ?? NOT_STARTED];
}

export function accessStateTone(state: OfficeAccessState | null): PillTone {
  return ACCESS_STATE_TONES[state ?? NOT_STARTED];
}

/** `YYYY-MM-DD` for a date input, in UTC so it matches what the server stores. */
export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

/**
 * Where a term lands from a starting point: one calendar month or one
 * calendar year on, clamped for short months (Jan 31 + 1 month = Feb 28).
 */
export function termEndDate(plan: OfficeAccessPlan, from: Date = new Date()): Date {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const target = new Date(start);
  if (plan === 'yearly') target.setUTCFullYear(start.getUTCFullYear() + 1);
  else target.setUTCMonth(start.getUTCMonth() + 1);
  // A rolled-over day (e.g. Feb 31) means the month was short: step back to its last day.
  if (plan === 'monthly' && target.getUTCDate() !== start.getUTCDate()) target.setUTCDate(0);
  return target;
}

/**
 * The paid-through date to suggest. HQ picks the term they were paid for; the
 * clock starts at whatever access the office already has, so a second month
 * added to a paid office extends rather than overwrites.
 */
export function suggestedPaidThrough(plan: OfficeAccessPlan, terms: OfficeAccessTerms | null, now: Date = new Date()): string {
  const existing = terms?.paidThrough ? new Date(terms.paidThrough) : null;
  const from = existing && !Number.isNaN(existing.getTime()) && existing.getTime() > now.getTime() ? existing : now;
  return toDateInput(termEndDate(plan, from));
}

/** Days until a date, floor 0; null when there is no date to count to. */
export function daysUntil(value: string | null, now: Date = new Date()): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil((ms - now.getTime()) / 86_400_000));
}

/** Is this office's included period ending inside the board's "soon" window? */
export function trialEndingSoon(row: OfficeAccessTerms, withinDays: number, now: Date = new Date()): boolean {
  if (row.lifetime || !row.includedPeriodEndsAt) return false;
  const left = daysUntil(row.includedPeriodEndsAt, now);
  return left !== null && Date.parse(row.includedPeriodEndsAt) >= now.getTime() && left <= withinDays;
}

export type BoardSort = 'attention' | 'name' | 'next' | 'trial' | 'amount';

/** Attention order: the states someone has to act on first, then by date. */
const ATTENTION_RANK: Record<BoardState, number> = {
  restricted: 0,
  past_due: 1,
  setup_incomplete: 2,
  included_period: 3,
  paid_current: 4,
  not_started: 5,
};

export function sortBoard(rows: OfficeAccessBoardRow[], sort: BoardSort): OfficeAccessBoardRow[] {
  const byName = (a: OfficeAccessBoardRow, b: OfficeAccessBoardRow) => a.officeName.localeCompare(b.officeName);
  const next = (row: OfficeAccessBoardRow) => {
    const value = row.nextChargeAt ?? row.includedPeriodEndsAt;
    const ms = value ? Date.parse(value) : Number.NaN;
    // No date (lifetime, or no subscription work yet) sorts last, never first.
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  };
  const copy = [...rows];
  if (sort === 'name') return copy.sort(byName);
  if (sort === 'next') return copy.sort((a, b) => next(a) - next(b) || byName(a, b));
  if (sort === 'trial') {
    // Trials ending first; offices not in an included period sort last.
    const trial = (row: OfficeAccessBoardRow) =>
      row.state === 'included_period' && !row.lifetime && row.includedPeriodEndsAt ? Date.parse(row.includedPeriodEndsAt) : Number.MAX_SAFE_INTEGER;
    return copy.sort((a, b) => trial(a) - trial(b) || byName(a, b));
  }
  if (sort === 'amount') {
    // Biggest next charge first; nothing expected sorts last.
    const amount = (row: OfficeAccessBoardRow) => (row.lifetime ? -1 : row.nextChargeCents ?? -1);
    return copy.sort((a, b) => amount(b) - amount(a) || byName(a, b));
  }
  return copy.sort((a, b) => ATTENTION_RANK[boardState(a)] - ATTENTION_RANK[boardState(b)] || next(a) - next(b) || byName(a, b));
}
