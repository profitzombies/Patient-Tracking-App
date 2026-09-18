/**
 * Guided-demo Patient retention figures.
 *
 * The signed-out HQ demo has no live patients, so the Patient retention page
 * reads this deterministic dataset: the same four seeded offices as App usage
 * (their activated-patient counts partition the program's 632 patients), each
 * onboarding patients along a gentle growth curve from its first patient to
 * the demo date. "Active" at the demo date is exactly the App usage monthly
 * ratio, so the two pages agree on the same day; buying and inactive tiers are
 * fixed per-office ratios shaped by the shared day-keyed wave. Everything is a
 * pure function of the date key — anchored to the fixed demo date, never the
 * viewer's clock — so the demo is byte-stable and issues no live request.
 */
import type {
  PatientRetentionCounts,
  PatientRetentionOfficeRow,
  PatientRetentionPoint,
  PatientRetentionResult,
} from '@workspace/api-client-react';
import { retentionPeriodFor, retentionPeriodWindows, type RetentionPeriodWindow } from '@workspace/app-usage-insights';
import { DEMO_TODAY_KEY, type OperationsDateRange } from '../../lib/date-range-keys';
import { sharePercent } from '../../lib/app-usage';
import { DEMO_APP_USAGE_OFFICES, DEMO_APP_USAGE_AS_OF, dayNumber, wave } from './app-usage-demo';

interface DemoRetentionOffice {
  providerId: string;
  officeName: string;
  providerName: string;
  /** Onboarded patients at the demo date — the App usage activated count. */
  patients: number;
  firstOnboardedDate: string;
  /** Share of onboarded patients active in the trailing 30 days at the anchor (the App usage monthly ratio). */
  activeRatio: number;
  /** Share of onboarded patients with a paid order or live subscription in the trailing 90 days at the anchor. */
  buyingRatio: number;
}

const BUYING_RATIOS: Record<string, number> = { 'acct-p1': 0.58, 'acct-p2': 0.64, 'acct-p3': 0.49, 'acct-p4': 0.55 };

export const DEMO_RETENTION_OFFICES: readonly DemoRetentionOffice[] = DEMO_APP_USAGE_OFFICES.map((office) => ({
  providerId: office.providerId,
  officeName: office.officeName,
  providerName: office.providerName,
  patients: office.patients,
  firstOnboardedDate: office.firstPatientDate,
  activeRatio: office.monthlyRatio,
  buyingRatio: BUYING_RATIOS[office.providerId] ?? 0.5,
}));

/** Practice options for the demo's office narrowing. */
export const DEMO_RETENTION_OFFICE_OPTIONS = DEMO_RETENTION_OFFICES.map((office) => ({ id: office.providerId, name: office.officeName }));

/** Daily growth after the demo date, so a range that runs past the anchor keeps climbing gently. */
const POST_ANCHOR_DAILY_GROWTH = 0.003;

/** How far along its onboarding curve an office is on a day: 0 at its first patient, 1 at the demo date. */
function onboardedOn(office: DemoRetentionOffice, day: number): number {
  const first = dayNumber(office.firstOnboardedDate);
  const anchor = dayNumber(DEMO_TODAY_KEY);
  if (day < first) return 0;
  if (day >= anchor) return Math.round(office.patients * (1 + POST_ANCHOR_DAILY_GROWTH * (day - anchor)));
  const progress = (day - first) / Math.max(1, anchor - first);
  // Slightly convex: onboarding speeds up as a practice settles into the program.
  return Math.max(1, Math.round(office.patients * Math.pow(progress, 1.15)));
}

interface RawCounts {
  onboarded: number;
  active: number;
  buying: number;
  inactive: number;
  tiers: [number, number, number];
}

function countsOn(office: DemoRetentionOffice, officeIndex: number, key: string): RawCounts {
  const day = dayNumber(key);
  const onboarded = onboardedOn(office, day);
  if (onboarded === 0) return { onboarded: 0, active: 0, buying: 0, inactive: 0, tiers: [0, 0, 0] };
  const factor = wave(officeIndex, day);
  const active = Math.min(onboarded, Math.round(onboarded * office.activeRatio * factor));
  const buying = Math.min(onboarded, Math.round(onboarded * office.buyingRatio * (0.5 + 0.5 * factor)));
  const inactive = onboarded - active;
  // Nobody can be quiet longer than the office has had patients.
  const age = day - dayNumber(office.firstOnboardedDate);
  let over90 = age >= 90 ? Math.round(inactive * 0.25) : 0;
  let between = age >= 60 ? Math.round(inactive * (age >= 90 ? 0.3 : 0.4)) : 0;
  if (over90 + between > inactive) { over90 = Math.min(over90, inactive); between = inactive - over90; }
  return { onboarded, active, buying, inactive, tiers: [inactive - over90 - between, between, over90] };
}

function toCounts(raw: RawCounts): PatientRetentionCounts {
  return {
    onboarded: raw.onboarded,
    active: raw.active,
    buying: raw.buying,
    inactive: raw.inactive,
    activePct: sharePercent(raw.active, raw.onboarded),
    buyingPct: sharePercent(raw.buying, raw.onboarded),
    inactiveTiers: { days30to60: raw.tiers[0], days60to90: raw.tiers[1], days90plus: raw.tiers[2] },
  };
}

function toPoint(window: RetentionPeriodWindow, raw: RawCounts): PatientRetentionPoint {
  return { periodStart: window.start, periodEnd: window.end, onboarded: raw.onboarded, active: raw.active, buying: raw.buying, inactive: raw.inactive };
}

function sumRaw(list: RawCounts[]): RawCounts {
  const total: RawCounts = { onboarded: 0, active: 0, buying: 0, inactive: 0, tiers: [0, 0, 0] };
  for (const raw of list) {
    total.onboarded += raw.onboarded;
    total.active += raw.active;
    total.buying += raw.buying;
    total.inactive += raw.inactive;
    total.tiers = [total.tiers[0] + raw.tiers[0], total.tiers[1] + raw.tiers[1], total.tiers[2] + raw.tiers[2]];
  }
  return total;
}

/** The seeded Patient retention result for a range, optionally narrowed to one seeded office. */
export function demoPatientRetention(range: OperationsDateRange, officeId: string | null = null): PatientRetentionResult {
  const period = retentionPeriodFor(range);
  const windows = retentionPeriodWindows(range, period);
  const selected = DEMO_RETENTION_OFFICES.map((office, index) => ({ office, index })).filter(({ office }) => officeId === null || office.providerId === officeId);
  const officeRaw = new Map<string, { end: RawCounts; byWindow: Map<string, RawCounts> }>();
  const offices: PatientRetentionOfficeRow[] = selected.map(({ office, index }) => {
    const available = range.end >= office.firstOnboardedDate;
    const base = { providerId: office.providerId, officeName: office.officeName, providerName: office.providerName, firstOnboardedDate: office.firstOnboardedDate };
    if (!available) return { ...base, available: false, counts: null, series: [] };
    const byWindow = new Map<string, RawCounts>();
    const series = windows
      .filter((window) => window.end >= office.firstOnboardedDate)
      .map((window) => {
        const raw = countsOn(office, index, window.end);
        byWindow.set(window.end, raw);
        return toPoint(window, raw);
      });
    const end = countsOn(office, index, range.end);
    officeRaw.set(office.providerId, { end, byWindow });
    return { ...base, available: true, counts: toCounts(end), series };
  });

  const availableIds = offices.filter((row) => row.available).map((row) => row.providerId);
  // Seeded patients never overlap offices, so the network is the plain sum; a
  // period appears once some office has patients for it.
  const networkSeries = windows.flatMap((window) => {
    const parts = availableIds.flatMap((id) => {
      const raw = officeRaw.get(id)?.byWindow.get(window.end);
      return raw ? [raw] : [];
    });
    return parts.length > 0 ? [toPoint(window, sumRaw(parts))] : [];
  });
  const endTotal = sumRaw(availableIds.map((id) => officeRaw.get(id)!.end));
  const selectedOffice = officeId === null ? null : DEMO_RETENTION_OFFICES.find((office) => office.providerId === officeId) ?? null;

  return {
    range: { start: range.start, end: range.end },
    asOf: DEMO_APP_USAGE_AS_OF,
    period,
    office: selectedOffice ? { id: selectedOffice.providerId, name: selectedOffice.officeName } : null,
    network: {
      firstOnboardedDate: selected.map(({ office }) => office.firstOnboardedDate).sort()[0] ?? null,
      available: availableIds.length > 0,
      counts: availableIds.length > 0 ? toCounts(endTotal) : null,
      series: networkSeries,
    },
    offices,
  };
}
