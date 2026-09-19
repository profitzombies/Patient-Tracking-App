/**
 * Guided-demo App usage Insights.
 *
 * The signed-out demo has no event ledger, so the Insights section reads
 * seeded day × local-hour buckets instead. The buckets come from the same
 * shared seed the rule engine ships (per-dataset time-of-day profiles: meal
 * peaks for food logs, mornings for weigh-ins, evenings for coach chats) and
 * are then assembled by the SAME `assembleInsights` the API uses, so the
 * demo shows exactly the shapes live data will — anchored to the fixed demo
 * date, never the viewer's clock, and issuing no live request.
 *
 * Two callers share one seed so their figures cannot drift:
 * - the HQ page (`demoAppUsageInsights`): all four seeded practices, or one
 *   of them through the practice filter;
 * - the office analytics page (`demoOfficeAppUsageInsights`): the whole
 *   program in the standalone office demo (632 patients, like every other
 *   unscoped office figure), or the drilled-in account's own slice — the
 *   same slice HQ sees when it filters Insights to that practice.
 */
import type { AppUsageInsights } from '@workspace/api-client-react';
import { assembleInsights, previousRangeOf, seedDemoBuckets, type InsightsDataset } from '@workspace/app-usage-insights';
import type { OperationsDateRange } from '../../lib/date-range-keys';
import { DEMO_APP_USAGE_AS_OF, DEMO_APP_USAGE_OFFICES } from './app-usage-demo';

/** Food and water hour-of-day tracking "starts" this many days before the demo date (so the tracked-since note shows). */
const DEMO_FOOD_WATER_HOURLY_SINCE = '2026-09-14';
const DEMO_FIRST_DAY = '2025-10-06';

/** Demo practice options for the Insights filter — the same four seeded offices as the table. */
export const DEMO_INSIGHTS_OFFICES = DEMO_APP_USAGE_OFFICES.map((office) => ({ id: office.providerId, name: office.officeName }));

const PROGRAM_PATIENTS = DEMO_APP_USAGE_OFFICES.reduce((sum, candidate) => sum + candidate.patients, 0);

interface DemoInsightsScope {
  /** Named practice the figures describe, or null for the whole program. */
  office: { id: string; name: string } | null;
  /** Activated patients the seed scales with. */
  patients: number;
}

function seedInsights(dataset: InsightsDataset, range: OperationsDateRange, scope: DemoInsightsScope): AppUsageInsights {
  const salt = scope.office?.id ?? '';
  const hourlySince = dataset === 'food_log' || dataset === 'water_log' ? DEMO_FOOD_WATER_HOURLY_SINCE : DEMO_FIRST_DAY;
  const clipHours = (buckets: ReturnType<typeof seedDemoBuckets>) =>
    buckets.map((bucket) => (bucket.day < hourlySince ? { ...bucket, hour: -1 } : bucket));
  return assembleInsights({
    dataset,
    range: { start: range.start, end: range.end },
    asOf: DEMO_APP_USAGE_AS_OF,
    office: scope.office,
    bounds: { firstDay: DEMO_FIRST_DAY, firstHourlyDay: hourlySince },
    current: clipHours(seedDemoBuckets(dataset, range, scope.patients, salt)),
    previous: clipHours(seedDemoBuckets(dataset, previousRangeOf(range), scope.patients, salt)),
  }) as AppUsageInsights;
}

/** HQ demo: every practice (officeId null) or one of the four seeded offices. Unknown ids fall back to all. */
export function demoAppUsageInsights(dataset: InsightsDataset, range: OperationsDateRange, officeId: string | null): AppUsageInsights {
  const office = officeId ? DEMO_INSIGHTS_OFFICES.find((candidate) => candidate.id === officeId) ?? null : null;
  const seeded = DEMO_APP_USAGE_OFFICES.find((candidate) => candidate.providerId === office?.id);
  return seedInsights(dataset, range, { office, patients: seeded ? seeded.patients : PROGRAM_PATIENTS });
}

/** What the office analytics page knows about its demo scope (null = the standalone office demo). */
export interface DemoOfficeInsightsScope {
  id: string;
  officeName: string;
  activePatientCount: number | null;
}

/**
 * Office demo: the program-wide seed unscoped, or the drilled-in account's
 * slice — byte-identical to the HQ page filtered to that practice when the
 * account is one of the four seeded offices; session-added accounts seed
 * from their own patient count so a drill-in never shows another office's
 * figures.
 */
export function demoOfficeAppUsageInsights(dataset: InsightsDataset, range: OperationsDateRange, scope: DemoOfficeInsightsScope | null): AppUsageInsights {
  if (!scope) return seedInsights(dataset, range, { office: null, patients: PROGRAM_PATIENTS });
  const seeded = DEMO_APP_USAGE_OFFICES.find((candidate) => candidate.providerId === scope.id);
  return seedInsights(dataset, range, {
    office: { id: scope.id, name: seeded?.officeName ?? scope.officeName },
    patients: seeded ? seeded.patients : Math.max(0, scope.activePatientCount ?? 0),
  });
}
