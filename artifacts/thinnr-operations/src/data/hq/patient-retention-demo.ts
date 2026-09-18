/**
 * Guided-demo Patient retention figures.
 *
 * The signed-out HQ demo has no live patients, so the Patient retention page
 * reads this deterministic dataset instead. It reuses the four seeded App
 * usage offices so the two pages agree: at the demo date each office's
 * onboarded count is its App usage activated-patient count (142 + 185 + 210
 * + 95 = 632) and its active count is exactly its App usage monthly-active
 * figure (round(patients × monthlyRatio)). Onboarding ramps up from each
 * office's first patient date to the demo date; buying and the quiet tiers
 * are fixed ratios of the day's onboarded count. Everything is a pure
 * function of the range — anchored to the fixed demo date, never the
 * viewer's clock — so the demo is byte-stable and issues no live request.
 */
import type { PatientRetentionCounts, PatientRetentionOfficeRow, PatientRetentionPoint, PatientRetentionResult } from '@workspace/api-client-react';
import { DEMO_TODAY_KEY, type OperationsDateRange } from '../../lib/date-range-keys';
import { DEMO_APP_USAGE_OFFICES } from './app-usage-demo';
import { retentionDayNumber, retentionSampleDates, retentionShare } from '../../lib/patient-retention';

/** Share of onboarded patients buying at the anchor, per seeded office (same order as the App usage offices). */
const BUYING_RATIOS = [0.58, 0.64, 0.49, 0.44] as const;
/** Share of buying patients on a subscription. */
const SUBSCRIBED_RATIO = 0.7;
/** How the inactive group splits across the quiet tiers (under 30 / 30–60 / 60–90; the remainder is 90+). */
const TIER_SPLIT = [0.28, 0.3, 0.18] as const;

/** Fixed "as of" instant: noon on the demo date, so the header never reads the viewer's clock. */
export const DEMO_PATIENT_RETENTION_AS_OF = `${DEMO_TODAY_KEY}T12:00:00.000Z`;

const ANCHOR_DAY = retentionDayNumber(DEMO_TODAY_KEY);

/** Deterministic fraction in [0, 1) — the same sin-hash the seeded office data uses. */
function seededFraction(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** Multiplier in [0.9, 1], exactly 1 on the demo date — the App usage waveform, so both pages agree at the anchor. */
function wave(officeIndex: number, day: number): number {
  const offset = ANCHOR_DAY - day;
  if (offset === 0) return 1;
  const gentle = 0.5 + 0.5 * Math.sin((offset / 9) + officeIndex);
  const jitter = seededFraction(day * 4 + officeIndex);
  return 1 - 0.1 * (0.7 * gentle + 0.3 * jitter);
}

/**
 * Onboarded patients on a day: a front-loaded ramp from the first patient
 * date that reaches the office's full count on the demo date and holds it
 * afterwards (the demo never onboards past its anchor).
 */
function onboardedOn(officeIndex: number, day: number): number {
  const office = DEMO_APP_USAGE_OFFICES[officeIndex];
  const firstDay = retentionDayNumber(office.firstPatientDate);
  if (day < firstDay) return 0;
  if (day >= ANCHOR_DAY) return office.patients;
  const t = (day - firstDay + 1) / (ANCHOR_DAY - firstDay + 1);
  return Math.max(1, Math.round(office.patients * Math.pow(t, 0.8)));
}

interface DemoTally {
  onboarded: number;
  active: number;
  buying: number;
  subscribed: number;
  tiers: [number, number, number, number];
}

function tallyOn(officeIndex: number, day: number): DemoTally {
  const office = DEMO_APP_USAGE_OFFICES[officeIndex];
  const onboarded = onboardedOn(officeIndex, day);
  if (onboarded === 0) return { onboarded: 0, active: 0, buying: 0, subscribed: 0, tiers: [0, 0, 0, 0] };
  const factor = wave(officeIndex, day);
  const active = Math.min(onboarded, Math.round(onboarded * office.monthlyRatio * factor));
  const buying = Math.min(onboarded, Math.round(onboarded * BUYING_RATIOS[officeIndex] * factor));
  const subscribed = Math.round(buying * SUBSCRIBED_RATIO);
  const inactive = onboarded - active;
  // Young offices have not been around long enough for the older tiers.
  const ageDays = day - retentionDayNumber(office.firstPatientDate);
  const tiers: [number, number, number, number] = [
    Math.round(inactive * TIER_SPLIT[0]),
    ageDays >= 30 ? Math.round(inactive * TIER_SPLIT[1]) : 0,
    ageDays >= 60 ? Math.round(inactive * TIER_SPLIT[2]) : 0,
    0,
  ];
  // The remainder lands in the oldest tier the office is old enough for, so the tiers always sum to inactive.
  const oldestOpen = ageDays >= 90 ? 3 : ageDays >= 60 ? 2 : ageDays >= 30 ? 1 : 0;
  tiers[oldestOpen] += inactive - tiers[0] - tiers[1] - tiers[2];
  return { onboarded, active, buying, subscribed, tiers };
}

function countsFrom(t: DemoTally, onboardedBefore: number): PatientRetentionCounts {
  const inactive = t.onboarded - t.active;
  return {
    onboarded: t.onboarded,
    newInRange: Math.max(0, t.onboarded - onboardedBefore),
    active: t.active,
    inactive,
    buying: t.buying,
    subscribed: t.subscribed,
    inactiveUnder30: t.tiers[0],
    inactive30to60: t.tiers[1],
    inactive60to90: t.tiers[2],
    inactive90plus: t.tiers[3],
    activePct: retentionShare(t.active, t.onboarded),
    buyingPct: retentionShare(t.buying, t.onboarded),
    inactivePct: retentionShare(inactive, t.onboarded),
  };
}

function pointFrom(date: string, t: DemoTally): PatientRetentionPoint {
  return { date, onboarded: t.onboarded, active: t.active, buying: t.buying, inactive: t.onboarded - t.active };
}

function sumTallies(list: DemoTally[]): DemoTally {
  return list.reduce<DemoTally>(
    (total, t) => ({
      onboarded: total.onboarded + t.onboarded,
      active: total.active + t.active,
      buying: total.buying + t.buying,
      subscribed: total.subscribed + t.subscribed,
      tiers: [total.tiers[0] + t.tiers[0], total.tiers[1] + t.tiers[1], total.tiers[2] + t.tiers[2], total.tiers[3] + t.tiers[3]],
    }),
    { onboarded: 0, active: 0, buying: 0, subscribed: 0, tiers: [0, 0, 0, 0] },
  );
}

/** The seeded Patient retention result for a range: per-office rows plus the exact network sum. */
export function demoPatientRetention(range: OperationsDateRange): PatientRetentionResult {
  const { step, dates } = retentionSampleDates(range.start, range.end);
  const endDay = retentionDayNumber(range.end);
  const beforeDay = retentionDayNumber(range.start) - 1;

  const offices: PatientRetentionOfficeRow[] = DEMO_APP_USAGE_OFFICES.map((office, index) => {
    const available = range.end >= office.firstPatientDate;
    const base = { providerId: office.providerId, officeName: office.officeName, providerName: office.providerName, firstPatientDate: office.firstPatientDate };
    if (!available) return { ...base, available: false, metrics: null, series: [] };
    return {
      ...base,
      available: true,
      metrics: countsFrom(tallyOn(index, endDay), onboardedOn(index, beforeDay)),
      series: dates.filter((date) => date >= office.firstPatientDate).map((date) => pointFrom(date, tallyOn(index, retentionDayNumber(date)))),
    };
  });

  const availableIndexes = DEMO_APP_USAGE_OFFICES.map((_, index) => index).filter((index) => offices[index].available);
  const networkAvailable = availableIndexes.length > 0;
  const firstPatientDate = [...DEMO_APP_USAGE_OFFICES].map((office) => office.firstPatientDate).sort()[0];
  const networkAt = (day: number) => sumTallies(availableIndexes.map((index) => tallyOn(index, day)));
  const networkOnboardedBefore = availableIndexes.reduce((sum, index) => sum + onboardedOn(index, beforeDay), 0);

  return {
    range: { start: range.start, end: range.end },
    asOf: DEMO_PATIENT_RETENTION_AS_OF,
    step,
    network: {
      firstPatientDate,
      available: networkAvailable,
      metrics: networkAvailable ? countsFrom(networkAt(endDay), networkOnboardedBefore) : null,
      series: networkAvailable
        ? dates.filter((date) => date >= firstPatientDate).map((date) => pointFrom(date, networkAt(retentionDayNumber(date))))
        : [],
    },
    offices,
  };
}
