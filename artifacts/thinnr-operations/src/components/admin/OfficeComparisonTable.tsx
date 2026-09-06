/**
 * Live per-office comparison table for the HQ overview.
 *
 * Every metric header sorts; the rank column ranks on the active sort metric
 * (1 = best, honouring lower-is-better columns). Each figure is a link into
 * the matching list for that office, the office name opens its account
 * detail, and the sparkline shows the office's rolling 7-day engaged-patient
 * trend across the range (its last point is the Engaged column). Offices with
 * no data for the range render "Unavailable" rather than zeroes.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { OfficeComparisonRow } from '@workspace/api-client-react';
import { Sparkline } from '@/components/admin/Sparkline';
import {
  DEFAULT_COMPARISON_SORT,
  DEFAULT_RANK_KEY,
  OFFICE_METRIC_COLUMNS,
  drillHref,
  formatMetric,
  hqOfficeRoot,
  metricValue,
  rankOffices,
  seriesValues,
  sortComparisonRows,
  unavailableReason,
  type ComparisonSort,
  type ComparisonSortKey,
  type OfficeMetricKey,
} from '@/lib/office-analytics';

interface OfficeComparisonTableProps {
  rows: OfficeComparisonRow[];
  rangeEnd: string;
}

const HEADER_BTN =
  'inline-flex items-center gap-1 rounded-sm text-left font-bold uppercase tracking-[.12em] transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const CELL_LINK =
  'inline-block rounded-sm px-1 -mx-1 tabular-nums text-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function OfficeComparisonTable({ rows, rangeEnd }: OfficeComparisonTableProps) {
  const [sort, setSort] = useState<ComparisonSort>(DEFAULT_COMPARISON_SORT);

  const sorted = useMemo(() => sortComparisonRows(rows, sort), [rows, sort]);
  const rankKey: OfficeMetricKey = sort.key === 'officeName' ? DEFAULT_RANK_KEY : sort.key;
  const ranks = useMemo(() => rankOffices(rows, rankKey), [rows, rankKey]);
  const rankLabel = OFFICE_METRIC_COLUMNS.find((column) => column.key === rankKey)?.label ?? 'Active';

  const toggleSort = (key: ComparisonSortKey) => {
    setSort((current) => {
      if (current.key !== key) return { key, direction: key === 'officeName' ? 'asc' : 'desc' };
      return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  };

  const ariaSortFor = (key: ComparisonSortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  const SortIcon = ({ column }: { column: ComparisonSortKey }) => {
    if (sort.key !== column) return <ArrowUpDown size={11} aria-hidden="true" className="opacity-50" />;
    return sort.direction === 'asc'
      ? <ArrowUp size={11} aria-hidden="true" className="text-primary" />
      : <ArrowDown size={11} aria-hidden="true" className="text-primary" />;
  };

  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-office-comparison-empty">
        No enabled provider offices yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-xs" data-testid="table-office-comparison">
        <caption className="sr-only">
          Office comparison for the selected range. Rank is on {rankLabel}. Each figure links to the matching patient list.
        </caption>
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground">
            <th scope="col" className="px-4 py-3 font-bold uppercase tracking-[.12em]" aria-label={`Rank on ${rankLabel}`}>
              #
            </th>
            <th scope="col" className="px-3 py-3" aria-sort={ariaSortFor('officeName')}>
              <button type="button" className={HEADER_BTN} onClick={() => toggleSort('officeName')} data-testid="sort-officeName">
                Office <SortIcon column="officeName" />
              </button>
            </th>
            {OFFICE_METRIC_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-3 text-right" aria-sort={ariaSortFor(column.key)}>
                <button
                  type="button"
                  className={`${HEADER_BTN} justify-end`}
                  onClick={() => toggleSort(column.key)}
                  title={column.help}
                  aria-label={`${column.label}: ${column.help}. Sort by ${column.label}`}
                  data-testid={`sort-${column.key}`}
                >
                  {column.short} <SortIcon column={column.key} />
                </button>
              </th>
            ))}
            <th scope="col" className="px-4 py-3 text-right font-bold uppercase tracking-[.12em]" title="Rolling 7-day engaged patients, day by day across the range">
              Engaged trend
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const rank = ranks.get(row.providerId) ?? null;
            const officeRoot = hqOfficeRoot(row.providerId);
            return (
              <tr
                key={row.providerId}
                className="border-b border-border transition hover:bg-accent/40 last:border-b-0"
                data-testid={`row-office-comparison-${row.providerId}`}
                data-available={row.available ? 'true' : 'false'}
              >
                <td className="px-4 py-3 font-semibold tabular-nums text-muted-foreground" data-testid={`rank-${row.providerId}`}>
                  {rank ?? '—'}
                </td>
                <td className="px-3 py-3">
                  <Link
                    href={`/admin/accounts/${row.providerId}`}
                    className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`link-office-${row.providerId}`}
                  >
                    <b className="block text-xs font-semibold text-navy">{row.officeName}</b>
                    <small className="text-[10px] text-muted-foreground">{row.providerName}</small>
                  </Link>
                </td>
                {row.available ? (
                  OFFICE_METRIC_COLUMNS.map((column) => {
                    const value = metricValue(row.metrics, column.key);
                    const text = formatMetric(column.key, value);
                    return (
                      <td key={column.key} className="px-3 py-3 text-right" data-testid={`cell-${column.key}-${row.providerId}`}>
                        {value == null ? (
                          <span className="text-muted-foreground" title="No recorded weights in this range">—</span>
                        ) : (
                          <Link
                            href={drillHref(officeRoot, column.drill)}
                            className={CELL_LINK}
                            aria-label={`${text} ${column.label.toLowerCase()} at ${row.officeName}. Open the matching list`}
                            data-testid={`drill-${column.key}-${row.providerId}`}
                          >
                            {text}
                          </Link>
                        )}
                      </td>
                    );
                  })
                ) : (
                  <td colSpan={OFFICE_METRIC_COLUMNS.length} className="px-3 py-3 text-right">
                    <span
                      className="inline-block rounded border border-border bg-secondary px-2 py-1 text-[10px] font-semibold text-muted-foreground"
                      title={unavailableReason(row.firstPatientDate, rangeEnd)}
                      data-testid={`text-unavailable-${row.providerId}`}
                    >
                      Unavailable for this range
                    </span>
                  </td>
                )}
                <td className="px-4 py-3 text-right">
                  <Sparkline
                    values={row.available ? seriesValues(row.series, 'engagedPatients') : []}
                    label={`${row.officeName} engaged patients`}
                    testId={`sparkline-${row.providerId}`}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
