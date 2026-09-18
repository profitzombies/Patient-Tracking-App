/**
 * Per-practice patient retention for the HQ Patient retention page.
 *
 * Every metric header sorts; the rank column ranks on the active sort metric
 * (1 = highest). The office name is the row's single link (its account page)
 * — figures are aggregate counts with no per-patient drill-down — and a
 * separate "Focus" button narrows the page's chart and tiles to that
 * practice. The sparkline is the office's active-patient trend across the
 * range. Offices with no patient by the range end render "Unavailable"
 * rather than zeroes, and the table foot carries the all-practices total.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { PatientRetentionOfficeRow } from '@workspace/api-client-react';
import { Sparkline } from '@/components/admin/Sparkline';
import {
  DEFAULT_RETENTION_RANK_KEY,
  DEFAULT_RETENTION_SORT,
  RETENTION_COLUMNS,
  formatRetentionMetric,
  rankRetentionRows,
  retentionMetricValue,
  retentionSeriesValues,
  retentionUnavailableReason,
  sortRetentionRows,
  totalRetentionCounts,
  type RetentionMetricKey,
  type RetentionSort,
  type RetentionSortKey,
} from '@/lib/patient-retention';

interface PatientRetentionTableProps {
  rows: PatientRetentionOfficeRow[];
  rangeEnd: string;
  /** The practice the page is narrowed to (null = all practices). */
  focused: string | null;
  onFocus: (providerId: string | null) => void;
}

const HEADER_BTN =
  'inline-flex items-center gap-1 rounded-sm text-left font-bold uppercase tracking-[.12em] transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function PatientRetentionTable({ rows, rangeEnd, focused, onFocus }: PatientRetentionTableProps) {
  const [sort, setSort] = useState<RetentionSort>(DEFAULT_RETENTION_SORT);

  const sorted = useMemo(() => sortRetentionRows(rows, sort), [rows, sort]);
  const rankKey: RetentionMetricKey = sort.key === 'officeName' ? DEFAULT_RETENTION_RANK_KEY : sort.key;
  const ranks = useMemo(() => rankRetentionRows(rows, rankKey), [rows, rankKey]);
  const total = useMemo(() => totalRetentionCounts(rows), [rows]);
  const rankLabel = RETENTION_COLUMNS.find((column) => column.key === rankKey)?.label ?? 'Onboarded';

  const toggleSort = (key: RetentionSortKey) => {
    setSort((current) => {
      if (current.key !== key) return { key, direction: key === 'officeName' ? 'asc' : 'desc' };
      return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  };

  const ariaSortFor = (key: RetentionSortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  const SortIcon = ({ column }: { column: RetentionSortKey }) => {
    if (sort.key !== column) return <ArrowUpDown size={11} aria-hidden="true" className="opacity-50" />;
    return sort.direction === 'asc'
      ? <ArrowUp size={11} aria-hidden="true" className="text-primary" />
      : <ArrowDown size={11} aria-hidden="true" className="text-primary" />;
  };

  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-retention-empty">
        No enabled provider offices yet.
      </p>
    );
  }

  // `relative` keeps the sr-only caption/header inside the scroll wrapper — otherwise they anchor to the page and widen it on phones.
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[1080px] text-left text-xs" data-testid="table-patient-retention">
        <caption className="sr-only">
          Patient retention by practice for the selected range. Rank is on {rankLabel}. The office name opens its account page; Focus narrows the page to that practice.
        </caption>
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground">
            <th scope="col" className="px-4 py-3 font-bold uppercase tracking-[.12em]" aria-label={`Rank on ${rankLabel}`}>
              #
            </th>
            <th scope="col" className="px-3 py-3" aria-sort={ariaSortFor('officeName')}>
              <button type="button" className={HEADER_BTN} onClick={() => toggleSort('officeName')} data-testid="sort-retention-officeName">
                Office <SortIcon column="officeName" />
              </button>
            </th>
            {RETENTION_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-3 text-right" aria-sort={ariaSortFor(column.key)}>
                <button
                  type="button"
                  className={`${HEADER_BTN} justify-end`}
                  onClick={() => toggleSort(column.key)}
                  title={column.help}
                  aria-label={`${column.label}: ${column.help}. Sort by ${column.label}`}
                  data-testid={`sort-retention-${column.key}`}
                >
                  {column.short} <SortIcon column={column.key} />
                </button>
              </th>
            ))}
            <th scope="col" className="px-3 py-3 text-right font-bold uppercase tracking-[.12em]" title="Active patients at each sample date across the range">
              Active trend
            </th>
            <th scope="col" className="px-4 py-3 text-right font-bold uppercase tracking-[.12em]">
              <span className="sr-only">Focus the page on this practice</span>
              <span aria-hidden="true">Focus</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const rank = ranks.get(row.providerId) ?? null;
            const isFocused = focused === row.providerId;
            return (
              <tr
                key={row.providerId}
                className={`border-b border-border transition last:border-b-0 ${isFocused ? 'bg-accent/50' : 'hover:bg-accent/40'}`}
                data-testid={`row-retention-${row.providerId}`}
                data-available={row.available ? 'true' : 'false'}
                data-focused={isFocused ? 'true' : 'false'}
              >
                <td className="px-4 py-3 font-semibold tabular-nums text-muted-foreground" data-testid={`retention-rank-${row.providerId}`}>
                  {rank ?? '—'}
                </td>
                <td className="px-3 py-3">
                  <Link
                    href={`/admin/accounts/${row.providerId}`}
                    className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${row.officeName}. Open the account page`}
                    data-testid={`link-retention-office-${row.providerId}`}
                  >
                    <b className="block text-xs font-semibold text-navy">{row.officeName}</b>
                    <small className="text-[10px] text-muted-foreground">{row.providerName}</small>
                  </Link>
                </td>
                {row.available ? (
                  RETENTION_COLUMNS.map((column) => {
                    const value = retentionMetricValue(row.metrics, column.key);
                    return (
                      <td key={column.key} className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`retention-cell-${column.key}-${row.providerId}`}>
                        {value == null ? (
                          <span className="text-muted-foreground" title="No onboarded patients to compare against">—</span>
                        ) : (
                          formatRetentionMetric(column.key, value)
                        )}
                      </td>
                    );
                  })
                ) : (
                  <td colSpan={RETENTION_COLUMNS.length} className="px-3 py-3 text-right">
                    <span
                      className="inline-block rounded border border-border bg-secondary px-2 py-1 text-[10px] font-semibold text-muted-foreground"
                      title={retentionUnavailableReason(row.firstPatientDate, rangeEnd)}
                      data-testid={`text-retention-unavailable-${row.providerId}`}
                    >
                      Unavailable for this range
                    </span>
                  </td>
                )}
                <td className="px-3 py-3 text-right">
                  <Sparkline
                    values={row.available ? retentionSeriesValues(row.series, 'active') : []}
                    label={`${row.officeName} active patients`}
                    testId={`retention-sparkline-${row.providerId}`}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  {row.available && (
                    <button
                      type="button"
                      className={`rounded-md border px-2 py-1 text-[10px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        isFocused ? 'border-navy bg-navy text-white' : 'border-border bg-card text-navy hover:bg-accent'
                      }`}
                      aria-pressed={isFocused}
                      aria-label={isFocused ? `Stop focusing on ${row.officeName}` : `Focus the page on ${row.officeName}`}
                      onClick={() => onFocus(isFocused ? null : row.providerId)}
                      data-testid={`button-retention-focus-${row.providerId}`}
                    >
                      {isFocused ? 'Focused' : 'Focus'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        {total && (
          <tfoot>
            <tr className="border-t-2 border-border bg-secondary/60 font-semibold" data-testid="row-retention-total">
              <td className="px-4 py-3 text-muted-foreground" aria-hidden="true" />
              <th scope="row" className="px-3 py-3 text-left text-xs font-semibold text-navy">
                All practices
                <small className="block text-[10px] font-normal text-muted-foreground">
                  {rows.filter((row) => row.available).length} of {rows.length} with data
                </small>
              </th>
              {RETENTION_COLUMNS.map((column) => {
                const value = retentionMetricValue(total, column.key);
                return (
                  <td key={column.key} className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`retention-total-${column.key}`}>
                    {formatRetentionMetric(column.key, value)}
                  </td>
                );
              })}
              <td className="px-3 py-3" aria-hidden="true" />
              <td className="px-4 py-3" aria-hidden="true" />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
