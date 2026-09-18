/**
 * Guided-demo App usage figures.
 *
 * The signed-out HQ demo has no live patients, so the App usage page and the
 * overview tiles read this deterministic dataset instead: four seeded
 * offices whose activated-patient counts partition the program's 632
 * patients exactly (142 + 185 + 210 + 95), each with a fixed weekly and
 * monthly ratio, and a day-keyed waveform so the trend chart and sparklines
 * have shape. Everything is a pure function of the date key — anchored to
 * the fixed demo date, never the viewer's clock — so the demo is byte-stable
 * and issues no live request.
 */
import type { AppUsageOfficeRow, AppUsagePoint, AppUsageResult } from '@workspace/api-client-react';
import { DEMO_TODAY_KEY, type OperationsDateRange } from '../../lib/date-range-keys';
import { sharePercent } from '../../lib/app-usage';

interface DemoUsageOffice {
  providerId: string;
  officeName: string;
  providerName: string;
  /** Activated patients — the same seeded counts the office demo partitions. */
  patients: number;
  /** Fixed share of activated patients active in the trailing 7 / 30 days at the anchor. */
  weeklyRatio: number;
  monthlyRatio: number;
  firstPatientDate: string;
}

export const DEMO_APP_USAGE_OFFICES: readonly DemoUsageOffice[] = [
  { providerId: 'acct-p1', officeName: 'Jenkins Aesthetics & Wellness', providerName: 'Dr. Sarah Jenkins', patients: 142, weeklyRatio: 0.63, monthlyRatio: 0.84, firstPatientDate: '2025-10-06' },
  { providerId: 'acct-p2', officeName: 'Chen Metabolic Health', providerName: 'Michael Chen, NP', patients: 185, weeklyRatio: 0.69, monthlyRatio: 0.88, firstPatientDate: '2025-12-01' },
  { providerId: 'acct-p3', officeName: 'Rostova Wellness Collective', providerName: 'Elena Rostova, RN', patients: 210, weeklyRatio: 0.56, monthlyRatio: 0.79, firstPatientDate: '2026-01-19' },
  { providerId: 'acct-p4', officeName: 'Kim Vitality Clinic', providerName: 'David Kim, NP', patients: 95, weeklyRatio: 0.51, monthlyRatio: 0.74, firstPatientDate: '2026-03-02' },
];

/** Fixed network ratios for the "now" tiles (anchored to the demo date, independent of the range). */
const ACTIVE_NOW_RATIO = 0.04;
const ACTIVE_TODAY_RATIO = 0.31;

/** Fixed "as of" instant: noon on the demo date, so the header never reads the viewer's clock. */
export const DEMO_APP_USAGE_AS_OF = `${DEMO_TODAY_KEY}T12:00:00.000Z`;

const DAY_MS = 86_400_000;

/** Whole days since the epoch for a YYYY-MM-DD key (timezone-proof). */
function dayNumber(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function keyOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Deterministic fraction in [0, 1) — the same sin-hash the seeded office data uses. */
function seededFraction(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Multiplier in [0.9, 1] for one office on one day. It is exactly 1 on the
 * demo date, so the default range's headline figures are the plain ratios
 * (e.g. Jenkins weekly = round(142 × 0.63) = 89).
 */
function wave(officeIndex: number, day: number): number {
  const offset = dayNumber(DEMO_TODAY_KEY) - day;
  if (offset === 0) return 1;
  const gentle = 0.5 + 0.5 * Math.sin((offset / 9) + officeIndex);
  const jitter = seededFraction(day * 4 + officeIndex);
  return 1 - 0.1 * (0.7 * gentle + 0.3 * jitter);
}

function pointFor(office: DemoUsageOffice, officeIndex: number, key: string): AppUsagePoint {
  const factor = wave(officeIndex, dayNumber(key));
  return {
    date: key,
    weeklyActive: Math.round(office.patients * office.weeklyRatio * factor),
    monthlyActive: Math.round(office.patients * office.monthlyRatio * factor),
  };
}

function dayKeys(range: OperationsDateRange): string[] {
  const start = dayNumber(range.start);
  const end = dayNumber(range.end);
  const keys: string[] = [];
  for (let day = start; day <= end; day += 1) keys.push(keyOfDay(day));
  return keys;
}

/** The seeded App usage result for a range: per-office rows plus the exact network partition. */
export function demoAppUsage(range: OperationsDateRange): AppUsageResult {
  const keys = dayKeys(range);
  const offices: AppUsageOfficeRow[] = DEMO_APP_USAGE_OFFICES.map((office, index) => {
    const available = range.end >= office.firstPatientDate;
    if (!available) {
      return { providerId: office.providerId, officeName: office.officeName, providerName: office.providerName, firstPatientDate: office.firstPatientDate, available: false, metrics: null, series: [] };
    }
    const series = keys.filter((key) => key >= office.firstPatientDate).map((key) => pointFor(office, index, key));
    const last = series[series.length - 1] ?? pointFor(office, index, range.end);
    return {
      providerId: office.providerId,
      officeName: office.officeName,
      providerName: office.providerName,
      firstPatientDate: office.firstPatientDate,
      available: true,
      metrics: {
        activatedPatients: office.patients,
        weeklyActive: last.weeklyActive,
        monthlyActive: last.monthlyActive,
        weeklySharePct: sharePercent(last.weeklyActive, office.patients),
        monthlySharePct: sharePercent(last.monthlyActive, office.patients),
      },
      series,
    };
  });

  const availableOffices = offices.filter((row) => row.available);
  // Seeded patients never overlap offices, so the network union is the plain sum.
  // Like the live rollup, a day appears only once some office has data for it.
  const networkSeries: AppUsagePoint[] = keys.flatMap((key) => {
    let weeklyActive = 0;
    let monthlyActive = 0;
    let seen = false;
    for (const row of availableOffices) {
      const point = row.series.find((entry) => entry.date === key);
      if (point) { seen = true; weeklyActive += point.weeklyActive; monthlyActive += point.monthlyActive; }
    }
    return seen ? [{ date: key, weeklyActive, monthlyActive }] : [];
  });
  const activatedAtRangeEnd = availableOffices.reduce((sum, row) => sum + (row.metrics?.activatedPatients ?? 0), 0);
  const weeklyAtRangeEnd = availableOffices.reduce((sum, row) => sum + (row.metrics?.weeklyActive ?? 0), 0);
  const monthlyAtRangeEnd = availableOffices.reduce((sum, row) => sum + (row.metrics?.monthlyActive ?? 0), 0);

  // "Now" tiles are anchored to the demo date regardless of the selected range.
  const anchorRows = DEMO_APP_USAGE_OFFICES.map((office, index) => ({ office, point: pointFor(office, index, DEMO_TODAY_KEY) }));
  const activated = anchorRows.reduce((sum, row) => sum + row.office.patients, 0);
  const weeklyNow = anchorRows.reduce((sum, row) => sum + row.point.weeklyActive, 0);
  const monthlyNow = anchorRows.reduce((sum, row) => sum + row.point.monthlyActive, 0);
  const activeNow = Math.round(activated * ACTIVE_NOW_RATIO);
  const activeToday = Math.round(activated * ACTIVE_TODAY_RATIO);
  const firstPatientDate = DEMO_APP_USAGE_OFFICES.map((office) => office.firstPatientDate).sort()[0];

  return {
    range: { start: range.start, end: range.end },
    asOf: DEMO_APP_USAGE_AS_OF,
    network: {
      firstPatientDate,
      available: availableOffices.length > 0,
      activatedPatients: activated,
      activeNow,
      activeToday,
      weeklyActive: weeklyNow,
      monthlyActive: monthlyNow,
      activeNowSharePct: sharePercent(activeNow, activated),
      activeTodaySharePct: sharePercent(activeToday, activated),
      weeklySharePct: sharePercent(weeklyNow, activated),
      monthlySharePct: sharePercent(monthlyNow, activated),
      atRangeEnd: {
        activatedPatients: activatedAtRangeEnd,
        weeklyActive: weeklyAtRangeEnd,
        monthlyActive: monthlyAtRangeEnd,
        weeklySharePct: sharePercent(weeklyAtRangeEnd, activatedAtRangeEnd),
        monthlySharePct: sharePercent(monthlyAtRangeEnd, activatedAtRangeEnd),
      },
      series: networkSeries,
    },
    offices,
  };
}
