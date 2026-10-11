/**
 * HQ Diets & restrictions — what the network's patients are eating and what
 * they cannot eat, as aggregate counts only.
 *
 * Headline tiles (patients, on a diet, protocol / maintenance, severe
 * allergies, pending safety blocks, pregnancy conflicts, diet changes in the
 * range), the frameworks in use, the four lists with the most common items,
 * changes and blocks for the range, screening answers, and a per-practice
 * table. Choosing a practice narrows the whole page to it; the selection lives
 * in the URL (`?office=`) so a shared link restores the view. The CSV export
 * goes through the shared export jobs so it is scoped and logged like every
 * other file.
 *
 * Live only: signed-in HQ reads the rollup; loading, failure and
 * "unavailable for this scope" are explicit — nothing on this page is seeded,
 * and an unavailable figure is never drawn as zero.
 */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
import { AlertCircle, ArrowDown, ArrowUp, FileDown, Loader2, RefreshCw, X } from 'lucide-react';
import type { DietReportOfficeRow, DietRestrictionsResult, ExportKind } from '@workspace/api-client-react';
import { getGetHqDietRestrictionsQueryKey, getListExportsQueryKey, useGetHqDietRestrictions } from '@workspace/api-client-react';
import { CHIP_RISK, CHIP_WARM, SectionCard } from '@/components/patient/heritage';
import { AdminPage, MetricTile, PageHeader } from '@/components/admin/primitives';
import { DateRangeControl } from '@/components/layout/DateRangeControl';
import { ExportsPanel } from '@/components/exports/ExportsPanel';
import { apiErrorMessage } from '@/components/exports/ExportDownloads';
import { useSession } from '@/contexts/session';
import { formatRangeLabel, useDateRange } from '@/contexts/date-range';
import { useToast } from '@/hooks/use-toast';
import { formatDateKey } from '@/data/nutrition-data';
import type { OperationsDateRange } from '@/lib/date-range-keys';
import { formatLocalDate } from '@/lib/local-time';
import { formatUpdatedAt } from '@/lib/app-usage';
import { requestExportJob } from '@/lib/export-jobs';
import {
  type BarRow,
  DIET_REPORT_DEFINITIONS,
  DIET_REPORTING_PATH,
  DIET_RESTRICTIONS_EXPORT_KIND,
  fmtCount,
  frameworkRows,
  listRows,
  OFFICE_COLUMNS,
  type OfficeSortKey,
  officeTotals,
  screeningRows,
  shareLabel,
  sortOfficeRows,
  topItemRows,
} from '@/lib/diet-reporting';

export type DietReportingViewState = 'loading' | 'error' | 'ready';

interface DietReportingViewProps {
  state: DietReportingViewState;
  data: DietRestrictionsResult | undefined;
  range: OperationsDateRange;
  asOfLabel: string;
  updatedLabel: string | null;
  refreshing?: boolean;
  onRetry?: () => void;
  selectedOffice: string | null;
  onSelectOffice: (providerId: string | null) => void;
  /** Request the CSV through the export jobs; absent while signed out. */
  onExport?: () => void;
  exporting?: boolean;
}

export function DietReportingView({ state, data, range, asOfLabel, updatedLabel, refreshing = false, onRetry, selectedOffice, onSelectOffice, onExport, exporting = false }: DietReportingViewProps) {
  const rangeLabel = formatRangeLabel(range);
  const loading = state === 'loading';
  const failed = state === 'error';
  const counts = data?.counts ?? null;
  const noData = state === 'ready' && (!data || !data.available || !counts);
  const scopeLabel = data?.office?.name ?? (selectedOffice ? 'Selected practice' : 'All practices');
  const total = counts?.patients ?? 0;

  const tileValue = (value: number | undefined | null) =>
    loading ? '—' : failed ? 'Error' : value == null ? '—' : fmtCount(value);
  const tileDetail = (ready: string) =>
    loading ? 'Loading live data…' : failed ? 'Failed to load' : noData ? 'Unavailable for this scope' : ready;

  const frameworks = useMemo(() => frameworkRows(counts), [counts]);
  const lists = useMemo(() => listRows(counts), [counts]);
  const items = useMemo(() => topItemRows(counts), [counts]);
  const screening = useMemo(() => screeningRows(counts), [counts]);

  return (
    <AdminPage>
      <PageHeader
        kicker="THINNR HQ"
        title="Diets & restrictions"
        sub={
          <>
            <span data-testid="text-diet-report-asof">{asOfLabel}</span> · <span data-testid="text-diet-report-scope">{scopeLabel}</span> · Changes, blocks and screening within{' '}
            <span className="font-semibold text-navy" data-testid="text-diet-report-range">{rangeLabel}</span>; everything else as of today
            {updatedLabel && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1" data-testid="text-diet-report-updated" aria-live="polite">
                  {refreshing && <RefreshCw size={11} aria-hidden="true" className="animate-spin" />}
                  {updatedLabel}
                </span>
              </>
            )}
          </>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeControl />
            <button
              type="button"
              disabled={!onExport || exporting}
              onClick={onExport}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-xs transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              data-testid="button-diet-report-export"
            >
              {exporting ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileDown size={14} aria-hidden="true" />}
              Export CSV
            </button>
          </div>
        }
      />

      {selectedOffice && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs" data-testid="banner-diet-report-office">
          <span className="text-muted-foreground">Showing one practice:</span>
          <span className="font-semibold text-navy" data-testid="text-diet-report-office-name">{data?.office?.name ?? (loading ? 'Loading…' : selectedOffice)}</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-semibold text-navy transition hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onSelectOffice(null)}
            data-testid="button-diet-report-all-practices"
          >
            <X size={11} aria-hidden="true" /> Show all practices
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Diet headline counts">
        <MetricTile label="Patients" value={tileValue(counts?.patients)} detail={tileDetail('Activated, not closed')} testId="text-diet-report-patients" />
        <MetricTile label="On a diet" value={tileValue(counts?.onDiet)} detail={tileDetail(counts ? `${shareLabel(counts.onDiet, total)} · ${fmtCount(counts.justTracking)} just tracking · ${fmtCount(counts.noDiet)} not chosen` : '')} testId="text-diet-report-on-diet" />
        <MetricTile label="In protocol" value={tileValue(counts?.phases.protocol)} detail={tileDetail(counts ? `${fmtCount(counts.phases.maintenance)} in maintenance` : '')} testId="text-diet-report-protocol" />
        <MetricTile label="Severe allergy" value={tileValue(counts?.severeAllergyPatients)} detail={tileDetail(counts ? shareLabel(counts.severeAllergyPatients, total) : '')} testId="text-diet-report-severe" />
        <MetricTile label="Pending blocks" value={tileValue(counts?.blocks.pending)} detail={tileDetail('Safety blocks awaiting provider review')} testId="text-diet-report-pending" />
        <MetricTile label="Pregnancy conflicts" value={tileValue(counts?.pregnancyConflicts)} detail={tileDetail('Pregnant or trying on a pregnancy-blocked diet')} testId="text-diet-report-pregnancy" />
        <MetricTile label="Diet changes" value={tileValue(counts?.changes.total)} detail={tileDetail(counts ? `${fmtCount(counts.changes.byPatient)} by patients · ${fmtCount(counts.changes.byStaff)} by office staff · ${fmtCount(counts.changes.bySystem)} by system` : '')} testId="text-diet-report-changes" />
        <MetricTile label="Overrides" value={tileValue(counts?.blocks.overridden)} detail={tileDetail(counts ? `${fmtCount(counts.blocks.opened)} blocks opened · ${fmtCount(counts.blocks.rejected)} rejected` : '')} testId="text-diet-report-overrides" />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <SectionCard title="By framework" sub="Patients on each library diet right now. Just-tracking patients show as no diet chosen.">
          <BarList rows={frameworks} state={state} noData={noData} onRetry={onRetry} testId="diet-report-framework" emptyLabel="No activated patient in this scope — figures are unavailable, not zero." />
        </SectionCard>
        <SectionCard title="Lists and most common items" sub="Items currently on patient allergy, sensitivity, restriction and dislike lists. Severe allergies are flagged.">
          <BarList rows={lists} state={state} noData={noData} onRetry={onRetry} testId="diet-report-list" emptyLabel="Unavailable for this scope." />
          {state === 'ready' && !noData && items.length > 0 && (
            <div className="border-t border-border">
              <p className="px-5 pt-3 text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">Most common items</p>
              <BarList rows={items} state={state} noData={false} testId="diet-report-item" emptyLabel="" />
            </div>
          )}
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <SectionCard title="By practice" sub="Counts per office as of today. Sort any column; choose a practice to narrow the page.">
          {loading ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-diet-report-table-loading">Loading practices…</p>
          ) : failed ? (
            <div className="m-5"><ErrorNotice testId="text-diet-report-table-error" onRetry={onRetry} /></div>
          ) : noData ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-diet-report-table-unavailable">No practice has an activated patient in this scope — figures are unavailable, not zero.</p>
          ) : (
            <OfficeTable rows={data?.offices ?? []} total={officeTotals(data)} selectedOffice={selectedOffice} onSelectOffice={onSelectOffice} />
          )}
        </SectionCard>

        <SectionCard title="Screening answers" sub={`Yes and no answers recorded within ${rangeLabel}.`}>
          <div className="px-5 py-4">
            {loading ? (
              <p className="py-6 text-center text-xs text-muted-foreground" data-testid="text-diet-report-screening-loading">Loading…</p>
            ) : failed ? (
              <ErrorNotice testId="text-diet-report-screening-error" onRetry={onRetry} />
            ) : noData ? (
              <p className="py-6 text-center text-xs text-muted-foreground" data-testid="text-diet-report-screening-unavailable">Unavailable for this scope.</p>
            ) : (
              <ul className="space-y-3" aria-label="Screening answers" data-testid="list-diet-report-screening">
                {screening.map((row) => (
                  <li key={row.question} data-testid={`diet-report-screening-${row.question}`}>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-semibold text-navy">{row.label}</span>
                      <span className="tabular-nums text-navy">
                        <b data-testid={`diet-report-screening-yes-${row.question}`}>{fmtCount(row.yes)}</b> yes · {fmtCount(row.no)} no
                        {row.yesPct != null && <span className="ml-1 text-[10px] text-muted-foreground">({row.yesPct}% yes)</span>}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                      <div className="h-full rounded-full bg-[#b65c22]" style={{ width: `${row.yesPct ?? 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SectionCard>
      </div>

      {onExport && (
        <ExportsPanel kinds={[DIET_RESTRICTIONS_EXPORT_KIND]} hideRequestForm title="Report downloads" className="mt-5" />
      )}

      <div className="mt-5">
        <SectionCard title="How these numbers are counted" sub="Every figure on this page follows these rules, network-wide and per practice.">
          <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-2" data-testid="text-diet-report-definitions">
            {DIET_REPORT_DEFINITIONS.map((definition) => (
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

function BarList({ rows, state, noData, onRetry, testId, emptyLabel }: { rows: BarRow[]; state: DietReportingViewState; noData: boolean; onRetry?: () => void; testId: string; emptyLabel: string }) {
  if (state === 'loading') return <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid={`text-${testId}-loading`}>Loading…</p>;
  if (state === 'error') return <div className="m-5"><ErrorNotice testId={`text-${testId}-error`} onRetry={onRetry} /></div>;
  if (noData) return <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid={`text-${testId}-unavailable`}>{emptyLabel}</p>;
  return (
    <ul className="space-y-2.5 px-5 py-4" data-testid={`list-${testId}`}>
      {rows.map((row) => (
        <li key={row.key} data-testid={`${testId}-${row.key}`}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 font-semibold text-navy">
              <span className="truncate">{row.label}</span>
              {row.tone === 'severe' && <span className={CHIP_RISK}>Severe</span>}
              {row.tone === 'mild' && <span className={CHIP_WARM}>Mild</span>}
            </span>
            <span className="shrink-0 tabular-nums text-navy">
              <b data-testid={`${testId}-value-${row.key}`}>{fmtCount(row.value)}</b>
              {row.sharePct != null && <span className="ml-1 text-[10px] text-muted-foreground">({row.sharePct}%)</span>}
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div className="h-full rounded-full bg-primary" style={{ width: `${row.widthPct}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function OfficeTable({ rows, total, selectedOffice, onSelectOffice }: { rows: DietReportOfficeRow[]; total: DietReportOfficeRow | null; selectedOffice: string | null; onSelectOffice: (providerId: string | null) => void }) {
  const [sortKey, setSortKey] = useState<OfficeSortKey>('patients');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const sorted = useMemo(() => sortOfficeRows(rows, sortKey, direction), [rows, sortKey, direction]);
  const toggle = (key: OfficeSortKey) => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setDirection(key === 'name' ? 'asc' : 'desc'); }
  };
  const cell = (row: DietReportOfficeRow, key: OfficeSortKey) => (key === 'name' ? row.name : fmtCount(row[key]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs" data-testid="table-diet-report-offices">
        <thead>
          <tr className="border-b border-border text-left text-[10px] font-bold uppercase tracking-[.12em] text-muted-foreground">
            {OFFICE_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className={`px-4 py-2.5 ${column.numeric ? 'text-right' : ''}`} aria-sort={sortKey === column.key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="inline-flex items-center gap-1 hover:text-navy" onClick={() => toggle(column.key)} data-testid={`button-diet-report-sort-${column.key}`}>
                  {column.label}
                  {sortKey === column.key && (direction === 'asc' ? <ArrowUp size={10} aria-hidden="true" /> : <ArrowDown size={10} aria-hidden="true" />)}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.providerId} className={`border-b border-border/60 ${selectedOffice === row.providerId ? 'bg-accent/40' : ''}`} data-testid={`row-diet-report-office-${row.providerId}`}>
              {OFFICE_COLUMNS.map((column) => (
                <td key={column.key} className={`px-4 py-2.5 tabular-nums ${column.numeric ? 'text-right text-navy' : ''}`}>
                  {column.key === 'name' ? (
                    <button type="button" className="font-semibold text-navy underline-offset-2 hover:underline" onClick={() => onSelectOffice(selectedOffice === row.providerId ? null : row.providerId)} data-testid={`button-diet-report-office-${row.providerId}`}>
                      {row.name}
                    </button>
                  ) : cell(row, column.key)}
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={OFFICE_COLUMNS.length} className="px-4 py-6 text-center text-muted-foreground" data-testid="text-diet-report-offices-empty">No practice has an activated patient in this scope.</td></tr>
          )}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t border-border bg-secondary/60 font-semibold text-navy" data-testid="row-diet-report-office-total">
              {OFFICE_COLUMNS.map((column) => (
                <td key={column.key} className={`px-4 py-2.5 tabular-nums ${column.numeric ? 'text-right' : ''}`}>{cell(total, column.key)}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function ErrorNotice({ testId, onRetry }: { testId: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive" role="alert" data-testid={testId}>
      <AlertCircle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        Diets & restrictions could not be loaded.{' '}
        {onRetry && <button type="button" className="underline" onClick={onRetry}>Try again</button>}
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
    navigate(`${DIET_REPORTING_PATH}${next.toString() ? `?${next}` : ''}`, { replace: true });
  };
  return [selected, select];
}

function LiveDietReporting() {
  const { authUser } = useSession();
  const { range } = useDateRange();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedOffice, selectOffice] = useSelectedOffice();
  const [exporting, setExporting] = useState(false);
  const params = { start: range.start, end: range.end, ...(selectedOffice ? { office: selectedOffice } : {}) };
  const query = useGetHqDietRestrictions(params, {
    query: { queryKey: [...getGetHqDietRestrictionsQueryKey(params), authUser?.id], retry: 1 },
  });
  // A failed read is reported, never papered over with the previous figures.
  const state: DietReportingViewState = query.isPending ? 'loading' : query.isError ? 'error' : 'ready';
  const asOfLabel = query.data?.asOf ? formatLocalDate(query.data.asOf) : 'Live';

  const exportCsv = async () => {
    setExporting(true);
    try {
      const result = await requestExportJob({ kind: DIET_RESTRICTIONS_EXPORT_KIND as ExportKind, office: selectedOffice, start: range.start, end: range.end });
      await queryClient.invalidateQueries({ queryKey: getListExportsQueryKey() });
      toast({ variant: 'success', title: `${result.job.label} export queued`, description: `${formatDateKey(range.start, true)} to ${formatDateKey(range.end, true)}. It appears under Report downloads as soon as the file is ready.` });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Export not requested', description: apiErrorMessage(error, 'The export could not be requested right now.') });
    } finally {
      setExporting(false);
    }
  };

  return (
    <DietReportingView
      state={state}
      data={query.data}
      range={range}
      asOfLabel={asOfLabel}
      updatedLabel={formatUpdatedAt(query.dataUpdatedAt)}
      refreshing={query.isFetching && !query.isPending}
      onRetry={() => query.refetch()}
      selectedOffice={selectedOffice}
      onSelectOffice={selectOffice}
      onExport={() => void exportCsv()}
      exporting={exporting}
    />
  );
}

export default function DietReporting() {
  const { authStatus } = useSession();
  if (authStatus !== 'signed-in') {
    return (
      <AdminPage>
        <PageHeader kicker="THINNR HQ" title="Diets & restrictions" sub="Network-wide diets, phases, allergies and restrictions as aggregate counts." action={<DateRangeControl />} />
        <p className="rounded-md border border-border bg-secondary px-4 py-3 text-xs text-muted-foreground" data-testid="text-diet-report-signed-out">
          Sign in with an HQ account to see live diet figures. This page has no seeded preview.
        </p>
      </AdminPage>
    );
  }
  return <LiveDietReporting />;
}
