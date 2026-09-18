/**
 * HQ Patient retention — how many patients each practice onboarded, and how
 * many are still active, still buying, or have gone quiet.
 *
 * Four headline tiles as of the range end (onboarded, active in the trailing
 * 30 days, buying in the trailing 90 days, inactive), a trend across the range
 * (weekly up to 120 days, monthly beyond), a per-practice table with an
 * "all practices" total row, and the inactive patients tiered by how long
 * they have been quiet. Choosing a practice narrows the whole page to it; the
 * selection lives in the URL (`?office=`) so a shared link restores the view.
 *
 * Signed-in HQ reads the live rollup; loading, failure and "unavailable for
 * this range" are explicit — the page never falls back to seeded numbers.
 * The signed-out guided demo renders the same screen from the deterministic
 * seeded dataset (anchored to the demo date) and issues no live request.
 */
import { useMemo } from 'react';
import { useLocation, useSearch } from 'wouter';
import { AlertCircle, RefreshCw, X } from 'lucide-react';
import type { PatientRetentionResult } from '@workspace/api-client-react';
import { getGetHqPatientRetentionQueryKey, useGetHqPatientRetention } from '@workspace/api-client-react';
import { SectionCard } from '@/components/patient/heritage';
import { AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { PatientRetentionTable } from '@/components/admin/PatientRetentionTable';
import { AreaChart, CHART_COLORS } from '@/components/billing/hq/RevenueCharts';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { useSession } from '@/contexts/session';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { DEMO_RETENTION_OFFICE_OPTIONS, demoPatientRetention } from '@/data/hq/patient-retention-demo';
import { formatDateKey } from '@/data/nutrition-data';
import { DEMO_TODAY_KEY, type OperationsDateRange } from '@/lib/date-range-keys';
import { formatLocalDate } from '@/lib/local-time';
import { formatUpdatedAt } from '@/lib/app-usage';
import {
  RETENTION_DEFINITIONS,
  countRetentionUnavailable,
  inactiveTierRows,
  periodNoun,
  retentionChartSeries,
  retentionPointLabel,
  retentionTotalCounts,
  shareOfOnboarded,
} from '@/lib/patient-retention';

const fmt = (value: number) => value.toLocaleString('en-US');

export const PATIENT_RETENTION_PATH = '/admin/patient-retention';

export type PatientRetentionViewState = 'loading' | 'error' | 'ready';

interface PatientRetentionViewProps {
  state: PatientRetentionViewState;
  data: PatientRetentionResult | undefined;
  range: OperationsDateRange;
  /** Header line under the title: the "as of" date for live, the anchor for the demo. */
  asOfLabel: string;
  /** "Updated 12:04:31 PM" for live reads; the demo shows its anchor instead. */
  updatedLabel: string | null;
  refreshing?: boolean;
  onRetry?: () => void;
  selectedOffice: string | null;
  onSelectOffice: (providerId: string | null) => void;
}

/** Shared presentation for the live and demo branches — the data source is the only difference. */
export function PatientRetentionView({ state, data, range, asOfLabel, updatedLabel, refreshing = false, onRetry, selectedOffice, onSelectOffice }: PatientRetentionViewProps) {
  const rangeLabel = formatRangeLabel(range);
  const loading = state === 'loading';
  const failed = state === 'error';
  const network = data?.network;
  const counts = network?.counts ?? null;
  const rows = data?.offices ?? [];
  const noData = state === 'ready' && (!network || !network.available);
  const unavailable = countRetentionUnavailable(rows);
  const period = data?.period ?? 'week';
  const scopeLabel = data?.office?.name ?? (selectedOffice ? 'Selected practice' : 'All practices');

  const tileValue = (value: number | undefined | null) =>
    loading ? '—' : failed ? 'Error' : value == null ? '—' : fmt(value);
  const tileDetail = (ready: string) =>
    loading ? 'Loading live data…' : failed ? 'Failed to load' : noData ? 'Unavailable for this range' : ready;

  const chart = useMemo(() => retentionChartSeries(network?.series ?? []), [network?.series]);
  const tiers = inactiveTierRows(counts);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title="Patient retention"
        sub={
          <>
            <span data-testid="text-retention-asof">{asOfLabel}</span> · <span data-testid="text-retention-scope">{scopeLabel}</span> · Patients as of the end of{' '}
            <span className="font-semibold text-navy" data-testid="text-retention-range">{rangeLabel}</span>
            {updatedLabel && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1" data-testid="text-retention-updated" aria-live="polite">
                  {refreshing && <RefreshCw size={11} aria-hidden="true" className="animate-spin" />}
                  {updatedLabel}
                </span>
              </>
            )}
          </>
        }
        action={<DateRangeControl />}
      />

      {selectedOffice && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs" data-testid="banner-retention-office">
          <span className="text-muted-foreground">Showing one practice:</span>
          <span className="font-semibold text-navy" data-testid="text-retention-office-name">{data?.office?.name ?? (loading ? 'Loading…' : selectedOffice)}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-semibold text-navy transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelectOffice(null)}
            data-testid="button-retention-all-practices"
          >
            <X size={11} aria-hidden="true" /> Show all practices
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Patient lifecycle">
        <MetricTile
          label="Onboarded"
          value={tileValue(counts?.onboarded)}
          detail={tileDetail(counts ? `Claimed, activated accounts by ${formatDateKey(range.end, true)}` : '')}
          testId="text-retention-onboarded"
        />
        <MetricTile
          label="Active"
          value={tileValue(counts?.active)}
          detail={tileDetail(counts ? `Used the app in the last 30 days · ${shareOfOnboarded(counts.activePct)}` : '')}
          testId="text-retention-active"
        />
        <MetricTile
          label="Buying"
          value={tileValue(counts?.buying)}
          detail={tileDetail(counts ? `Paid order or active subscription in the last 90 days · ${shareOfOnboarded(counts.buyingPct)}` : '')}
          testId="text-retention-buying"
        />
        <MetricTile
          label="Inactive"
          value={tileValue(counts?.inactive)}
          detail={tileDetail(counts ? `No app activity for 30+ days · ${shareOfOnboarded(counts.onboarded > 0 ? 100 - (counts.activePct ?? 0) : null)}` : '')}
          testId="text-retention-inactive"
        />
      </div>

      <div className="mt-5">
        <SectionCard
          title="Retention over time"
          sub={`Onboarded, active, buying and inactive patients at the end of each ${periodNoun(period)} across ${rangeLabel}. Hover a point for the exact figures.`}
        >
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-chart-loading">Loading patient retention…</p>
            ) : failed ? (
              <ErrorNotice testId="text-retention-chart-error" onRetry={onRetry} />
            ) : noData ? (
              <p className="py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-chart-unavailable">
                No practice had an onboarded patient by the end of this range — figures are unavailable, not zero. Try a later range.
              </p>
            ) : (
              <AreaChart
                title="Patient retention"
                dates={chart.dates}
                series={[
                  { key: 'onboarded', label: 'Onboarded', color: CHART_COLORS.gross, values: chart.onboarded },
                  { key: 'active', label: 'Active', color: CHART_COLORS.count, values: chart.active },
                  { key: 'buying', label: 'Buying', color: CHART_COLORS.profit, values: chart.buying },
                  { key: 'inactive', label: 'Inactive', color: CHART_COLORS.fees, values: chart.inactive },
                ]}
                unit="count"
                height={240}
                formatLabel={(key) => retentionPointLabel(network?.series ?? [], period, key)}
                labelCount={Math.min(8, chart.dates.length)}
                emptyLabel="No onboarded patients in this range yet"
                testId="chart-patient-retention"
              />
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SectionCard
          title="By practice"
          sub={`Lifecycle counts per office as of ${formatDateKey(range.end, true)}. Sort any column; choose a practice to narrow the page.`}
        >
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-table-loading">Loading practices…</p>
          ) : failed ? (
            <div className="m-5">
              <ErrorNotice testId="text-retention-table-error" onRetry={onRetry} />
            </div>
          ) : (
            <>
              {unavailable > 0 && (
                <p className="border-b border-border bg-secondary px-5 py-2 text-[11px] text-muted-foreground" data-testid="text-retention-unavailable-note">
                  {unavailable === rows.length
                    ? 'No office has an onboarded patient in this range — figures are unavailable, not zero. Try a later range.'
                    : `${unavailable} of ${rows.length} offices have no onboarded patient in this range and are shown as unavailable.`}
                </p>
              )}
              <PatientRetentionTable rows={rows} total={retentionTotalCounts(data)} rangeEnd={range.end} selectedOffice={selectedOffice} onSelectOffice={onSelectOffice} />
            </>
          )}
        </SectionCard>

        <SectionCard title="Inactive by time quiet" sub={`How long the ${loading || failed || !counts ? '' : `${fmt(counts.inactive)} `}inactive patients have gone without opening the app.`}>
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-6 text-center text-xs text-muted-foreground" data-testid="text-retention-tiers-loading">Loading…</p>
            ) : failed ? (
              <ErrorNotice testId="text-retention-tiers-error" onRetry={onRetry} />
            ) : noData ? (
              <p className="py-6 text-center text-xs text-muted-foreground" data-testid="text-retention-tiers-unavailable">Unavailable for this range.</p>
            ) : (
              <ul className="space-y-3" aria-label="Inactive patients by days quiet" data-testid="list-retention-tiers">
                {tiers.map((tier) => (
                  <li key={tier.key} data-testid={`retention-tier-${tier.key}`}>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-semibold text-navy">{tier.label}</span>
                      <span className="tabular-nums text-navy">
                        <b data-testid={`retention-tier-value-${tier.key}`}>{fmt(tier.value)}</b>
                        {tier.pct != null && <span className="ml-1 text-[10px] text-muted-foreground">({tier.pct}%)</span>}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                      <div className="h-full rounded-full bg-[#b65c22]" style={{ width: `${tier.pct ?? 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>
      </div>

      <div className="mt-5">
        <SectionCard title="How these numbers are counted" sub="Every figure on this page follows these rules, network-wide and per practice.">
          <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2" data-testid="text-retention-definitions">
            {RETENTION_DEFINITIONS.map((definition) => (
              <div key={definition.term}>
                <dt className="font-bold uppercase tracking-[.12em] text-navy">{definition.term}</dt>
                <dd className="mt-0.5 max-w-[70ch]">{definition.text}</dd>
              </div>
            ))}
          </dl>
        </SectionCard>
      </div>
    </AdminPage>
  );
}

function ErrorNotice({ testId, onRetry }: { testId: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid={testId}>
      <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        Patient retention could not be loaded.{' '}
        {onRetry && (
          <button type="button" className="underline" onClick={onRetry}>Try again</button>
        )}
      </span>
    </div>
  );
}

/** The narrowed practice lives in the URL (`?office=`), replace-navigated so Back is not spammed. */
function useSelectedOffice(): [string | null, (providerId: string | null) => void] {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const office = params.get('office');
  const selected = office && office.trim() !== '' ? office.trim() : null;
  const select = (providerId: string | null) => {
    const next = new URLSearchParams(search);
    if (providerId) next.set('office', providerId);
    else next.delete('office');
    navigate(`${PATIENT_RETENTION_PATH}${next.toString() ? `?${next}` : ''}`, { replace: true });
  };
  return [selected, select];
}

function LivePatientRetention() {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const [selectedOffice, selectOffice] = useSelectedOffice();
  const params = { start: range.start, end: range.end, ...(selectedOffice ? { office: selectedOffice } : {}) };
  const query = useGetHqPatientRetention(params, {
    query: {
      queryKey: [...getGetHqPatientRetentionQueryKey(params), authUser?.id],
      retry: 1,
    },
  });
  // A failed read is reported, never papered over with the previous figures.
  const state: PatientRetentionViewState = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';
  const asOfLabel = query.data?.asOf ? formatLocalDate(query.data.asOf) : 'Live';
  return (
    <PatientRetentionView
      state={state}
      data={query.data}
      range={range}
      asOfLabel={asOfLabel}
      updatedLabel={formatUpdatedAt(query.dataUpdatedAt)}
      refreshing={query.isFetching && !query.isPending}
      onRetry={() => query.refetch()}
      selectedOffice={selectedOffice}
      onSelectOffice={selectOffice}
    />
  );
}

function DemoPatientRetention() {
  const { range } = useDateRange();
  const [selectedOffice, selectOffice] = useSelectedOffice();
  // A stale link to an unknown seeded office falls back to every practice.
  const known = selectedOffice !== null && DEMO_RETENTION_OFFICE_OPTIONS.some((office) => office.id === selectedOffice) ? selectedOffice : null;
  const data = useMemo(() => demoPatientRetention(range, known), [range, known]);
  return (
    <PatientRetentionView
      state="ready"
      data={data}
      range={range}
      asOfLabel={formatDateKey(DEMO_TODAY_KEY, true)}
      updatedLabel="Demo figures"
      selectedOffice={known}
      onSelectOffice={selectOffice}
    />
  );
}

export default function PatientRetention() {
  const { authStatus } = useSession();
  return authStatus === 'signed-in' ? <LivePatientRetention /> : <DemoPatientRetention />;
}
