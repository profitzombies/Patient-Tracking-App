/**
 * Sample data for the App payments page when nobody is signed in to live
 * data. Pinned to the shared demo anchor (Aug 22, 2026), never the viewer's
 * clock, so the preview reads the same on every machine.
 *
 * The forecast here is folded from the sample offices with the same rules
 * the server uses (first charge where access runs out, one term at a time,
 * anything already owed is "outstanding" and never future revenue), so the
 * demo tiles, timeline and chart always agree with the demo office list.
 */
import { DEMO_TODAY_KEY } from '@/lib/date-range-keys';
import { termEndDate } from '@/lib/office-access';
import type {
  AppChargeRisk,
  AppCollectedMonth,
  AppForecastPeriod,
  AppForecastTotals,
  AppOutstandingBalance,
  AppPaymentsCollected,
  AppPaymentsForecast,
  AppScheduledCharge,
  OfficeAccessBoard,
  OfficeAccessBoardRow,
  OfficeAccessPolicy,
  OfficeAccessTerms,
} from '@/lib/billing-types';
import type { DayWindow } from '@/lib/app-payments';

/** The demo's "now": midday on the anchor day, in UTC. */
export const DEMO_NOW = new Date(`${DEMO_TODAY_KEY}T12:00:00Z`);

const at = (key: string) => `${key}T00:00:00.000Z`;

const POLICY: OfficeAccessPolicy = {
  monthlyPriceCents: 20_000,
  yearlyPriceCents: 200_000,
  includedPeriodDays: 90,
  gracePeriodDays: 7,
  normalSharePercent: 60,
  restrictedSharePercent: 100,
  maxIncludedPeriodDays: 1095,
};

const blank: OfficeAccessTerms = {
  state: null, plan: null, priceCents: null, priceCentsOverride: null, lifetime: false,
  includedPeriodStartedAt: null, includedPeriodEndsAt: null, paidThrough: null, paidThroughSource: null,
  currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, graceDaysLeft: null,
  restrictedAt: null, setupCompletedAt: null, bankVerificationDeadline: null, lastAttemptAt: null,
  nextChargeAt: null, version: null,
};

function office(providerId: string, officeName: string, row: Partial<OfficeAccessBoardRow>): OfficeAccessBoardRow {
  return {
    ...blank, providerId, officeName, locked: false,
    instruments: [], trialDaysLeft: null, nextChargeCents: null, lastPayment: null, paymentFlags: [],
    version: 1, ...row,
  };
}

const verifiedBank = (bankName: string, last4: string) =>
  ({ slot: 'bank', kind: 'bank', brand: null, bankName, last4, expMonth: null, expYear: null, verificationStatus: 'verified' }) as const;
const card = (slot: 'card_primary' | 'card_backup', brand: string, last4: string, expMonth: number, expYear: number) =>
  ({ slot, kind: 'card', brand, bankName: null, last4, expMonth, expYear, verificationStatus: 'verified' }) as const;

export const DEMO_APP_OFFICES: OfficeAccessBoardRow[] = [
  office('demo-aspen', 'Aspen Aesthetics', {
    state: 'paid_current', plan: 'monthly', priceCents: 20_000, setupCompletedAt: at('2026-02-02'),
    includedPeriodStartedAt: at('2026-02-05'), includedPeriodEndsAt: at('2026-05-05'),
    paidThrough: at('2026-09-05'), paidThroughSource: 'stripe', nextChargeAt: at('2026-09-05'), nextChargeCents: 20_000,
    instruments: [verifiedBank('Harbor Bank', '6789'), card('card_primary', 'visa', '4242', 4, 2029), card('card_backup', 'mastercard', '4444', 8, 2028)],
    lastPayment: { at: at('2026-08-05'), amountCents: 20_000, outcome: 'succeeded', slot: 'bank', failureCode: null },
  }),
  office('demo-beacon', 'Beacon Hill Med Spa', {
    state: 'restricted', plan: 'monthly', priceCents: 15_000, priceCentsOverride: 15_000, setupCompletedAt: at('2026-01-10'),
    includedPeriodEndsAt: at('2026-04-10'), paidThrough: at('2026-07-10'), paidThroughSource: 'stripe',
    graceEndsAt: at('2026-07-17'), graceDaysLeft: 0, restrictedAt: at('2026-07-17'),
    nextChargeAt: at('2026-07-10'), nextChargeCents: 15_000, paymentFlags: ['no_method'],
    instruments: [card('card_primary', 'visa', '0341', 6, 2026)],
    lastPayment: { at: at('2026-07-16'), amountCents: 15_000, outcome: 'failed', slot: 'card_primary', failureCode: 'expired_card' },
  }),
  office('demo-cedar', 'Cedar Park Wellness', {
    state: 'included_period', plan: 'monthly', priceCents: 20_000, setupCompletedAt: at('2026-06-01'),
    includedPeriodStartedAt: at('2026-06-03'), includedPeriodEndsAt: at('2026-09-01'),
    nextChargeAt: at('2026-09-01'), nextChargeCents: 20_000, trialDaysLeft: 10, paymentFlags: ['bank_unverified'],
    bankVerificationDeadline: at('2026-08-29'),
    instruments: [
      { slot: 'bank', kind: 'bank', brand: null, bankName: 'Summit Credit Union', last4: '1180', expMonth: null, expYear: null, verificationStatus: 'pending' },
      card('card_primary', 'mastercard', '5454', 11, 2027),
    ],
  }),
  office('demo-dune', 'Dune Skin Studio', {}),
  office('demo-elm', 'Elm Street Body', {
    state: 'past_due', plan: 'monthly', priceCents: 20_000, setupCompletedAt: at('2026-03-01'),
    includedPeriodEndsAt: at('2026-05-18'), paidThrough: at('2026-08-18'), paidThroughSource: 'stripe',
    graceEndsAt: at('2026-08-25'), graceDaysLeft: 3, nextChargeAt: at('2026-08-18'), nextChargeCents: 20_000,
    lastAttemptAt: at('2026-08-21'), paymentFlags: ['card_expiring'],
    instruments: [verifiedBank('First Coastal', '2210'), card('card_primary', 'visa', '1111', 9, 2026)],
    lastPayment: { at: at('2026-08-21'), amountCents: 20_000, outcome: 'failed', slot: 'bank', failureCode: 'insufficient_funds' },
  }),
  office('demo-fairview', 'Fairview Lift Clinic', {
    state: 'paid_current', plan: 'yearly', priceCents: 180_000, priceCentsOverride: 180_000, setupCompletedAt: at('2025-10-01'),
    includedPeriodEndsAt: at('2025-10-14'), paidThrough: at('2026-10-14'), paidThroughSource: 'stripe',
    nextChargeAt: at('2026-10-14'), nextChargeCents: 180_000,
    instruments: [verifiedBank('Lakeside Savings', '9034'), card('card_primary', 'amex', '0005', 1, 2028)],
    lastPayment: { at: at('2025-10-14'), amountCents: 180_000, outcome: 'succeeded', slot: 'bank', failureCode: null },
  }),
  office('demo-glenwood', 'Glenwood Contour', {
    state: 'included_period', plan: 'yearly', priceCents: 200_000, setupCompletedAt: at('2026-07-18'),
    includedPeriodStartedAt: at('2026-07-20'), includedPeriodEndsAt: at('2026-10-18'),
    nextChargeAt: at('2026-10-18'), nextChargeCents: 200_000, trialDaysLeft: 57,
    instruments: [verifiedBank('Harbor Bank', '5521'), card('card_primary', 'discover', '1117', 3, 2030)],
  }),
  office('demo-harbor', 'Harbor Point Aesthetics', {
    state: 'setup_incomplete', plan: 'monthly', priceCents: 20_000,
    includedPeriodStartedAt: at('2026-08-12'), includedPeriodEndsAt: at('2026-11-10'),
    nextChargeAt: at('2026-11-10'), nextChargeCents: 20_000, trialDaysLeft: 80, paymentFlags: ['no_method'],
  }),
  office('demo-ivy', 'Ivy Lane Med Spa', {
    state: 'paid_current', plan: 'monthly', priceCents: 20_000, lifetime: true, setupCompletedAt: at('2025-12-01'),
    instruments: [verifiedBank('Harbor Bank', '7702'), card('card_primary', 'visa', '8830', 12, 2029)],
  }),
];

export function demoBoard(): OfficeAccessBoard {
  const rows = DEMO_APP_OFFICES;
  const count = (state: OfficeAccessBoardRow['state']) => rows.filter((row) => row.state === state).length;
  return {
    offices: rows,
    counts: {
      total: rows.length,
      notStarted: count(null),
      setupIncomplete: count('setup_incomplete'),
      includedPeriod: count('included_period'),
      paidCurrent: count('paid_current'),
      pastDue: count('past_due'),
      restricted: count('restricted'),
      trialsEndingSoon: 1,
    },
    policy: POLICY,
    trialEndingSoonDays: 30,
  };
}

const zeroTotals = (): AppForecastTotals => ({
  totalCents: 0, renewalCents: 0, trialConversionCents: 0, monthlyCents: 0, yearlyCents: 0, atRiskCents: 0, count: 0,
});

function add(target: AppForecastTotals, charge: AppScheduledCharge) {
  target.totalCents += charge.amountCents;
  if (charge.type === 'renewal') target.renewalCents += charge.amountCents;
  else target.trialConversionCents += charge.amountCents;
  if (charge.plan === 'monthly') target.monthlyCents += charge.amountCents;
  else target.yearlyCents += charge.amountCents;
  if (charge.atRisk) target.atRiskCents += charge.amountCents;
  target.count += 1;
}

function bucketKey(iso: string, bucket: 'week' | 'month'): { key: string; start: string } {
  const date = new Date(iso);
  if (bucket === 'month') {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    return { key: start.toISOString().slice(0, 7), start: start.toISOString() };
  }
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000);
  return { key: monday.toISOString().slice(0, 10), start: monday.toISOString() };
}

export function demoForecast(window: DayWindow, bucket: 'week' | 'month'): AppPaymentsForecast {
  const start = Date.parse(`${window.start}T00:00:00Z`);
  const end = Date.parse(`${window.end}T23:59:59.999Z`);
  const charges: AppScheduledCharge[] = [];
  const outstanding: AppOutstandingBalance[] = [];
  for (const row of DEMO_APP_OFFICES) {
    if (row.lifetime || !row.state || !row.plan || !row.priceCents || !row.nextChargeAt) continue;
    let cursor = new Date(row.nextChargeAt);
    if (cursor.getTime() <= DEMO_NOW.getTime()) {
      outstanding.push({
        providerId: row.providerId, officeName: row.officeName, state: row.state, since: cursor.toISOString(),
        plan: row.plan, amountCents: row.priceCents, inFlight: false,
      });
      cursor = termEndDate(row.plan, cursor);
    }
    const stateRisk: AppChargeRisk[] =
      row.state === 'past_due' || row.state === 'restricted' ? [row.state] : !row.setupCompletedAt ? ['setup_incomplete'] : [];
    for (let guard = 0; guard < 400 && cursor.getTime() <= end; guard += 1) {
      if (cursor.getTime() >= start) {
        const reasons: AppChargeRisk[] = [...stateRisk, ...(row.paymentFlags ?? [])];
        charges.push({
          providerId: row.providerId, officeName: row.officeName, date: cursor.toISOString(),
          type: !row.paidThrough && row.includedPeriodEndsAt === cursor.toISOString() ? 'trial_conversion' : 'renewal',
          plan: row.plan, amountCents: row.priceCents, atRisk: reasons.length > 0, riskReasons: reasons,
        });
      }
      cursor = termEndDate(row.plan, cursor);
    }
  }
  charges.sort((a, b) => a.date.localeCompare(b.date) || a.officeName.localeCompare(b.officeName));

  const periods = new Map<string, AppForecastPeriod>();
  for (let cursor = bucketKey(new Date(start).toISOString(), bucket); Date.parse(cursor.start) <= end; ) {
    periods.set(cursor.key, { key: cursor.key, start: cursor.start, ...zeroTotals() });
    const next = new Date(cursor.start);
    if (bucket === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
    else next.setUTCDate(next.getUTCDate() + 7);
    cursor = bucketKey(next.toISOString(), bucket);
  }
  const totals = zeroTotals();
  for (const charge of charges) {
    add(totals, charge);
    const period = periods.get(bucketKey(charge.date, bucket).key);
    if (period) add(period, charge);
  }
  return {
    start: new Date(start).toISOString(),
    end: new Date(end + 1).toISOString(),
    bucket,
    charges,
    periods: [...periods.values()],
    totals,
    outstanding: { totalCents: outstanding.reduce((sum, row) => sum + row.amountCents, 0), offices: outstanding },
    estimate: true,
  };
}

/** Fixed sample months (Jan 2025 – Aug 2026); a range picks the months it covers. */
const DEMO_MONTHS: Record<string, [collected: number, offline: number, reversed: number, failedCount: number, failedCents: number]> = {
  '2025-09': [95_000, 0, 0, 0, 0],
  '2025-10': [275_000, 0, 0, 1, 20_000],
  '2025-11': [115_000, 0, 0, 0, 0],
  '2025-12': [115_000, 20_000, 0, 0, 0],
  '2026-01': [135_000, 0, 0, 1, 15_000],
  '2026-02': [135_000, 0, 20_000, 0, 0],
  '2026-03': [155_000, 0, 0, 0, 0],
  '2026-04': [155_000, 0, 0, 1, 20_000],
  '2026-05': [175_000, 0, 0, 0, 0],
  '2026-06': [175_000, 20_000, 0, 1, 15_000],
  '2026-07': [155_000, 0, 0, 2, 35_000],
  '2026-08': [80_000, 0, 0, 2, 40_000],
};

export function demoCollected(window: DayWindow): AppPaymentsCollected {
  const blankMonth = (key: string): AppCollectedMonth => ({
    key, collectedCents: 0, offlineCents: 0, reversedCents: 0, netCents: 0,
    succeededCount: 0, failedCount: 0, failedCents: 0, processingCount: 0,
  });
  const months: AppCollectedMonth[] = [];
  const totals = blankMonth('total');
  const cursor = new Date(`${window.start.slice(0, 7)}-01T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= window.end) {
    const key = cursor.toISOString().slice(0, 7);
    const [collected, offline, reversed, failedCount, failedCents] = DEMO_MONTHS[key] ?? [0, 0, 0, 0, 0];
    const month: AppCollectedMonth = {
      key, collectedCents: collected, offlineCents: offline, reversedCents: reversed,
      netCents: collected + offline - reversed, succeededCount: Math.round(collected / 20_000),
      failedCount, failedCents, processingCount: 0,
    };
    months.push(month);
    for (const field of ['collectedCents', 'offlineCents', 'reversedCents', 'netCents', 'succeededCount', 'failedCount', 'failedCents'] as const) {
      totals[field] += month[field];
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return { start: `${window.start}T00:00:00.000Z`, end: `${window.end}T23:59:59.999Z`, months, totals };
}
