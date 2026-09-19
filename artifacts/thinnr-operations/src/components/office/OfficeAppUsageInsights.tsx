/**
 * Office analytics — "When patients use the app" for ONE practice.
 *
 * The same Insights section HQ sees on /admin/app-usage, without the
 * practice selector: the office is already decided by who is signed in (or
 * which office HQ drilled into), so there is nothing to pick.
 *
 * - Live: signed-in office staff read /office/app-usage-insights for their
 *   own office; HQ drilling in (/admin/accounts/:id/office) passes ?office=
 *   like every other live office screen. Loading and failure are explicit.
 * - Demo: the deterministic seed — the whole program in the standalone
 *   office demo, the drilled-in account's own slice under HQ — anchored to
 *   the demo date and issuing no request.
 */
import { useState } from 'react';
import { getGetOfficeAppUsageInsightsQueryKey, useGetOfficeAppUsageInsights } from '@workspace/api-client-react';
import type { InsightsDataset } from '@workspace/app-usage-insights';
import { AppUsageInsightsSection } from '@/components/admin/AppUsageInsights';
import { useSession } from '@/contexts/session';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { useScopedAppUsageInsights } from '@/data/scoped-data';
import { APP_USAGE_REFRESH_MS } from '@/lib/app-usage';

/** App opens first: the broadest "when are they here" signal for staffing and outreach. */
export const DEFAULT_OFFICE_INSIGHTS_DATASET: InsightsDataset = 'app_open';

export function LiveOfficeAppUsageInsights({ liveOffice }: { liveOffice: string | null }) {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const [dataset, setDataset] = useState<InsightsDataset>(DEFAULT_OFFICE_INSIGHTS_DATASET);
  const params = { dataset, start: range.start, end: range.end, office: liveOffice ?? undefined };
  const insights = useGetOfficeAppUsageInsights(params, {
    query: {
      queryKey: [...getGetOfficeAppUsageInsightsQueryKey(params), authUser?.id],
      retry: 1,
      refetchInterval: APP_USAGE_REFRESH_MS,
      placeholderData: (previous) => previous,
    },
  });
  const state = insights.isPending ? 'loading' : insights.isError ? 'error' : 'ready';
  return (
    <AppUsageInsightsSection
      state={state}
      data={insights.data}
      dataset={dataset}
      onDataset={setDataset}
      rangeLabel={formatRangeLabel(range)}
      onRetry={() => insights.refetch()}
    />
  );
}

export function DemoOfficeAppUsageInsights() {
  const { range } = useDateRange();
  const [dataset, setDataset] = useState<InsightsDataset>(DEFAULT_OFFICE_INSIGHTS_DATASET);
  const data = useScopedAppUsageInsights(dataset, range);
  return <AppUsageInsightsSection state="ready" data={data} dataset={dataset} onDataset={setDataset} rangeLabel={formatRangeLabel(range)} />;
}
