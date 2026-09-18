/**
 * Guided-demo App usage Insights.
 *
 * The signed-out HQ demo has no event ledger, so the Insights section reads
 * seeded day × local-hour buckets instead. The buckets come from the same
 * shared seed the rule engine ships (per-dataset time-of-day profiles: meal
 * peaks for food logs, mornings for weigh-ins, evenings for coach chats) and
 * are then assembled by the SAME `assembleInsights` the API uses, so the
 * demo shows exactly the shapes live data will — anchored to the fixed demo
 * date, never the viewer's clock, and issuing no live request.
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

export function demoAppUsageInsights(dataset: InsightsDataset, range: OperationsDateRange, officeId: string | null): AppUsageInsights {
  const office = officeId ? DEMO_INSIGHTS_OFFICES.find((candidate) => candidate.id === officeId) ?? null : null;
  const seeded = DEMO_APP_USAGE_OFFICES.find((candidate) => candidate.providerId === office?.id);
  const patients = seeded ? seeded.patients : DEMO_APP_USAGE_OFFICES.reduce((sum, candidate) => sum + candidate.patients, 0);
  const salt = office?.id ?? '';
  const hourlySince = dataset === 'food_log' || dataset === 'water_log' ? DEMO_FOOD_WATER_HOURLY_SINCE : DEMO_FIRST_DAY;
  const clipHours = (buckets: ReturnType<typeof seedDemoBuckets>) =>
    buckets.map((bucket) => (bucket.day < hourlySince ? { ...bucket, hour: -1 } : bucket));
  return assembleInsights({
    dataset,
    range: { start: range.start, end: range.end },
    asOf: DEMO_APP_USAGE_AS_OF,
    office,
    bounds: { firstDay: DEMO_FIRST_DAY, firstHourlyDay: hourlySince },
    current: clipHours(seedDemoBuckets(dataset, range, patients, salt)),
    previous: clipHours(seedDemoBuckets(dataset, previousRangeOf(range), patients, salt)),
  }) as AppUsageInsights;
}
