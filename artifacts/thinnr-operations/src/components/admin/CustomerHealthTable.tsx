/**
 * The stack-ranked office table for the HQ Customer health page.
 *
 * Every header sorts; the caller owns the sort (it lives in the URL). Office
 * names open the HQ account page. Scores wear their band as a pill, the last
 * order reads as a date plus days since (or "No orders on record"), and any
 * attention flags sit under the recency group with their plain-language
 * reasons. Rank always reads the server's rank, whatever the sort.
 */
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { Link } from 'wouter';
import type { CustomerHealthBand, CustomerHealthOffice } from '@workspace/api-client-react';
import { CHIP_COBALT, CHIP_RISK, CHIP_WARM } from '@/components/patient/heritage';
import { formatLocalDate } from '@/lib/local-time';
import {
  BAND_LABELS,
  BUCKET_SHORT,
  HEALTH_COLUMNS,
  formatCount,
  formatDaysAgo,
  type HealthSort,
  type HealthSortKey,
} from '@/lib/customer-health';

interface CustomerHealthTableProps {
  rows: CustomerHealthOffice[];
  sort: HealthSort;
  onSort: (key: HealthSortKey) => void;
  /** What the table is narrowed to, for the empty state. */
  groupLabel: string | null;
}

const HEADER_BTN =
  'inline-flex items-center gap-1 rounded-sm text-left font-bold uppercase tracking-[.12em] transition hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const BAND_CHIP: Record<CustomerHealthBand, string> = { healthy: CHIP_COBALT, watch: CHIP_WARM, atRisk: CHIP_RISK };

export function BandPill({ band, testId }: { band: CustomerHealthBand; testId?: string }) {
  return <span className={BAND_CHIP[band]} data-testid={testId} data-band={band}>{BAND_LABELS[band]}</span>;
}

export function NewBadge() {
  return (
    <span className="inline-flex items-center rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[.06em] text-navy" title="Created in the last 90 days with no order yet">
      New
    </span>
  );
}

export function CustomerHealthTable({ rows, sort, onSort, groupLabel }: CustomerHealthTableProps) {
  const ariaSortFor = (key: HealthSortKey): 'ascending' | 'descending' | 'none' =>
    sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  const SortIcon = ({ column }: { column: HealthSortKey }) => {
    if (sort.key !== column) return <ArrowUpDown size={11} aria-hidden="true" className="opacity-50" />;
    return sort.direction === 'asc'
      ? <ArrowUp size={11} aria-hidden="true" className="text-primary" />
      : <ArrowDown size={11} aria-hidden="true" className="text-primary" />;
  };

  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-xs text-muted-foreground" data-testid="text-health-empty">
        {groupLabel ? `No offices in “${groupLabel}” right now.` : 'No active provider offices yet.'}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-xs" data-testid="table-customer-health">
        <caption className="sr-only">
          Every active office ranked by health score, with last order, app subscribers, app users, active app users, staff enrolled, order-recency group and attention flags. Choose an office name to open its account page.
        </caption>
        <thead>
          <tr className="border-b border-border text-[10px] text-muted-foreground">
            {HEALTH_COLUMNS.map((column) => (
              <th key={column.key} scope="col" className={`px-3 py-3 ${column.align === 'right' ? 'text-right' : ''} ${column.key === 'rank' ? 'pl-4' : ''}`} aria-sort={ariaSortFor(column.key)}>
                <button
                  type="button"
                  className={`${HEADER_BTN} ${column.align === 'right' ? 'justify-end' : ''}`}
                  onClick={() => onSort(column.key)}
                  title={column.help}
                  aria-label={`${column.label}: ${column.help}. Sort by ${column.label}`}
                  data-testid={`sort-health-${column.key}`}
                >
                  {column.short} <SortIcon column={column.key} />
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.providerId}
              className="border-b border-border align-top transition hover:bg-accent/40"
              data-testid={`row-health-${row.providerId}`}
              data-band={row.band}
              data-bucket={row.bucket}
            >
              <td className="px-3 py-3 pl-4 text-right font-semibold tabular-nums text-muted-foreground" data-testid={`health-rank-${row.providerId}`}>{row.rank}</td>
              <td className="px-3 py-3">
                <Link
                  href={`/admin/accounts/${row.providerId}`}
                  className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`${row.officeName}. Open the account page`}
                  data-testid={`link-health-office-${row.providerId}`}
                >
                  <b className="block text-xs font-semibold text-navy">
                    {row.officeName}
                    {row.isNew && <span className="ml-1.5 align-middle"><NewBadge /></span>}
                  </b>
                  <small className="text-[10px] text-muted-foreground">{row.providerName}</small>
                </Link>
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-navy">
                <span className="inline-flex items-center justify-end gap-2">
                  <b className="text-sm" data-testid={`health-score-${row.providerId}`}>{row.score}</b>
                  <BandPill band={row.band} testId={`health-band-${row.providerId}`} />
                </span>
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`health-last-order-${row.providerId}`}>
                {row.lastOrderAt ? (
                  <>
                    <span className="block">{formatLocalDate(row.lastOrderAt)}</span>
                    <small className="text-[10px] text-muted-foreground">{formatDaysAgo(row.daysSinceLastOrder)}</small>
                  </>
                ) : (
                  <span className="text-muted-foreground">No orders on record</span>
                )}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`health-cell-activeSubscribers-${row.providerId}`}>{formatCount(row.activeSubscribers)}</td>
              <td className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`health-cell-appUsers-${row.providerId}`}>{formatCount(row.appUsers)}</td>
              <td className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`health-cell-activeAppUsers30d-${row.providerId}`}>{formatCount(row.activeAppUsers30d)}</td>
              <td className="px-3 py-3 text-right tabular-nums text-navy" data-testid={`health-cell-staffEnrolled-${row.providerId}`}>{formatCount(row.staffEnrolled)}</td>
              <td className="px-3 py-3 text-navy">
                <span className="block text-xs font-semibold" data-testid={`health-bucket-${row.providerId}`}>{BUCKET_SHORT[row.bucket]}</span>
                {row.flags.length > 0 && (
                  <ul className="mt-1 space-y-0.5" aria-label={`Attention flags for ${row.officeName}`} data-testid={`health-flags-${row.providerId}`}>
                    {row.flags.map((flag) => (
                      <li key={flag.kind} className="text-[10px] leading-snug text-[#b65c22]" data-flag={flag.kind}>{flag.reason}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
