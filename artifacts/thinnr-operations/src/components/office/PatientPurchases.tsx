/**
 * Purchases panel on the patient record (office `/patients/:id` and the HQ
 * office drill-in). Read-only by design: staff jump into the payments area to
 * refund, ship, or change a subscription. The live panel reads the
 * per-patient billing summary; the guided demo builds the same shape from the
 * shared seeded dataset so both personas render one component.
 */
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpRight, CreditCard, Loader2 } from 'lucide-react';
import { Link } from 'wouter';
import { INSET, LINK_ACTION, MICRO_LABEL, SectionCard } from '@/components/patient/heritage';
import { StatusPill } from '@/components/billing/primitives';
import type { Patient, Product, Subscription } from '@/data/mock-data';
import {
  CADENCE_LABEL, formatCents, formatDate, FULFILLMENT_LABEL, fulfillmentTone, ORDER_STATUS_LABEL, orderStatusTone,
  SUBSCRIPTION_STATUS_LABEL, subscriptionTone, type PillTone,
} from '@/lib/billing-format';
import { officeBilling } from '@/lib/billing-api';
import type {
  CadenceWeeks, PatientBillingOrder, PatientBillingSubscription, PatientPurchasesSummary, PatientShipment, ShippingAddress,
} from '@/lib/billing-types';
import { OfficeApiError } from '@/lib/office-api';
import { politeRefetchInterval } from '@/lib/polite-refetch';

export const purchasesQueryKey = (office: string | null, patientId: string) =>
  ['office-patient-purchases', office ?? 'own', patientId] as const;

const SHIPMENT_LABEL: Record<PatientShipment['status'], string> = {
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  canceled: 'Canceled',
};
function shipmentTone(status: PatientShipment['status']): PillTone {
  return status === 'delivered' ? 'good' : status === 'shipped' ? 'info' : status === 'canceled' ? 'neutral' : 'warn';
}
/** Parcel state once a shipment is recorded; until then the order's fulfillment queue state. */
function shipmentState(order: PatientBillingOrder): { label: string; tone: PillTone } {
  if (order.shipment.status !== 'processing') return { label: SHIPMENT_LABEL[order.shipment.status], tone: shipmentTone(order.shipment.status) };
  return { label: FULFILLMENT_LABEL[order.fulfillment_status], tone: fulfillmentTone(order.fulfillment_status) };
}

function Stat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className={`${INSET} px-4 py-3`} data-testid={testId}>
      <p className={MICRO_LABEL}>{label}</p>
      <p className="mt-1 font-mono text-lg text-navy">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

const TH = 'px-3 py-2 text-left text-[9px] font-bold uppercase tracking-[.08em] text-muted-foreground';
const TD = 'px-3 py-2.5 align-top text-xs text-foreground';

/**
 * The panel body. `paymentsHref` builders keep the links inside the payments
 * area of whichever app hosts the record (office or HQ drill-in): wouter
 * resolves them against the nested base.
 */
export function PatientPurchasesPanel({ summary, demo = false }: { summary: PatientPurchasesSummary; demo?: boolean }) {
  const { totals, saved_card: card, last_payment_problem: problem } = summary;
  const cardLabel = card.state === 'on_file'
    ? `${card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card'} •••• ${card.last4 ?? ''}`
    : card.state === 'none' ? 'None saved' : 'Unavailable';
  const cardSub = card.state === 'on_file' && card.exp_month && card.exp_year
    ? `Expires ${String(card.exp_month).padStart(2, '0')}/${card.exp_year}`
    : card.state === 'unknown' ? 'Stripe did not answer' : undefined;
  // The demo dataset has no order detail pages, so its rows link to the lists.
  const orderHref = (order: PatientBillingOrder) => (demo ? '/payments/transactions' : `/payments/transactions/${order.id}`);
  const subscriptionsHref = '/payments/subscriptions';
  const hasAnything = summary.subscriptions.length > 0 || summary.orders.length > 0;

  return (
    <SectionCard
      title="Purchases"
      sub="Shop orders, shipments and subscriptions at this office."
      action={<Link href="/payments/transactions" className={`${LINK_ACTION} inline-flex items-center gap-1 text-xs`} data-testid="link-purchases-payments">Payments area <ArrowUpRight size={12} aria-hidden="true" /></Link>}
      className="h-full"
    >
      <div className="p-5" data-testid="panel-purchases">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Lifetime spend" value={formatCents(totals.lifetime_net_cents)} testId="stat-purchases-lifetime"
            sub={totals.lifetime_refunded_cents > 0 ? `${formatCents(totals.lifetime_paid_cents)} paid · ${formatCents(totals.lifetime_refunded_cents)} refunded` : totals.last_paid_at ? `Last payment ${formatDate(totals.last_paid_at)}` : 'No payments yet'} />
          <Stat label="Orders" value={String(totals.order_count)} testId="stat-purchases-orders" sub={totals.order_count > summary.orders.length ? `Showing the latest ${summary.orders.length}` : undefined} />
          <Stat label="Active subscriptions" value={String(totals.active_subscription_count)} testId="stat-purchases-subscriptions" />
          <Stat label="Card on file" value={cardLabel} sub={cardSub} testId="stat-purchases-card" />
        </div>

        {problem && (
          <div role="status" data-testid="purchases-payment-problem" className="mt-4 flex flex-wrap items-start gap-3 rounded-md border border-[#d5a7a7] bg-[#fff0f0] px-4 py-3 text-xs text-destructive">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {problem.source === 'subscription' ? 'Subscription payment failed' : `Payment failed on order ${problem.order_number ?? ''}`.trim()} · {formatDate(problem.at)}
              </p>
              {problem.message && <p className="mt-0.5 text-destructive/80">{problem.message}</p>}
            </div>
            <div className="flex items-center gap-3">
              {problem.hosted_invoice_url && (
                <a href={problem.hosted_invoice_url} target="_blank" rel="noreferrer" className={`${LINK_ACTION} text-xs`}>Stripe invoice</a>
              )}
              <Link href={problem.source === 'subscription' ? subscriptionsHref : `/payments/transactions/${problem.order_id}`} className={`${LINK_ACTION} text-xs`} data-testid="link-purchases-problem">
                {problem.source === 'subscription' ? 'Manage subscription' : 'Open order'}
              </Link>
            </div>
          </div>
        )}

        {!hasAnything ? (
          <p className="mt-4 rounded-md border border-dashed border-border bg-paper-alt px-4 py-6 text-center text-xs text-muted-foreground" data-testid="purchases-empty">No purchases at this office yet.</p>
        ) : (
          <div className="mt-5 grid gap-5 xl:grid-cols-2">
            <div>
              <div className="flex items-center justify-between gap-3">
                <p className={MICRO_LABEL}>Subscriptions</p>
                {summary.subscriptions.length > 0 && <Link href={subscriptionsHref} className={`${LINK_ACTION} text-[11px]`} data-testid="link-purchases-subscriptions">Manage in Payments</Link>}
              </div>
              {summary.subscriptions.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No subscriptions.</p>
              ) : (
                <div className={`${INSET} mt-2 overflow-x-auto`}>
                  <table className="w-full table-fixed border-collapse" data-testid="table-purchases-subscriptions">
                    <thead><tr className="border-b border-border"><th className={TH}>Product</th><th className={`${TH} w-[34%]`}>Cadence · next shipment</th><th className={`${TH} w-[28%]`}>Status</th></tr></thead>
                    <tbody>
                      {summary.subscriptions.map((row) => (
                        <tr key={row.id} className="border-b border-border last:border-b-0" data-testid={`row-subscription-${row.id}`}>
                          <td className={TD}><p className="truncate font-semibold text-navy">{row.product_name}</p><p className="text-[11px] text-muted-foreground">{row.quantity > 1 ? `${row.quantity} × ` : ''}{formatCents(row.unit_price_cents * row.quantity)}</p></td>
                          <td className={TD}><p>{CADENCE_LABEL[row.cadence_weeks as CadenceWeeks] ?? `Every ${row.cadence_weeks} weeks`}</p><p className="text-[11px] text-muted-foreground">{row.status === 'canceled' ? 'Ended' : row.paused ? 'Paused' : `Next ${formatDate(row.next_shipment_at)}`}</p></td>
                          <td className={TD}><div className="flex flex-wrap gap-1"><StatusPill tone={row.paused && row.status === 'active' ? 'warn' : subscriptionTone(row.status)}>{row.paused && row.status === 'active' ? 'Paused' : SUBSCRIPTION_STATUS_LABEL[row.status]}</StatusPill>{row.cancel_at_period_end && row.status !== 'canceled' && <StatusPill tone="neutral">Ends {formatDate(row.current_period_end)}</StatusPill>}</div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <p className={MICRO_LABEL}>Recent orders</p>
              {summary.orders.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No orders.</p>
              ) : (
                <div className={`${INSET} mt-2 overflow-x-auto`}>
                  <table className="w-full table-fixed border-collapse" data-testid="table-purchases-orders">
                    <thead><tr className="border-b border-border"><th className={TH}>Order</th><th className={`${TH} w-[22%]`}>Total</th><th className={`${TH} w-[36%]`}>Payment · shipment</th></tr></thead>
                    <tbody>
                      {summary.orders.map((order) => {
                        const ship = shipmentState(order);
                        return (
                          <tr key={order.id} className="border-b border-border last:border-b-0" data-testid={`row-order-${order.id}`}>
                            <td className={TD}>
                              <Link href={orderHref(order)} className={`${LINK_ACTION} font-mono text-xs`} data-testid={`link-order-${order.id}`}>{order.order_number}</Link>
                              <p className="truncate text-[11px] text-muted-foreground">{formatDate(order.created_at)} · {order.items_label}</p>
                            </td>
                            <td className={`${TD} font-mono`}>{formatCents(order.total_cents)}{order.refunded_cents > 0 && <p className="text-[11px] font-sans text-muted-foreground">{formatCents(order.refunded_cents)} refunded</p>}</td>
                            <td className={TD}><div className="flex flex-wrap gap-1"><StatusPill tone={orderStatusTone(order.status)}>{ORDER_STATUS_LABEL[order.status]}</StatusPill>{order.status !== 'failed' && order.status !== 'pending' && order.status !== 'canceled' && <StatusPill tone={ship.tone}>{ship.label}</StatusPill>}</div>{order.shipment.tracking_number && <p className="mt-1 truncate text-[11px] text-muted-foreground">{order.shipment.carrier ? `${order.shipment.carrier.toUpperCase()} ` : ''}{order.shipment.tracking_number}</p>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/** Live panel: signed-in staff only; loading and failure states are explicit, never an empty panel. */
export function LivePatientPurchases({ patientId, office }: { patientId: string; office: string | null }) {
  const query = useQuery({
    queryKey: purchasesQueryKey(office, patientId),
    queryFn: () => officeBilling.patientPurchases(patientId, office),
    // A 403 is a fact about the caller's role, not a transient failure.
    retry: (count, error) => (error instanceof OfficeApiError && error.isForbidden ? false : count < 1),
    refetchInterval: politeRefetchInterval(30_000),
  });
  if (query.isPending) {
    return (
      <SectionCard title="Purchases" className="h-full">
        <div className="flex items-center gap-2 p-5 text-xs text-muted-foreground" role="status" data-testid="purchases-loading">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading purchases…
        </div>
      </SectionCard>
    );
  }
  if (query.isError) {
    const error = query.error;
    const forbidden = error instanceof OfficeApiError && error.isForbidden;
    return (
      <SectionCard title="Purchases" className="h-full">
        <div className="p-5" data-testid={forbidden ? 'purchases-forbidden' : 'purchases-error'}>
          <div className="flex items-start gap-2 text-xs text-muted-foreground" role={forbidden ? undefined : 'alert'}>
            <CreditCard size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-semibold text-navy">{forbidden ? 'Purchases are visible to office owners and admins.' : 'Purchases could not be loaded.'}</p>
              {!forbidden && (
                <p className="mt-1">{error instanceof Error ? error.message : 'Try again in a moment.'}{' '}
                  <button type="button" onClick={() => void query.refetch()} className={`${LINK_ACTION} text-xs`} data-testid="button-purchases-retry">Retry</button>
                </p>
              )}
            </div>
          </div>
        </div>
      </SectionCard>
    );
  }
  return <PatientPurchasesPanel summary={query.data} />;
}

// ---- Guided demo: the shared seeded dataset rendered through the same panel ----

const DEMO_ADDRESS: ShippingAddress = { name: '', line1: '', line2: null, city: '', state: '', postal_code: '', country: 'US', phone: null };
const DEMO_STATUS: Record<Subscription['status'], PatientBillingSubscription['status']> = {
  active: 'active', paused: 'active', overdue: 'past_due', cancelled: 'canceled',
};

/**
 * Builds the staff summary for one demo patient from MOCK_SUBSCRIPTIONS and
 * MOCK_PRODUCTS: one subscription line per product, one delivered renewal
 * order per seeded shipment, and the patient's seeded revenue as lifetime
 * spend. Nothing here reads the clock; every date comes from the dataset.
 */
export function demoPurchasesSummary(patient: Patient, subscription: Subscription | undefined, products: Product[]): PatientPurchasesSummary {
  const lines = subscription ? subscription.products.map((id) => products.find((product) => product.id === id)).filter((product): product is Product => Boolean(product)) : [];
  const status = subscription ? DEMO_STATUS[subscription.status] : 'canceled';
  const paused = subscription?.status === 'paused';
  const failed = subscription?.paymentStatus === 'failed';
  const subscriptions: PatientBillingSubscription[] = lines.map((product, index) => ({
    id: `${subscription!.id}-${product.id}`, product_id: product.id, product_name: product.name,
    unit_price_cents: product.price * 100, shipping_charge_cents: index === 0 ? 1000 : 0, status, paused,
    current_period_end: subscription!.nextShipment, cancel_at_period_end: false,
    last_hosted_invoice_url: null, last_failure_message: failed ? 'Your card was declined.' : null,
    cadence_weeks: 4, quantity: 1, next_shipment_at: subscription!.nextShipment, shipping_address: DEMO_ADDRESS,
    shipping: { method: 'standard', source: 'fallback', carrier_service_name: null, delivery_window_start: null, delivery_window_end: null },
  }));
  const itemsLabel = lines.map((product) => product.name).join(', ') || 'Protocol';
  const orderTotal = lines.reduce((sum, product) => sum + product.price * 100, 0) + 1000;
  const shipments = subscription?.shipmentHistory ?? [];
  const orders: PatientBillingOrder[] = shipments.map((shipment, index) => ({
    id: `${subscription!.id}-order-${index + 1}`, order_number: `TH-${subscription!.id.replace(/\D/g, '').padStart(4, '0')}${index + 1}`,
    kind: index === shipments.length - 1 ? 'subscription_initial' : 'subscription_renewal', status: 'paid',
    fulfillment_status: shipment.status === 'processing' ? 'to_ship' : 'shipped', total_cents: orderTotal, refunded_cents: 0,
    item_count: lines.length || 1, items_label: itemsLabel, created_at: shipment.date, paid_at: shipment.date, receipt_available: false,
    shipment: {
      status: shipment.status, carrier: shipment.status === 'processing' ? null : 'usps',
      tracking_number: shipment.status === 'processing' ? null : `9400${subscription!.id.replace(/\D/g, '')}${index}`,
      tracking_url: null, shipped_at: shipment.status === 'processing' ? null : shipment.date,
      delivered_at: shipment.status === 'delivered' ? shipment.date : null,
      canceled_at: null, updated_at: shipment.date,
    },
    subscription_id: subscriptions[0]?.id ?? null, cart_id: null,
    shipping: { method: 'standard', source: 'fallback', carrier_service_name: null, delivery_window_start: null, delivery_window_end: null },
  }));
  const lifetimePaid = Math.max(patient.revenue * 100, orders.length * orderTotal);
  const failedAt = failed && subscription ? subscription.nextShipment : null;
  return {
    patient_id: patient.id,
    subscriptions,
    orders,
    totals: {
      order_count: orders.length, lifetime_paid_cents: lifetimePaid, lifetime_refunded_cents: 0, lifetime_net_cents: lifetimePaid,
      last_paid_at: orders[0]?.paid_at ?? null,
      active_subscription_count: status === 'canceled' ? 0 : subscriptions.length,
    },
    saved_card: subscription && subscription.status !== 'cancelled'
      ? { state: 'on_file', brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028 }
      : { state: 'none', brand: null, last4: null, exp_month: null, exp_year: null },
    last_payment_problem: failedAt && subscriptions[0] ? {
      source: 'subscription', subscription_id: subscriptions[0].id, order_id: null, order_number: null,
      at: failedAt, message: 'Your card was declined.', hosted_invoice_url: null,
    } : null,
  };
}
