/**
 * Per-practice lifecycle counts for the HQ Patient retention page.
 *
 * Every header sorts. The office name is the row's single control: it narrows
 * the whole page to that practice (the caller owns the selection, which lives
 * in the URL). The footer is the "all practices" row — the network totals,
 * exact sums of the available offices. Offices with no onboarded patient by
 * the range end render "Unavailable" rather than zeroes.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { PatientRetentionCounts, PatientRetentionOfficeRow } from '@workspace/api-client-react';
import {
  DEFAULT_RETENTION_SORT,
  RETENTION_COLUMNS,
  formatRetentionMetric,
  retentionMetricValue,
  retentionUnavailableReason,
  sortRetentionRows,
  type RetentionSort,
  type RetentionSortKey,
} from '@/lib/patient-retention';

interface PatientRetentionTableProps {
  rows: PatientRetentionOfficeRow[];
  total: PatientRetentionCounts | null;
  rangeEnd: string;
  /** The practice the page is narrowed to, if any. */
  selectedOffice: string | null;
  onSelectOffice: (providerId: string | null) => void;
}

const HEADER_BTN =
  'inline-flex items-center gap-1 rounded-sm text-left font-bold uppercase tracking-[.12em] transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function PatientRetentionTable({ rows, total, rangeEnd, selectedOffice, onSelectOffice }: PatientRetentionTableProps) {
  const [sort, setSort] = useState<RetentionSort>(DEFAULT_RETENTION_SORT);
  const sorted = useMemo(() => sortRetentionRows(rows, sort), [rows, sort]);

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

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-xs" data-testid="table-patient-retention">
        <caption className="sr-only">
          Patients onboarded, active, buying and inactive by practice as of {rangeEnd}. Choose an office name to narrow the page to that practice. The last row totals all practices.
        </caption>
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground">
            <th scope="col" className="px-4 py-3" aria-sort={ariaSortFor('officeName')}>
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
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const selected = row.providerId === selectedOffice;
            return (
              <tr
                key={row.providerId}
                className={`border-b border-border transition hover:bg-accent/40 ${selected ? 'bg-accent/30' : ''}`}
                data-testid={`row-retention-${row.providerId}`}
                data-available={row.available ? 'true' : 'false'}
                data-selected={selected ? 'true' : 'false'}
              >
                <td className="px-4 py-3">
                  <button
                    type="button"
                    className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onSelectOffice(selected ? null : row.providerId)}
                    aria-pressed={selected}
                    aria-label={selected ? `${row.officeName}. Showing this practice only; choose to show all practices` : `${row.officeName}. Narrow the page to this practice`}
                    data-testid={`button-retention-office-${row.providerId}`}
                  >
                    <b className="block text-xs font-semibold text-navy">{row.officeName}</b>
                    <small className="text-[10px] text-muted-foreground">{row.providerName}</small>
                  </button>
                </td>
                {row.available ? (
                  RETENTION_COLUMNS.map((column) => {
                    const value = retentionMetricValue(row.counts, column.key);
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
                      title={retentionUnavailableReason(row.firstOnboardedDate, rangeEnd)}
                      data-testid={`text-retention-unavailable-${row.providerId}`}
                    >
                      Unavailable for this range
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-secondary/60 font-semibold" data-testid="row-retention-total">
            <th scope="row" className="px-4 py-3 text-left text-xs text-navy">
              {selectedOffice ? 'Selected practice' : 'All practices'}
              <small className="block text-[10px] font-normal text-muted-foreground">{rows.filter((row) => row.available).length} of {rows.length} with data</small>
            </th>
            {RETENTION_COLUMNS.map((column) => (
              <td key={column.key} className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`retention-total-${column.key}`}>
                {formatRetentionMetric(column.key, retentionMetricValue(total, column.key))}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
