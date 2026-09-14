import { useMemo, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useMutation } from '@tanstack/react-query';
import { ExternalLink, Search } from 'lucide-react';
import {
  AdminPage,
  MetricTile,
  PageHeader,
  PreviewBanner,
  UnauthorizedState,
  copyText,
} from '@/components/admin/primitives';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS, PANEL_LABEL, SectionCard } from '@/components/patient/heritage';
import {
  DetailList,
  FeeBreakdown,
  MoneyCell,
  SandboxBadge,
  StatusPill,
  formatAddress,
} from '@/components/billing/primitives';
import { FulfillmentDialog } from '@/components/billing/hq/FulfillmentDialog';
import { RefundDialog } from '@/components/billing/RefundDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from '@/contexts/session';
import { useToast } from '@/hooks/use-toast';
import {
  useHqBillingScope,
  useHqCatalog,
  useHqCatalogChanges,
  useHqCatalogMutations,
  useHqFulfillment,
  useHqOverview,
  useHqProvider,
  useHqProviders,
  useHqSubscriptions,
  useHqTransaction,
  useHqTransactions,
  useInvalidateHqBilling,
  useUpdateFulfillment,
} from '@/hooks/use-billing';
import { hqBilling, BillingApiError } from '@/lib/billing-api';
import {
  accountStatusLabel,
  centsToDollarsInput,
  formatCents,
  formatDate,
  formatDateTime,
  fulfillmentTone,
  FULFILLMENT_LABEL,
  humanizeRequirement,
  ORDER_KIND_LABEL,
  ORDER_STATUS_LABEL,
  orderStatusTone,
  parseDollarsToCents,
  SUBSCRIPTION_STATUS_LABEL,
  subscriptionTone,
} from '@/lib/billing-format';
import type { CatalogProduct, OrderDetail, SubscriptionRow } from '@/lib/billing-types';
import { canHq } from '@/data/hq/team';
import {
  DEMO_CATALOG,
  DEMO_CATALOG_CHANGES,
  DEMO_FULFILLMENT,
  DEMO_ORDER_DETAILS,
  DEMO_ORDERS,
  DEMO_OVERVIEW,
  DEMO_PROVIDER_DETAILS,
  DEMO_PROVIDERS,
  DEMO_SUBSCRIPTIONS,
} from './demo-data';
import { useBillingSandbox } from './use-billing-sandbox';

function Gate({ children }: { children: (demo: boolean, canWrite: boolean) => React.ReactNode }) {
  const scope = useHqBillingScope();
  const { hqRole } = useSession();
  if (scope.isResolving)
    return (
      <AdminPage>
        <Skeleton className="h-40 w-full" />
      </AdminPage>
    );
  const effectiveRole = scope.isDemo ? 'Super Admin' : hqRole;
  if (!canHq(effectiveRole, 'payments')) return <UnauthorizedState role={effectiveRole} />;
  return <>{children(scope.isDemo, effectiveRole === 'Super Admin' || effectiveRole === 'Admin')}</>;
}

function Header({
  title,
  sub,
  sandbox,
  action,
}: {
  title: string;
  sub: string;
  sandbox?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <PageHeader
      kicker="Provider payments"
      title={title}
      sub={sub}
      action={
        <div className="flex items-center gap-2">
          <SandboxBadge sandbox={sandbox} />
          {action}
        </div>
      }
    />
  );
}

function ErrorBox({ error, retry }: { error: unknown; retry(): void }) {
  return (
    <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
      {error instanceof Error ? error.message : 'Payments could not be loaded.'}{' '}
      <button className="ml-1 underline" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

function RowLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Open
    </Link>
  );
}

function clickable(navigate: (to: string) => void, href: string) {
  return (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as Element).closest('a, button, input, select, textarea') || window.getSelection()?.toString())
      return;
    navigate(href);
  };
}

function Preview() {
  return <PreviewBanner>Live payments appear here once HQ is signed in</PreviewBanner>;
}

export function PaymentsOverview() {
  return <Gate>{(demo) => <OverviewBody demo={demo} />}</Gate>;
}
function OverviewBody({ demo }: { demo: boolean }) {
  const query = useHqOverview({});
  const sandbox = useBillingSandbox();
  const data = demo ? DEMO_OVERVIEW : query.data;
  return (
    <AdminPage>
      <Header
        title="Payments overview"
        sub="Program collections, fees, profit and provider payment activity."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-44 w-full" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="Collected" value={formatCents(data.collected_cents)} />
              <MetricTile label="THINNR fees" value={formatCents(data.thinnr_fee_cents)} />
              <MetricTile label="THINNR profit" value={formatCents(data.profit_cents)} />
              <MetricTile label="Refunds" value={formatCents(data.refunded_cents)} />
              <MetricTile label="Active subscriptions" value={data.active_subscriptions} />
              <MetricTile
                label="Providers active"
                value={data.providers_onboarded}
                detail={`${data.providers_pending} pending`}
              />
              <MetricTile label="Orders to ship" value={data.to_ship} />
            </div>
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <SectionCard title="Collections trend" sub="Collected and THINNR fees by period">
                <div className="space-y-3 p-5">
                  {data.series.map((p) => (
                    <div key={p.date}>
                      <div className="flex justify-between text-xs">
                        <span>{formatDate(p.date)}</span>
                        <MoneyCell cents={p.collected_cents} />
                      </div>
                      <div className="mt-1 h-2 rounded bg-secondary">
                        <div className={`h-2 rounded bg-primary ${['w-3/4', 'w-[85%]', 'w-[92%]', 'w-full'][data.series.indexOf(p) % 4]}`} />
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
              <SectionCard title="Recent activity">
                <div className="divide-y divide-border">
                  {data.recent.map((row) => (
                    <div key={row.id} className="flex justify-between gap-4 p-4 text-xs">
                      <span>
                        <b className="text-navy">{row.label}</b>
                        <small className="block text-muted-foreground">
                          {row.office_name} · {formatDateTime(row.occurred_at)}
                        </small>
                      </span>
                      <MoneyCell cents={row.amount_cents} />
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          </>
        )
      )}
    </AdminPage>
  );
}

export function PaymentsProviders() {
  return <Gate>{(demo) => <ProvidersBody demo={demo} />}</Gate>;
}
function ProvidersBody({ demo }: { demo: boolean }) {
  const query = useHqProviders();
  const sandbox = useBillingSandbox();
  const [, navigate] = useLocation();
  const rows = demo ? DEMO_PROVIDERS : query.data?.items;
  return (
    <AdminPage>
      <Header
        title="Payment providers"
        sub="Onboarding, pricing and recent collections by office."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-60" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="All offices" sub={`${rows?.length ?? 0} payment profiles`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase text-muted-foreground">
                  <th className="p-4">Office</th>
                  <th>Status</th>
                  <th>Products</th>
                  <th>30-day collected</th>
                  <th>Fees</th>
                  <th>Pricing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => {
                  const status = accountStatusLabel(row.account);
                  return (
                    <tr
                      key={row.provider_id}
                      onClick={clickable(navigate, `/providers/${row.provider_id}`)}
                      className="cursor-pointer border-b border-border hover:bg-accent/40"
                    >
                      <td className="p-4">
                        <b className="text-navy">{row.office_name}</b>
                        <small className="block text-muted-foreground">{row.provider_name}</small>
                      </td>
                      <td>
                        <StatusPill tone={status.tone}>{status.label}</StatusPill>
                      </td>
                      <td>{row.offered_products}</td>
                      <td>
                        <MoneyCell cents={row.collected_30d_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={row.fees_30d_cents} />
                      </td>
                      <td>
                        {row.below_minimum_count ? (
                          <StatusPill tone="warn">{row.below_minimum_count} below minimum</StatusPill>
                        ) : (
                          'Current'
                        )}
                      </td>
                      <td className="p-4 text-right">
                        <RowLink
                          href={`/providers/${row.provider_id}`}
                          label={`Open ${row.office_name} payments`}
                        />
                      </td>
                    </tr>
                  );
                })}
                {!rows?.length && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground">
                      No provider payment profiles yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </AdminPage>
  );
}

export function PaymentProviderDetail({ params }: { params: { providerId: string } }) {
  return <Gate>{(demo) => <ProviderDetailBody demo={demo} id={params.providerId} />}</Gate>;
}
function ProviderDetailBody({ demo, id }: { demo: boolean; id: string }) {
  const query = useHqProvider(demo ? null : id);
  const sandbox = useBillingSandbox();
  const data = demo ? DEMO_PROVIDER_DETAILS[id] : query.data;
  return (
    <AdminPage>
      <Link href="/providers" className="mb-3 inline-flex text-xs font-semibold text-primary hover:underline">
        Back to providers
      </Link>
      <Header
        title={data?.office.office_name ?? 'Provider payment profile'}
        sub="Connected account, requirements, pricing and payment activity."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-64" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="Connected account">
            {data.account ? (
              <>
                <StatusPill tone={accountStatusLabel(data.account).tone}>
                  {accountStatusLabel(data.account).label}
                </StatusPill>
                <DetailList
                  items={[
                    { label: 'Charges', value: data.account.charges_enabled ? 'Enabled' : 'Not enabled' },
                    { label: 'Payouts', value: data.account.payouts_enabled ? 'Enabled' : 'Not enabled' },
                    { label: 'Tax', value: data.account.tax_enabled ? 'Enabled' : 'Not enabled' },
                    { label: 'Last synced', value: formatDateTime(data.account.last_synced_at) },
                  ]}
                />
                {[...data.account.requirements.past_due, ...data.account.requirements.currently_due].length > 0 && (
                  <ul className="mt-3 list-disc pl-5 text-xs text-destructive">
                    {[...data.account.requirements.past_due, ...data.account.requirements.currently_due].map((x) => (
                      <li key={x}>{humanizeRequirement(x)}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="p-4 text-xs text-muted-foreground">This office has not connected Stripe.</p>
            )}
          </SectionCard>
          <SectionCard title="Onboarding timeline">
            <div className="divide-y divide-border">
              {data.events.map((e) => (
                <div className="p-3 text-xs" key={e.id}>
                  <b className="text-navy">{humanizeRequirement(e.kind)}</b>
                  <small className="block text-muted-foreground">{formatDateTime(e.created_at)}</small>
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Price list" className="lg:col-span-2">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="p-3 text-left">Product</th>
                    <th>Floor</th>
                    <th>Minimum</th>
                    <th>Office price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.prices.map((p) => (
                    <tr key={p.product_id} className="border-t">
                      <td className="p-3">{p.name}</td>
                      <td>
                        <MoneyCell cents={p.floor_price_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.break_even_minimum_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.sell_price_cents} />
                      </td>
                      <td>
                        {p.below_minimum ? (
                          <StatusPill tone="bad">Below minimum</StatusPill>
                        ) : p.offered ? (
                          'Offered'
                        ) : (
                          'Not offered'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
          <SectionCard title="Subscriptions">
            <p className="p-4 text-xs">
              {data.subscriptions.active} active · {data.subscriptions.past_due} past due ·{' '}
              {data.subscriptions.canceled} canceled
            </p>
          </SectionCard>
          <SectionCard title="Payouts">
            {data.payouts.map((p) => (
              <div className="flex justify-between border-b p-3 text-xs" key={p.id}>
                <span>
                  {formatDate(p.arrival_date)} · {p.status}
                </span>
                <MoneyCell cents={p.amount_cents} />
              </div>
            ))}
          </SectionCard>
        </div>
      ) : demo ? (
        <p role="status" className="rounded-md border p-8 text-center text-xs text-muted-foreground">This demo provider could not be found.</p>
      ) : null}
    </AdminPage>
  );
}

function useUrlFilters(base: string) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    value ? next.set(key, value) : next.delete(key);
    navigate(`${base}${next.toString() ? `?${next}` : ''}`, { replace: true });
  };
  return { params, set };
}

export function PaymentsTransactions() {
  return <Gate>{(demo) => <TransactionsBody demo={demo} />}</Gate>;
}
function TransactionsBody({ demo }: { demo: boolean }) {
  const url = useUrlFilters('/transactions');
  const [, navigate] = useLocation();
  const filters = Object.fromEntries(url.params.entries());
  const query = useHqTransactions(filters);
  const sandbox = useBillingSandbox();
  const rows = demo ? DEMO_ORDERS : query.data?.items;
  return (
    <AdminPage>
      <Header title="Transactions" sub="Search and review all provider orders." sandbox={sandbox.data?.sandbox} />
      {demo && <Preview />}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <label className="relative lg:col-span-2">
          <Search className="absolute left-3 top-2.5" size={14} />
          <input
            aria-label="Search transactions"
            className={`${INPUT_CLASS} w-full pl-9`}
            value={url.params.get('q') ?? ''}
            onChange={(e) => url.set('q', e.target.value)}
            placeholder="Order, office or payer"
          />
        </label>
        {['provider_id', 'status', 'kind', 'from', 'to'].map((key) =>
          key === 'provider_id' ? null : key === 'from' || key === 'to' ? (
            <input
              key={key}
              aria-label={key}
              type="date"
              className={INPUT_CLASS}
              value={url.params.get(key) ?? ''}
              onChange={(e) => url.set(key, e.target.value)}
            />
          ) : (
            <select
              key={key}
              aria-label={key}
              className={INPUT_CLASS}
              value={url.params.get(key) ?? ''}
              onChange={(e) => url.set(key, e.target.value)}
            >
              <option value="">All {key}</option>
              {(key === 'status'
                ? ['pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'disputed', 'canceled']
                : ['one_time', 'subscription_initial', 'subscription_renewal']
              ).map((x) => (
                <option key={x} value={x}>
                  {humanizeRequirement(x)}
                </option>
              ))}
            </select>
          ),
        )}
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-60" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Orders">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs">
              <thead>
                <tr>
                  <th className="p-3 text-left">Order</th>
                  <th>Office</th>
                  <th>Payer</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Date</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr
                    key={row.id}
                    onClick={clickable(navigate, `/transactions/${row.id}`)}
                    className="cursor-pointer border-t hover:bg-accent/40"
                  >
                    <td className="p-3 font-semibold">{row.order_number}</td>
                    <td>{row.office_name}</td>
                    <td>{row.payer.name}</td>
                    <td>{ORDER_KIND_LABEL[row.kind]}</td>
                    <td>
                      <StatusPill tone={orderStatusTone(row.status)}>{ORDER_STATUS_LABEL[row.status]}</StatusPill>
                    </td>
                    <td>
                      <MoneyCell cents={row.total_cents} />
                    </td>
                    <td>{formatDate(row.paid_at ?? row.created_at)}</td>
                    <td>
                      <RowLink
                        href={`/transactions/${row.id}`}
                        label={`Open order ${row.order_number}`}
                      />
                    </td>
                  </tr>
                ))}
                {!rows?.length && (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">
                      No transactions match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
    </AdminPage>
  );
}

export function PaymentTransactionDetail({ params }: { params: { orderId: string } }) {
  return (
    <Gate>{(demo, canWrite) => <TransactionDetailBody demo={demo} canWrite={canWrite} id={params.orderId} />}</Gate>
  );
}
function TransactionDetailBody({ demo, canWrite, id }: { demo: boolean; canWrite: boolean; id: string }) {
  const query = useHqTransaction(demo ? null : id);
  const sandbox = useBillingSandbox();
  const invalidate = useInvalidateHqBilling();
  const { toast } = useToast();
  const [refundOpen, setRefundOpen] = useState(false);
  const refund = useMutation({
    mutationFn: (body: { amount_cents?: number; reason: string }) => hqBilling.refund(id, body),
    onSuccess: () => {
      setRefundOpen(false);
      void invalidate();
      toast({ variant: 'success', title: 'Refund submitted' });
    },
  });
  const order = demo ? DEMO_ORDER_DETAILS.find((row) => row.id === id) : query.data;
  return (
    <AdminPage>
      <Link href="/transactions" className="mb-3 inline-flex text-xs font-semibold text-primary hover:underline">
        Back to transactions
      </Link>
      <Header
        title={order ? `Order ${order.order_number}` : 'Transaction detail'}
        sub="Complete payment, fulfillment and Stripe record."
        sandbox={sandbox.data?.sandbox}
        action={
          order && canWrite ? (
            <button className={BTN_PRIMARY} onClick={() => setRefundOpen(true)}>
              Refund
            </button>
          ) : undefined
        }
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-80" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : order ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <SectionCard title="Order">
            <DetailList
              items={[
                { label: 'Office', value: order.office_name },
                { label: 'Payer', value: `${order.payer.name} · ${order.payer.email ?? 'No email'}` },
                {
                  label: 'Status',
                  value: (
                    <StatusPill tone={orderStatusTone(order.status)}>{ORDER_STATUS_LABEL[order.status]}</StatusPill>
                  ),
                },
                { label: 'Paid', value: formatDateTime(order.paid_at) },
              ]}
            />
            <div className="mt-4">
              {order.items.map((i) => (
                <div key={i.id} className="flex justify-between border-t py-2 text-xs">
                  <span>
                    {i.product_name} × {i.quantity}
                  </span>
                  <MoneyCell cents={i.unit_price_cents * i.quantity} />
                </div>
              ))}
            </div>
          </SectionCard>
          <SectionCard title="Fees and profit">
            <FeeBreakdown fees={order.fees} profit={order.profit} perspective="hq" />
          </SectionCard>
          <SectionCard title="Shipping and fulfillment">
            <address className="not-italic text-xs">
              {formatAddress(order.shipping_address).map((x) => (
                <span className="block" key={x}>
                  {x}
                </span>
              ))}
            </address>
            <DetailList
              items={[
                { label: 'Status', value: FULFILLMENT_LABEL[order.fulfillment_status] },
                { label: 'Carrier', value: order.carrier ?? '—' },
                { label: 'Tracking', value: order.tracking_number ?? '—' },
                { label: 'Canceled reason', value: order.canceled_reason ?? '—' },
              ]}
            />
          </SectionCard>
          <SectionCard title="Refunds and disputes">
            <div className="text-xs">
              {order.refunds.map((r) => (
                <p key={r.id}>
                  {formatDateTime(r.created_at)} · {formatCents(r.amount_cents)} · {r.status} · {r.reason}
                </p>
              ))}
              {order.disputes.map((d) => (
                <p key={d.id}>
                  {formatDateTime(d.created_at)} · Dispute {d.status} · {formatCents(d.amount_cents)}
                </p>
              ))}
              {!order.refunds.length && !order.disputes.length && (
                <p className="text-muted-foreground">No refunds or disputes.</p>
              )}
            </div>
          </SectionCard>
          <SectionCard title="Stripe references" className="lg:col-span-2">
            <p className="break-all font-mono text-[10px] text-muted-foreground">
              {Object.entries(order.stripe)
                .map(([k, v]) => `${k}: ${v ?? '—'}`)
                .join(' · ')}
            </p>
          </SectionCard>
          <RefundDialog
            order={order}
            open={refundOpen}
            onOpenChange={setRefundOpen}
            pending={refund.isPending}
            error={refund.error instanceof Error ? refund.error.message : null}
            onConfirm={(amount_cents, reason) => {
              if (demo) {
                toast({ title: 'Preview only', description: 'Sign in to issue a live refund.' });
                setRefundOpen(false);
                return;
              }
              refund.mutate({ amount_cents, reason });
            }}
          />
        </div>
      ) : demo ? (
        <p role="status" className="rounded-md border p-8 text-center text-xs text-muted-foreground">This demo transaction could not be found.</p>
      ) : null}
    </AdminPage>
  );
}

export function PaymentsFulfillment() {
  return <Gate>{(demo, canWrite) => <FulfillmentBody demo={demo} canWrite={canWrite} />}</Gate>;
}
function FulfillmentBody({ demo, canWrite }: { demo: boolean; canWrite: boolean }) {
  const url = useUrlFilters('/fulfillment');
  const status = url.params.get('status') || 'to_ship';
  const query = useHqFulfillment({ status });
  const sandbox = useBillingSandbox();
  const mutation = useUpdateFulfillment();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ order: OrderDetail; mode: 'ship' | 'cancel' } | null>(null);
  const rows = demo ? DEMO_FULFILLMENT.filter((order) => order.fulfillment_status === status) : query.data?.items;
  const update = (value: { carrier?: string; tracking_number?: string; canceled_reason?: string }) => {
    if (!dialog) return;
    if (demo) {
      toast({ title: 'Preview only', description: 'Sign in to update live fulfillment.' });
      setDialog(null);
      return;
    }
    mutation.mutate(
      { orderId: dialog.order.id, status: dialog.mode === 'ship' ? 'shipped' : 'canceled', ...value },
      {
        onSuccess: () => {
          toast({
            variant: 'success',
            title: dialog.mode === 'ship' ? 'Shipped. The patient was emailed the tracking number.' : 'Order canceled.',
          });
          setDialog(null);
        },
      },
    );
  };
  return (
    <AdminPage>
      <Header title="Fulfillment" sub="Ship paid orders and keep patients informed." sandbox={sandbox.data?.sandbox} />
      {demo && <Preview />}
      <div className="mb-4 flex gap-2">
        {(['to_ship', 'shipped', 'canceled'] as const).map((x) => (
          <button
            key={x}
            onClick={() => url.set('status', x)}
            className={`${x === status ? BTN_PRIMARY : BTN_SECONDARY} h-9`}
          >
            {FULFILLMENT_LABEL[x]}
          </button>
        ))}
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-64" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <div className="space-y-3">
          {rows?.map((order) => (
            <SectionCard
              key={order.id}
              title={`${order.order_number} · ${order.office_name}`}
              sub={`${order.payer.name} · paid ${formatDate(order.paid_at)}`}
              action={
                <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>
                  {FULFILLMENT_LABEL[order.fulfillment_status]}
                </StatusPill>
              }
            >
              <div className="grid gap-4 p-4 md:grid-cols-3">
                <div className="text-xs">
                  {order.items.map((i) => (
                    <p key={i.id}>
                      {i.product_name} × {i.quantity}
                    </p>
                  ))}
                </div>
                <address className="not-italic text-xs">
                  {formatAddress(order.shipping_address).map((x) => (
                    <span key={x} className="block">
                      {x}
                    </span>
                  ))}
                  <button
                    className="mt-2 text-primary underline"
                    onClick={async () => {
                      const ok = await copyText(formatAddress(order.shipping_address).join('\n'));
                      toast({ title: ok ? 'Address copied' : 'Could not copy address' });
                    }}
                  >
                    Copy address
                  </button>
                </address>
                {canWrite && order.fulfillment_status === 'to_ship' && (
                  <div className="flex items-start justify-end gap-2">
                    <button className={BTN_SECONDARY} onClick={() => setDialog({ order, mode: 'cancel' })}>
                      Cancel order
                    </button>
                    <button
                      data-testid={`button-ship-${order.id}`}
                      className={BTN_PRIMARY}
                      onClick={() => setDialog({ order, mode: 'ship' })}
                    >
                      Mark shipped
                    </button>
                  </div>
                )}
              </div>
            </SectionCard>
          ))}
          {!rows?.length && (
            <p className="rounded-md border p-8 text-center text-xs text-muted-foreground">No orders in this queue.</p>
          )}
        </div>
      )}
      {dialog && (
        <FulfillmentDialog
          order={dialog.order}
          mode={dialog.mode}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onConfirm={update}
          pending={mutation.isPending}
          error={mutation.error instanceof Error ? mutation.error.message : null}
        />
      )}
    </AdminPage>
  );
}

function productMath(
  floor: number,
  hard: number | null,
  shippingCharge: number,
  shippingCost: number,
  bps: number,
  fixed: number,
) {
  const share = Math.floor((floor * 60) / 100);
  const stripe = (sell: number) => Math.round(((sell + shippingCharge) * bps) / 10000) + fixed;
  let minimum = Math.max(0, Math.floor((share + fixed) / (1 - bps / 10000)));
  while (minimum - share - stripe(minimum) < 0) minimum += 1;
  while (minimum > 0 && minimum - 1 - share - stripe(minimum - 1) >= 0) minimum -= 1;
  return { share, minimum, profit: hard === null ? null : share - hard };
}

export function PaymentsCatalog() {
  return <Gate>{(demo, canWrite) => <CatalogBody demo={demo} canWrite={canWrite} />}</Gate>;
}
function CatalogBody({ demo, canWrite }: { demo: boolean; canWrite: boolean }) {
  const query = useHqCatalog();
  const sandbox = useBillingSandbox();
  const mutations = useHqCatalogMutations();
  const { toast } = useToast();
  const [editing, setEditing] = useState<CatalogProduct | 'new' | null>(null);
  const data = demo ? DEMO_CATALOG : query.data;
  return (
    <AdminPage>
      <Header
        title="Product catalog"
        sub="Pricing floors, costs, fee assumptions and change controls."
        sandbox={sandbox.data?.sandbox}
        action={
          canWrite ? (
            <button data-testid="button-catalog-add" className={BTN_PRIMARY} onClick={() => setEditing('new')}>
              Add product
            </button>
          ) : undefined
        }
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-72" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : data ? (
        <>
          <SectionCard
            title="Products"
            sub={`${data.offices_below_minimum} offices have pricing below the current minimum`}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] text-xs">
                <thead>
                  <tr>
                    <th className="p-3 text-left">Product</th>
                    <th>Floor</th>
                    <th>Hard cost</th>
                    <th>THINNR share</th>
                    <th>Minimum</th>
                    <th>Profit per unit</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-3 font-semibold">{p.name}</td>
                      <td>
                        <MoneyCell cents={p.floor_price_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.hard_cost_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.thinnr_share_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.break_even_minimum_cents} />
                      </td>
                      <td>
                        <MoneyCell cents={p.hq_profit_per_unit_cents} />
                      </td>
                      <td>
                        <StatusPill tone={p.active ? 'good' : 'neutral'}>{p.active ? 'Active' : 'Retired'}</StatusPill>
                      </td>
                      <td className="p-2">
                        {canWrite && (
                          <div className="flex gap-1">
                            <button className={BTN_SECONDARY} onClick={() => setEditing(p)}>
                              Edit
                            </button>
                            <button
                              className={BTN_SECONDARY}
                              onClick={() => {
                                if (demo) {
                                  toast({ title: 'Preview only', description: 'Sign in to change the live catalog.' });
                                  return;
                                }
                                (p.active ? mutations.retire : mutations.reactivate).mutate(p.id, {
                                  onSuccess: () =>
                                    toast({
                                      variant: 'success',
                                      title: p.active ? 'Product retired' : 'Product reactivated',
                                    }),
                                });
                              }}
                            >
                              {p.active ? 'Retire' : 'Reactivate'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
          <SettingsCard data={data} canWrite={canWrite} demo={demo} />
          <Link
            className="mt-4 inline-block text-xs font-semibold text-primary underline"
            href="/catalog/history"
          >
            View catalog change history
          </Link>
          {editing && (
            <ProductDialog
              product={editing === 'new' ? null : editing}
              settings={data.settings}
              open
              onOpenChange={(open) => !open && setEditing(null)}
        onSave={(body) => {
          if (demo) {
            toast({ title: 'Preview only', description: 'Sign in to change the live catalog.' });
            setEditing(null);
            return;
          }
                const success = () => {
                  setEditing(null);
                  toast({ variant: 'success', title: editing === 'new' ? 'Product added' : 'Product updated' });
                };
                if (editing === 'new') mutations.create.mutate(body, { onSuccess: success });
                else mutations.update.mutate({ productId: editing.id, ...body }, { onSuccess: success });
              }}
              pending={mutations.create.isPending || mutations.update.isPending}
            />
          )}
        </>
      ) : null}
    </AdminPage>
  );
}

function ProductDialog({
  product,
  settings,
  open,
  onOpenChange,
  onSave,
  pending,
}: {
  product: CatalogProduct | null;
  settings: {
    shipping_charge_cents: number;
    shipping_cost_cents: number;
    card_fee_bps: number;
    card_fee_fixed_cents: number;
  };
  open: boolean;
  onOpenChange(open: boolean): void;
  onSave(body: { name: string; floor_price_cents: number; hard_cost_cents: number }): void;
  pending: boolean;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [floor, setFloor] = useState(centsToDollarsInput(product?.floor_price_cents));
  const [hard, setHard] = useState(centsToDollarsInput(product?.hard_cost_cents));
  const [error, setError] = useState<string | null>(null);
  const parsedFloor = parseDollarsToCents(floor);
  const parsedHard = parseDollarsToCents(hard);
  const math =
    parsedFloor.ok
      ? productMath(
          parsedFloor.cents,
          parsedHard.ok ? parsedHard.cents : null,
          settings.shipping_charge_cents,
          settings.shipping_cost_cents,
          settings.card_fee_bps,
          settings.card_fee_fixed_cents,
        )
      : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-serif text-navy">{product ? 'Edit product' : 'Add product'}</DialogTitle>
          <DialogDescription>Amounts accept no more than two decimal places.</DialogDescription>
        </DialogHeader>
        <label>
          <span className={PANEL_LABEL}>Name</span>
          <input
            data-testid="input-catalog-name"
            className={`${INPUT_CLASS} w-full`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span className={PANEL_LABEL}>Floor price</span>
          <input
            data-testid="input-catalog-floor"
            className={`${INPUT_CLASS} w-full`}
            value={floor}
            onChange={(e) => setFloor(e.target.value)}
          />
        </label>
        <label>
          <span className={PANEL_LABEL}>Hard cost</span>
          <input
            data-testid="input-catalog-hard-cost"
            className={`${INPUT_CLASS} w-full`}
            value={hard}
            onChange={(e) => setHard(e.target.value)}
          />
        </label>
        {math && (
          <div data-testid="catalog-live-math" className="rounded bg-secondary p-3 text-xs">
            THINNR share {formatCents(math.share)} · office minimum {formatCents(math.minimum)} · HQ profit per unit{' '}
            {formatCents(math.profit)}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <button className={BTN_SECONDARY} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            data-testid="button-catalog-save"
            disabled={pending}
            className={BTN_PRIMARY}
            onClick={() => {
              if (!name.trim()) return setError('Enter a product name.');
              if (!parsedFloor.ok) return setError(parsedFloor.error);
              if (!parsedHard.ok) return setError(parsedHard.error);
              onSave({ name: name.trim(), floor_price_cents: parsedFloor.cents, hard_cost_cents: parsedHard.cents });
            }}
          >
            {pending ? 'Saving…' : 'Save product'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsCard({
  data,
  canWrite,
  demo,
}: {
  data: NonNullable<ReturnType<typeof useHqCatalog>['data']>;
  canWrite: boolean;
  demo: boolean;
}) {
  const mutation = useHqCatalogMutations().settings;
  const { toast } = useToast();
  const s = data.settings;
  const [form, setForm] = useState({
    shipping_charge_cents: s.shipping_charge_cents,
    shipping_cost_cents: s.shipping_cost_cents,
    card_fee_bps: s.card_fee_bps,
    card_fee_fixed_cents: s.card_fee_fixed_cents,
  });
  return (
    <SectionCard
      className="mt-5"
      title="Program settings"
      sub="Shipping and card fee assumptions drive every break-even minimum."
    >
      <div className="grid gap-3 p-4 sm:grid-cols-4">
        {Object.entries(form).map(([key, value]) => (
          <label key={key}>
            <span className={PANEL_LABEL}>{humanizeRequirement(key)}</span>
            <input
              type="number"
              className={`${INPUT_CLASS} w-full`}
              value={value}
              disabled={!canWrite}
              onChange={(e) => setForm((x) => ({ ...x, [key]: Number(e.target.value) }))}
            />
          </label>
        ))}
      </div>
      {canWrite && (
        <button
          className={`${BTN_PRIMARY} m-4 mt-0`}
          onClick={() => {
            if (demo) {
              toast({ title: 'Preview only', description: 'Sign in to change live payment settings.' });
              return;
            }
            mutation.mutate(
              { ...form, expected_version: s.version },
              { onSuccess: () => toast({ variant: 'success', title: 'Settings saved' }) },
            );
          }}
        >
          Save settings
        </button>
      )}
      {mutation.error && (
        <p role="alert" className="m-4 text-xs text-destructive">
          {mutation.error instanceof BillingApiError && mutation.error.status === 409
            ? 'Someone else changed these settings. Reload to see the latest.'
            : mutation.error.message}
        </p>
      )}
    </SectionCard>
  );
}

export function PaymentsCatalogHistory() {
  return <Gate>{(demo) => <CatalogHistoryBody demo={demo} />}</Gate>;
}
function CatalogHistoryBody({ demo }: { demo: boolean }) {
  const query = useHqCatalogChanges({});
  const sandbox = useBillingSandbox();
  const rows = demo ? DEMO_CATALOG_CHANGES : query.data?.items;
  return (
    <AdminPage>
      <Header
        title="Catalog history"
        sub="An audit trail of product and program setting changes."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      {!demo && query.isPending ? (
        <Skeleton className="h-52" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Changes">
          <div className="divide-y">
            {rows?.map((c) => (
              <div key={c.id} className="grid gap-1 p-4 text-xs sm:grid-cols-3">
                <b>{humanizeRequirement(c.kind)}</b>
                <span>{c.product_name ?? 'Program settings'}</span>
                <span className="text-muted-foreground">
                  {c.actor_name ?? 'System'} · {formatDateTime(c.created_at)}
                </span>
              </div>
            ))}
            {!rows?.length && (
              <p className="p-8 text-center text-xs text-muted-foreground">No catalog changes recorded.</p>
            )}
          </div>
        </SectionCard>
      )}
    </AdminPage>
  );
}

export function PaymentsSubscriptions() {
  return <Gate>{(demo, canWrite) => <SubscriptionsBody demo={demo} canWrite={canWrite} />}</Gate>;
}
function SubscriptionsBody({ demo, canWrite }: { demo: boolean; canWrite: boolean }) {
  const url = useUrlFilters('/subscriptions');
  const query = useHqSubscriptions(Object.fromEntries(url.params.entries()));
  const sandbox = useBillingSandbox();
  const invalidate = useInvalidateHqBilling();
  const { toast } = useToast();
  const cancel = useMutation({
    mutationFn: ({ id, at_period_end }: { id: string; at_period_end: boolean }) =>
      hqBilling.cancelSubscription(id, { at_period_end }),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Subscription cancellation saved' });
    },
  });
  const [canceling, setCanceling] = useState<{ row: SubscriptionRow; atPeriodEnd: boolean } | null>(null);
  const rows = demo ? DEMO_SUBSCRIPTIONS : query.data?.items;
  return (
    <AdminPage>
      <Header
        title="Subscriptions"
        sub="Four-week product subscriptions across every office."
        sandbox={sandbox.data?.sandbox}
      />
      {demo && <Preview />}
      <div className="mb-4 flex gap-2">
        <select
          className={INPUT_CLASS}
          aria-label="Subscription status"
          value={url.params.get('status') ?? ''}
          onChange={(e) => url.set('status', e.target.value)}
        >
          <option value="">All statuses</option>
          {['incomplete', 'active', 'past_due', 'canceled', 'unpaid'].map((x) => (
            <option value={x} key={x}>
              {humanizeRequirement(x)}
            </option>
          ))}
        </select>
        <input
          className={INPUT_CLASS}
          aria-label="Office filter"
          placeholder="Office id"
          value={url.params.get('provider_id') ?? ''}
          onChange={(e) => url.set('provider_id', e.target.value)}
        />
      </div>
      {!demo && query.isPending ? (
        <Skeleton className="h-60" />
      ) : !demo && query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <SectionCard title="Program subscriptions">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr>
                  <th className="p-3 text-left">Patient</th>
                  <th>Office</th>
                  <th>Product</th>
                  <th>Status</th>
                  <th>Renewal</th>
                  <th>Price</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows?.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="p-3">{row.payer.name}</td>
                    <td>{row.office_name}</td>
                    <td>{row.product_name}</td>
                    <td>
                      <StatusPill tone={subscriptionTone(row.status)}>
                        {SUBSCRIPTION_STATUS_LABEL[row.status]}
                      </StatusPill>
                    </td>
                    <td>
                      {row.cancel_at_period_end
                        ? `Ends ${formatDate(row.current_period_end)}`
                        : formatDate(row.current_period_end)}
                    </td>
                    <td>
                      <MoneyCell cents={row.unit_price_cents + row.shipping_charge_cents} />
                    </td>
                    <td>
                      {canWrite && row.status !== 'canceled' && (
                        <span className="flex gap-1">
                          <button
                            className={BTN_SECONDARY}
                            disabled={cancel.isPending}
                            onClick={() => setCanceling({ row, atPeriodEnd: true })}
                          >
                            Cancel at renewal
                          </button>
                          <button
                            className={BTN_SECONDARY}
                            disabled={cancel.isPending}
                            onClick={() => setCanceling({ row, atPeriodEnd: false })}
                          >
                            Cancel now
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows?.length && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-muted-foreground">
                      No subscriptions match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
      <Dialog open={Boolean(canceling)} onOpenChange={(open) => !open && setCanceling(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Cancel subscription</DialogTitle>
            <DialogDescription>
              {canceling?.atPeriodEnd
                ? `${canceling.row.payer.name}'s subscription will remain active through ${formatDate(canceling.row.current_period_end)}.`
                : `${canceling?.row.payer.name}'s subscription will end immediately.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button className={BTN_SECONDARY} onClick={() => setCanceling(null)}>Back</button>
            <button
              className={BTN_PRIMARY}
              disabled={cancel.isPending}
              onClick={() => {
                if (!canceling) return;
                if (demo) {
                  toast({ title: 'Preview only', description: 'Sign in to cancel a live subscription.' });
                  setCanceling(null);
                  return;
                }
                cancel.mutate(
                  { id: canceling.row.id, at_period_end: canceling.atPeriodEnd },
                  { onSuccess: () => setCanceling(null) },
                );
              }}
            >
              Confirm cancellation
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}
