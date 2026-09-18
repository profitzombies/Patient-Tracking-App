/**
 * Per-practice active app users for the HQ App usage page.
 *
 * Every metric header sorts; the rank column ranks on the active sort metric
 * (1 = highest). The office name is the row's single link (its account page)
 * — figures are aggregate counts with no per-patient drill-down. The
 * sparkline is the office's rolling 7-day active-user trend across the range
 * (its last point is the Weekly column). Offices with no data for the range
 * render "Unavailable" rather than zeroes, exactly as the office comparison.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronsUpDown } from 'lucide-react';
import type { AppUsageOfficeRow } from '@workspace/api-client-react';
import { Sparkline } from '@/components/admin/Sparkline';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { INPUT_CLASS } from '@/components/patient/heritage';
import {
  APP_USAGE_COLUMNS,
  DEFAULT_APP_USAGE_RANK_KEY,
  DEFAULT_APP_USAGE_SORT,
  formatUsageMetric,
  rankAppUsageRows,
  sortAppUsageRows,
  usageMetricValue,
  usageSeriesValues,
  usageUnavailableReason,
  type AppUsageMetricKey,
  type AppUsageSort,
  type AppUsageSortKey,
} from '@/lib/app-usage';

interface AppUsageTableProps {
  rows: AppUsageOfficeRow[];
  rangeEnd: string;
  filterActive?: boolean;
}

const HEADER_BTN =
  'inline-flex items-center gap-1 rounded-sm text-left font-bold uppercase tracking-[.12em] transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface AppUsagePracticeFilterProps {
  rows: AppUsageOfficeRow[];
  value: string | null;
  onChange: (providerId: string | null) => void;
}

/** A wide, searchable practice picker for the table header. */
export function AppUsagePracticeFilter({ rows, value, onChange }: AppUsagePracticeFilterProps) {
  const [open, setOpen] = useState(false);
  const current = rows.find((row) => row.providerId === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label="Search practices"
          aria-expanded={open}
          data-testid="select-app-usage-practice"
          className={`${INPUT_CLASS} flex h-9 w-full min-w-0 items-center justify-between gap-2 text-left ${!current && 'text-muted-foreground'}`}
        >
          <span className="truncate">{current?.officeName ?? 'All practices'}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(400px,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput
            placeholder="Search office or provider…"
            className="h-9 text-xs"
            data-testid="input-app-usage-practice-search"
          />
          <CommandList>
            <CommandEmpty>No practice found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="all practices"
                onSelect={() => { onChange(null); setOpen(false); }}
                className="text-xs"
              >
                All practices
                <Check className={`ml-auto h-4 w-4 ${value === null ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
              </CommandItem>
              {rows.map((row) => (
                <CommandItem
                  key={row.providerId}
                  value={`${row.officeName} ${row.providerName}`}
                  data-value={row.providerId}
                  onSelect={() => { onChange(row.providerId); setOpen(false); }}
                  className="items-start text-xs"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-navy">{row.officeName}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{row.providerName}</span>
                  </span>
                  <Check className={`ml-auto mt-0.5 h-4 w-4 shrink-0 ${row.providerId === value ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function AppUsageTable({ rows, rangeEnd, filterActive = false }: AppUsageTableProps) {
  const [sort, setSort] = useState<AppUsageSort>(DEFAULT_APP_USAGE_SORT);

  const sorted = useMemo(() => sortAppUsageRows(rows, sort), [rows, sort]);
  const rankKey: AppUsageMetricKey = sort.key === 'officeName' ? DEFAULT_APP_USAGE_RANK_KEY : sort.key;
  const ranks = useMemo(() => rankAppUsageRows(rows, rankKey), [rows, rankKey]);
  const rankLabel = APP_USAGE_COLUMNS.find((column) => column.key === rankKey)?.label ?? 'Weekly active';

  const toggleSort = (key: AppUsageSortKey) => {
    setSort((current) => {
      if (current.key !== key) return { key, direction: key === 'officeName' ? 'asc' : 'desc' };
      return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  };

  const ariaSortFor = (key: AppUsageSortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  const SortIcon = ({ column }: { column: AppUsageSortKey }) => {
    if (sort.key !== column) return <ArrowUpDown size={11} aria-hidden="true" className="opacity-50" />;
    return sort.direction === 'asc'
      ? <ArrowUp size={11} aria-hidden="true" className="text-primary" />
      : <ArrowDown size={11} aria-hidden="true" className="text-primary" />;
  };

  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-app-usage-empty">
        {filterActive ? 'No practice matches that search.' : 'No enabled provider offices yet.'}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-xs" data-testid="table-app-usage">
        <caption className="sr-only">
          Active app users by practice for the selected range. Rank is on {rankLabel}. The office name opens its account page.
        </caption>
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground">
            <th scope="col" className="px-4 py-3 font-bold uppercase tracking-[.12em]" aria-label={`Rank on ${rankLabel}`}>
              #
            </th>
            <th scope="col" className="px-3 py-3" aria-sort={ariaSortFor('officeName')}>
              <button type="button" className={HEADER_BTN} onClick={() => toggleSort('officeName')} data-testid="sort-usage-officeName">
                Office <SortIcon column="officeName" />
              </button>
            </th>
            {APP_USAGE_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-3 text-right" aria-sort={ariaSortFor(column.key)}>
                <button
                  type="button"
                  className={`${HEADER_BTN} justify-end`}
                  onClick={() => toggleSort(column.key)}
                  title={column.help}
                  aria-label={`${column.label}: ${column.help}. Sort by ${column.label}`}
                  data-testid={`sort-usage-${column.key}`}
                >
                  {column.short} <SortIcon column={column.key} />
                </button>
              </th>
            ))}
            <th scope="col" className="px-4 py-3 text-right font-bold uppercase tracking-[.12em]" title="Rolling 7-day active app users, day by day across the range">
              Weekly trend
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const rank = ranks.get(row.providerId) ?? null;
            return (
              <tr
                key={row.providerId}
                className="border-b border-border transition hover:bg-accent/40 last:border-b-0"
                data-testid={`row-app-usage-${row.providerId}`}
                data-available={row.available ? 'true' : 'false'}
              >
                <td className="px-4 py-3 font-semibold tabular-nums text-muted-foreground" data-testid={`usage-rank-${row.providerId}`}>
                  {rank ?? '—'}
                </td>
                <td className="px-3 py-3">
                  <Link
                    href={`/admin/accounts/${row.providerId}`}
                    className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${row.officeName}. Open the account page`}
                    data-testid={`link-usage-office-${row.providerId}`}
                  >
                    <b className="block text-xs font-semibold text-navy">{row.officeName}</b>
                    <small className="text-[10px] text-muted-foreground">{row.providerName}</small>
                  </Link>
                </td>
                {row.available ? (
                  APP_USAGE_COLUMNS.map((column) => {
                    const value = usageMetricValue(row.metrics, column.key);
                    return (
                      <td key={column.key} className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`usage-cell-${column.key}-${row.providerId}`}>
                        {value == null ? (
                          <span className="text-muted-foreground" title="No activated patients to compare against">—</span>
                        ) : (
                          formatUsageMetric(column.key, value)
                        )}
                      </td>
                    );
                  })
                ) : (
                  <td colSpan={APP_USAGE_COLUMNS.length} className="px-3 py-3 text-right">
                    <span
                      className="inline-block rounded border border-border bg-secondary px-2 py-1 text-[10px] font-semibold text-muted-foreground"
                      title={usageUnavailableReason(row.firstPatientDate, rangeEnd)}
                      data-testid={`text-usage-unavailable-${row.providerId}`}
                    >
                      Unavailable for this range
                    </span>
                  </td>
                )}
                <td className="px-4 py-3 text-right">
                  <Sparkline
                    values={row.available ? usageSeriesValues(row.series, 'weeklyActive') : []}
                    label={`${row.officeName} weekly active app users`}
                    testId={`usage-sparkline-${row.providerId}`}
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
