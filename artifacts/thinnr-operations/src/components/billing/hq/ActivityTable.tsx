/**
 * Ledger activity rows (payments, refunds, disputes, payouts). Every row that
 * belongs to an order opens the transaction detail: one announced link per
 * row plus a pointer-only row click, per the dashboard's clickable-row rule.
 */
import { Link } from 'wouter';
import { MoneyCell, StatusPill } from '@/components/billing/primitives';
import { PANEL_LABEL } from '@/components/patient/heritage';
import { formatDateTime, type PillTone as Tone } from '@/lib/billing-format';
import type { HqActivityRow } from '@/lib/billing-types';

export function activityTone(kind: HqActivityRow['kind']): Tone {
  switch (kind) {
    case 'sale':
    case 'dispute_won':
      return 'good';
    case 'refund':
    case 'dispute_opened':
    case 'fee_discrepancy':
      return 'warn';
    case 'dispute_lost':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function activityHref(row: HqActivityRow): string | null {
  return row.order_id ? `/transactions/${row.order_id}` : null;
}

function rowClick(navigate: (to: string) => void, href: string) {
  return (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as Element).closest('a, button, input, select, textarea') || window.getSelection()?.toString()) return;
    navigate(href);
  };
}

export function ActivityTable({
  rows,
  navigate,
  empty,
  showOffice = true,
}: {
  rows: HqActivityRow[];
  navigate: (to: string) => void;
  empty: string;
  showOffice?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <p role="status" className="p-8 text-center text-xs text-muted-foreground">
        {empty}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="table-activity">
        <thead>
          <tr className="text-left">
            <th className={`${PANEL_LABEL} px-5 py-2.5`}>When</th>
            <th className={`${PANEL_LABEL} px-5 py-2.5`}>Activity</th>
            {showOffice && <th className={`${PANEL_LABEL} px-5 py-2.5`}>Office</th>}
            <th className={`${PANEL_LABEL} px-5 py-2.5`}>Order</th>
            <th className={`${PANEL_LABEL} px-5 py-2.5 text-right`}>Amount</th>
            {/* relative: the sr-only span must stay inside the scroll wrapper, or it widens the page at phone widths. */}
            <th className="relative px-5 py-2.5">
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border border-t border-border">
          {rows.map((row) => {
            const href = activityHref(row);
            return (
              <tr
                key={row.id}
                data-testid={`row-activity-${row.id}`}
                onClick={href ? rowClick(navigate, href) : undefined}
                className={href ? 'cursor-pointer transition hover:bg-secondary/60' : undefined}
              >
                <td className="whitespace-nowrap px-5 py-3 tabular-nums text-muted-foreground">{formatDateTime(row.occurred_at)}</td>
                <td className="px-5 py-3">
                  <StatusPill tone={activityTone(row.kind)}>{row.label}</StatusPill>
                </td>
                {showOffice && <td className="max-w-[220px] truncate px-5 py-3 font-semibold text-navy">{row.office_name}</td>}
                <td className="px-5 py-3 tabular-nums">{row.order_number ?? '—'}</td>
                <td className="px-5 py-3 text-right">
                  <MoneyCell cents={row.amount_cents} signed />
                </td>
                <td className="px-5 py-3 text-right">
                  {href ? (
                    <Link
                      href={href}
                      aria-label={`Open order ${row.order_number ?? ''} (${row.label.toLowerCase()})`}
                      className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Open
                    </Link>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
