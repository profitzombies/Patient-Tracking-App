/**
 * Range-driven analytics selectors scoped to one provider account.
 *
 * The office Revenue & Outcomes page reads these through useScopedAnalyticsRange
 * during an HQ drill-in. Each selector derives from the program-wide series in
 * src/data/analytics-range.ts:
 *
 * - Revenue splits scale the program's recurring/enrollment sums by the
 *   account's exact seeded share, so the default demo window reproduces the
 *   account's headline revenue to the dollar (e.g. Jenkins: $27,500 recurring
 *   + $14,000 enrollments = $41,500), and the four accounts always sum back
 *   to the program figures.
 * - Outcome summaries apply the account's fixed offsets — calibrated so the
 *   default window lands exactly on the account's seeded headline outcomes,
 *   and the patient-weighted average of the four accounts reproduces the
 *   program headline (88.2% goal completion, 24.5 lbs, 94.5% retention).
 *
 * Everything stays deterministic per range — no viewer clock, no randomness.
 */
import { MOCK_ANALYTICS } from '../mock-data';
import {
  getCohortRows,
  getMaintenanceConversionDelta,
  getOutcomeSummary,
  getRevenueComparison,
  getRevenueSummary,
  type AnalyticsRange,
  type CohortRow,
  type OutcomeSummary,
  type RevenueComparison,
  type RevenueSummary,
} from '../analytics-range';
import type { ProviderAccount } from './accounts';

/** Offsets applied to the program outcome blends (see calibration note above). */
const OUTCOME_OFFSETS: Record<
  string,
  { goal: number; lost: number; retention: number; conversion: number; cohortLostFactor: number; cohortRetention: number }
> = {
  'acct-p1': { goal: 0.8, lost: 1.3, retention: 0.7, conversion: 1, cohortLostFactor: 1.05, cohortRetention: 1 },
  'acct-p2': { goal: 4.2, lost: 1.6, retention: 1.5, conversion: 2, cohortLostFactor: 1.06, cohortRetention: 1 },
  'acct-p3': { goal: -2.2, lost: -1.3, retention: -1.1, conversion: -1, cohortLostFactor: 0.95, cohortRetention: -1 },
  'acct-p4': { goal: -4.6, lost: -2.2, retention: -1.6, conversion: -2, cohortLostFactor: 0.91, cohortRetention: -2 },
};

const ZERO_OFFSETS = { goal: 0, lost: 0, retention: 0, conversion: 0, cohortLostFactor: 1, cohortRetention: 0 };

const round1 = (value: number) => Math.round(value * 10) / 10;
const clampPercent = (value: number) => Math.min(99, Math.max(0, value));

export interface ScopedAnalyticsRange {
  getRevenueSummary: (range: AnalyticsRange) => RevenueSummary;
  getRevenueComparison: (range: AnalyticsRange) => RevenueComparison | null;
  getOutcomeSummary: (range: AnalyticsRange) => OutcomeSummary;
  getCohortRows: (range: AnalyticsRange) => CohortRow[];
  getMaintenanceConversionDelta: (range: AnalyticsRange) => number;
}

/** The unscoped office demo uses the program selectors verbatim. */
export const PROGRAM_ANALYTICS_RANGE: ScopedAnalyticsRange = {
  getRevenueSummary,
  getRevenueComparison,
  getOutcomeSummary,
  getCohortRows,
  getMaintenanceConversionDelta,
};

export function buildAccountAnalyticsRange(account: ProviderAccount): ScopedAnalyticsRange {
  const recurringShare = account.recurringRevenue / MOCK_ANALYTICS.recurringRevenue;
  const enrollmentShare = account.enrollmentRevenue / MOCK_ANALYTICS.enrollmentRevenue;
  const offsets = OUTCOME_OFFSETS[account.id] ?? ZERO_OFFSETS;

  const scopedRevenue = (range: AnalyticsRange): RevenueSummary => {
    const base = getRevenueSummary(range);
    const recurring = Math.round(base.recurring * recurringShare);
    const enrollment = Math.round(base.enrollment * enrollmentShare);
    return { total: recurring + enrollment, recurring, enrollment };
  };

  return {
    getRevenueSummary: scopedRevenue,

    getRevenueComparison: (range) => {
      const baseComparison = getRevenueComparison(range);
      if (!baseComparison) return null;
      // Recompute the delta from the account's own mix: recurring and
      // enrollment scale differently, so the scoped growth rate genuinely
      // differs from the program's.
      const current = getRevenueSummary(range);
      const prior = getRevenueSummary(baseComparison.priorRange);
      const scopedCurrent = current.recurring * recurringShare + current.enrollment * enrollmentShare;
      const scopedPrior = prior.recurring * recurringShare + prior.enrollment * enrollmentShare;
      if (scopedPrior <= 0) return null;
      return {
        deltaPercent: round1(((scopedCurrent - scopedPrior) / scopedPrior) * 100),
        priorRange: baseComparison.priorRange,
      };
    },

    getOutcomeSummary: (range) => {
      const base = getOutcomeSummary(range);
      return {
        goalCompletion: round1(clampPercent(base.goalCompletion + offsets.goal)),
        avgPoundsLost: round1(Math.max(0, base.avgPoundsLost + offsets.lost)),
        retention: round1(clampPercent(base.retention + offsets.retention)),
      };
    },

    getCohortRows: (range) =>
      getCohortRows(range).map((row) => ({
        ...row,
        avgLost: round1(Math.max(0, row.avgLost * offsets.cohortLostFactor)),
        retention: Math.round(clampPercent(row.retention + offsets.cohortRetention)),
      })),

    getMaintenanceConversionDelta: (range) =>
      Math.min(20, Math.max(3, getMaintenanceConversionDelta(range) + offsets.conversion)),
  };
}
