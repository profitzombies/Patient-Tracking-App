/**
 * One office's payment activity as HQ sees it: the Stripe connection state,
 * the last 30 days in numbers, and the most recent orders. Shared by the
 * payments provider profile (/admin/payments/providers/:id) and the provider
 * account page (/admin/accounts/:id) so both surfaces show the same truth.
 *
 * Links are supplied by the caller because the payments area is nest-mounted
 * (base-relative hrefs) while the accounts page lives at the admin root.
 */
import { Link } from 'wouter';
import { MoneyCell, StatusPill } from '@/components/billing/primitives';
import {
  accountStatusLabel,
  formatDate,
  ORDER_KIND_LABEL,
  ORDER_STATUS_LABEL,
  orderStatusTone,
} from '@/lib/billing-format';
import type { HqProviderDetail } from '@/lib/billing-types';

function Tile({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="rounded-md border border-border bg-paper-alt px-3.5 py-3" data-testid={testId}>
      <div className="text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 font-serif text-lg font-bold text-navy tabular-nums">{value}</div>
    </div>
  );
}

export function ProviderActivityTiles({
  activity,
  subscriptions,
}: {
  activity: HqProviderDetail['activity_30d'];
  subscriptions: HqProviderDetail['subscriptions'];
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6" data-testid="provider-activity-30d">
      <Tile label="Collected · 30d" value={<MoneyCell cents={activity.collected_cents} />} testId="tile-collected-30d" />
      <Tile label="THINNR fees · 30d" value={<MoneyCell cents={activity.thinnr_fee_cents} />} testId="tile-fees-30d" />
      <Tile label="Office net · 30d" value={<MoneyCell cents={activity.net_cents} />} testId="tile-net-30d" />
      <Tile label="Refunded · 30d" value={<MoneyCell cents={activity.refunded_cents} />} testId="tile-refunded-30d" />
      <Tile label="Orders · 30d" value={activity.orders.toLocaleString('en-US')} testId="tile-orders-30d" />
      <Tile label="Active subscriptions" value={subscriptions.active.toLocaleString('en-US')} testId="tile-active-subscriptions" />
    </div>
  );
}

export function ProviderRecentOrders({
  orders,
  orderHref,
  emptyMessage = 'No orders yet.',
}: {
  orders: HqProviderDetail['recent_orders'];
  orderHref: (orderId: string) => string;
  emptyMessage?: string;
}) {
  if (orders.length === 0) {
    return (
      <p role="status" className="px-4 py-6 text-xs text-muted-foreground" data-testid="provider-recent-orders-empty">
        {emptyMessage}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs" data-testid="provider-recent-orders">
        <thead>
          <tr>
            <th className="p-3 text-left">Order</th>
            <th className="text-left">Patient</th>
            <th className="text-left">Items</th>
            <th className="text-left">Type</th>
            <th className="text-left">Status</th>
            <th className="pr-3 text-right">Total</th>
            <th className="pr-3 text-right">THINNR fee</th>
            <th className="pr-3 text-left">Date</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="p-3">
                <Link
                  href={orderHref(row.id)}
                  aria-label={`Open order ${row.order_number}`}
                  className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {row.order_number}
                </Link>
              </td>
              <td>{row.payer.name}</td>
              <td className="max-w-[16rem] truncate" title={row.items_label}>{row.items_label}</td>
              <td>{ORDER_KIND_LABEL[row.kind]}</td>
              <td>
                <StatusPill tone={orderStatusTone(row.status)}>{ORDER_STATUS_LABEL[row.status]}</StatusPill>
              </td>
              <td className="text-right pr-3">
                <MoneyCell cents={row.total_cents} />
              </td>
              <td className="text-right pr-3">
                <MoneyCell cents={row.application_fee_cents} muted />
              </td>
              <td className="whitespace-nowrap pr-3">{formatDate(row.paid_at ?? row.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact Stripe connection line for surfaces outside the payments area. */
export function ProviderConnectionLine({ account }: { account: HqProviderDetail['account'] }) {
  if (!account) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="provider-connection-none">
        Stripe not connected — this office cannot take payments yet.
      </span>
    );
  }
  const status = accountStatusLabel(account);
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs" data-testid="provider-connection-status">
      <StatusPill tone={status.tone}>{status.label}</StatusPill>
      <span className="text-muted-foreground">
        Charges {account.charges_enabled ? 'enabled' : 'off'} · Payouts {account.payouts_enabled ? 'enabled' : 'off'}
      </span>
    </span>
  );
}
