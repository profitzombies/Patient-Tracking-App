import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, Redirect, Route, Switch, useLocation, useSearch } from 'wouter';
import { ArrowRight, Copy, ExternalLink, ShieldCheck } from 'lucide-react';
import { PageHeader, MetricTile } from '@/components/admin/primitives';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CHIP_WARM,
  INPUT_CLASS,
  PANEL_LABEL,
  SectionCard,
} from '@/components/patient/heritage';
import {
  DetailList,
  FeeBreakdown,
  MoneyCell,
  SandboxBadge,
  StatusPill,
  formatAddress,
} from '@/components/billing/primitives';
import {
  ConnectAccountManagement,
  ConnectDocuments,
  ConnectEmbed,
  ConnectNotificationBanner,
  ConnectOnboarding,
  ConnectPayouts,
  ConnectTaxRegistrations,
  ConnectTaxSettings,
} from '@/components/billing/ConnectEmbed';
import { RefundDialog } from '@/components/billing/RefundDialog';
import {
  useInvalidateOfficeBilling,
  useOfficeBillingScope,
  useOfficeBillingStatus,
  useOfficeDashboard,
  useOfficeLinks,
  useOfficeOrder,
  useOfficeOrders,
  useOfficePayouts,
  useOfficePrices,
  useOfficeSubscriptions,
  useUpdateOfficePrice,
} from '@/hooks/use-billing';
import { useToast } from '@/hooks/use-toast';
import { BillingApiError, officeBilling } from '@/lib/billing-api';
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
import type { OfficeBillingStatus, OfficePrice, OrderDetail, OrderSummary, PaymentLink } from '@/lib/billing-types';
import { DEMO_DASHBOARD, DEMO_LINKS, DEMO_ORDER_DETAILS, DEMO_ORDERS, DEMO_PRICES, DEMO_SUBSCRIPTIONS } from './demo-data';
import NotFound from '@/pages/not-found';

const PAGE = 'mx-auto max-w-[1320px] space-y-6 px-4 py-6 sm:px-5 sm:py-7 md:px-8';
const permissionText = 'Only office owners and admins can manage payments.';

function ErrorBox({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-card p-5">
      <p className="text-xs text-destructive">
        {error instanceof Error ? error.message : 'Payments could not be loaded.'}
      </p>
      <button type="button" className={`${BTN_SECONDARY} mt-3 h-8 px-3`} onClick={retry}>
        Try again
      </button>
    </div>
  );
}

function PermissionState() {
  return (
    <div className={PAGE}>
      <div
        role="alert"
        data-testid="status-billing-unauthorized"
        className="rounded-lg border border-card-border bg-card p-7 shadow-soft"
      >
        <ShieldCheck size={18} className="text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-3 font-serif text-xl font-bold text-navy">Payments access is restricted</h1>
        <p className="mt-2 text-xs text-muted-foreground">{permissionText}</p>
      </div>
    </div>
  );
}

function DemoNotice() {
  return (
    <div
      role="note"
      data-testid="billing-demo-notice"
      className="rounded-md border border-accent-border bg-accent px-4 py-3 text-xs text-foreground"
    >
      Live payments appear here once your office is signed in.
    </div>
  );
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
  action?: ReactNode;
}) {
  return (
    <PageHeader
      kicker="Payments"
      title={
        <span className="flex flex-wrap items-center gap-3">
          {title}
          <SandboxBadge sandbox={sandbox} />
        </span>
      }
      sub={sub}
      action={action}
    />
  );
}

function Boundary({
  children,
  allowNoAccount = false,
  demo,
}: {
  children: (status: OfficeBillingStatus) => ReactNode;
  allowNoAccount?: boolean;
  demo: ReactNode;
}) {
  const scope = useOfficeBillingScope();
  const status = useOfficeBillingStatus({
    retry: (count, error) => !(error instanceof BillingApiError && error.status === 403) && count < 2,
  });
  if (scope.isResolving)
    return (
      <div className={PAGE}>
        <p className="text-xs text-muted-foreground">Checking your sign-in…</p>
      </div>
    );
  if (scope.isDemo) return <>{demo}</>;
  if (!scope.liveEnabled) return <PermissionState />;
  if (status.isPending)
    return (
      <div className={PAGE}>
        <div className="h-28 animate-pulse rounded-lg bg-card" />
      </div>
    );
  if (
    (status.error instanceof BillingApiError && status.error.status === 403) ||
    status.data?.viewer.can_manage === false
  )
    return <PermissionState />;
  if (status.isError || !status.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={status.error} retry={() => void status.refetch()} />
      </div>
    );
  if (!allowNoAccount && status.data.account === null) return <Redirect to="/get-paid" />;
  return <>{children(status.data)}</>;
}

function demoPage(title: string, body: ReactNode) {
  return (
    <div className={PAGE}>
      <Header title={title} sub="A guided example of your office payment workspace." sandbox />
      <DemoNotice />
      {body}
    </div>
  );
}

function GetPaid() {
  return (
    <Boundary allowNoAccount demo={demoPage('Get paid', <SetupCards status={null} demo />)}>
      {(status) => <GetPaidLive status={status} />}
    </Boundary>
  );
}

function SetupCards({ status, demo = false }: { status: OfficeBillingStatus | null; demo?: boolean }) {
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: () => officeBilling.createAccount(office),
    onSuccess: () => void invalidate(),
    onError: (error) =>
      toast({
        variant: 'destructive',
        title: 'Account not created',
        description: error instanceof Error ? error.message : 'Try again.',
      }),
  });
  const oauth = async () => {
    try {
      window.location.assign((await officeBilling.oauthStart(office)).url);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Stripe connection not started',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    }
  };
  const oauthAvailable = demo || status?.oauth_available;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SectionCard title="Connect an existing Stripe account" sub="Use an account your office already manages.">
        <div className="p-5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Authorize THINNR to create charges and deduct the program fee.
          </p>
          {oauthAvailable ? (
            <button
              data-testid="button-oauth-start"
              type="button"
              className={`${BTN_SECONDARY} mt-4 h-9 px-3.5`}
              disabled={demo}
              onClick={() => void oauth()}
            >
              Connect Stripe <ExternalLink size={13} aria-hidden="true" />
            </button>
          ) : (
            <p data-testid="oauth-unavailable" className="mt-4 text-xs text-muted-foreground">
              Existing account connection is not configured yet. You can set up a new account now.
            </p>
          )}
        </div>
      </SectionCard>
      <SectionCard title="Set up a new account" sub="Create a Stripe account without leaving THINNR.">
        <div className="p-5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Stripe securely collects business, owner, and bank details.
          </p>
          <button
            data-testid="button-create-account"
            type="button"
            className={`${BTN_PRIMARY} mt-4 h-9 px-3.5`}
            disabled={demo || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Start setup'}
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

function GetPaidLive({ status }: { status: OfficeBillingStatus }) {
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const { toast } = useToast();
  const search = new URLSearchParams(useSearch());
  const sync = useMutation({
    mutationFn: () => officeBilling.sync(office),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Payment status refreshed' });
    },
    onError: (error) =>
      toast({
        variant: 'destructive',
        title: 'Status not refreshed',
        description: error instanceof Error ? error.message : 'Try again.',
      }),
  });
  useEffect(() => {
    if (search.get('connected') === '1') toast({ variant: 'success', title: 'Stripe account connected' });
    if (search.get('error'))
      toast({
        variant: 'destructive',
        title: 'Stripe connection was not completed',
        description: search.get('error') ?? undefined,
      });
  }, []);
  const account = status.account;
  const needsOnboarding = account && (!account.details_submitted || account.requirements.currently_due.length > 0);
  const chip = accountStatusLabel(account);
  return (
    <div className={PAGE}>
      <Header
        title="Get paid"
        sub="Your office is the merchant of record, pays Stripe’s card processing fees, and has THINNR’s program fee deducted automatically."
        sandbox={status.sandbox}
        action={
          account ? (
            <button className={`${BTN_SECONDARY} h-9 px-3.5`} onClick={() => sync.mutate()} disabled={sync.isPending}>
              Refresh status
            </button>
          ) : undefined
        }
      />
      {!account ? (
        <SetupCards status={status} />
      ) : (
        <>
          <SectionCard title="Stripe account" action={<StatusPill tone={chip.tone}>{chip.label}</StatusPill>}>
            <div className="grid gap-4 p-5 sm:grid-cols-3">
              <Flag label="Charges" on={account.charges_enabled} />
              <Flag label="Payouts" on={account.payouts_enabled} />
              <Flag label="Details submitted" on={account.details_submitted} />
            </div>
          </SectionCard>
          <ConnectEmbed components={['notification_banner']} office={office}>
            <ConnectNotificationBanner />
          </ConnectEmbed>
          {(account.requirements.currently_due.length > 0 || account.requirements.past_due.length > 0) && (
            <SectionCard
              title="Information Stripe needs"
              sub={
                account.requirements.current_deadline
                  ? `Due ${formatDate(account.requirements.current_deadline)}`
                  : undefined
              }
            >
              <ul className="list-disc space-y-1 px-9 py-5 text-xs text-muted-foreground">
                {[...account.requirements.past_due, ...account.requirements.currently_due].map((item) => (
                  <li key={item}>{humanizeRequirement(item)}</li>
                ))}
              </ul>
            </SectionCard>
          )}
          {needsOnboarding && (
            <SectionCard title="Continue setup" sub="Complete the secure Stripe steps below.">
              <div className="p-5">
                <ConnectEmbed components={['account_onboarding']} office={office}>
                  <ConnectOnboarding onExit={() => sync.mutate()} />
                </ConnectEmbed>
              </div>
            </SectionCard>
          )}
        </>
      )}
    </div>
  );
}

function Flag({ label, on }: { label: string; on: boolean }) {
  return (
    <div>
      <p className={PANEL_LABEL}>{label}</p>
      <StatusPill tone={on ? 'good' : 'warn'}>{on ? 'Enabled' : 'Not ready'}</StatusPill>
    </div>
  );
}

function Dashboard() {
  return (
    <Boundary demo={<DashboardView status={null} data={DEMO_DASHBOARD} demo />}>
      {(status) => <DashboardQuery status={status} />}
    </Boundary>
  );
}
function DashboardQuery({ status }: { status: OfficeBillingStatus }) {
  const params = new URLSearchParams(useSearch());
  const query = useOfficeDashboard({ from: params.get('from') ?? undefined, to: params.get('to') ?? undefined });
  if (query.isPending)
    return (
      <div className={PAGE}>
        <p className="text-xs text-muted-foreground">Loading dashboard…</p>
      </div>
    );
  if (query.isError || !query.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return <DashboardView status={status} data={query.data} />;
}
function DashboardView({
  status,
  data,
  demo = false,
}: {
  status: OfficeBillingStatus | null;
  data: typeof DEMO_DASHBOARD;
  demo?: boolean;
}) {
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  const changeRange = (key: 'from' | 'to', value: string) => {
    value ? params.set(key, value) : params.delete(key);
    navigate(`/?${params}`);
  };
  const max = Math.max(...data.series.map((point) => point.collected_cents), 1);
  return (
    <div className={PAGE}>
      <Header
        title="Payments"
        sub="Balances, sales, fees, and payouts for your office."
        sandbox={status?.sandbox ?? demo}
      />
      {demo && <DemoNotice />}
      {!demo && (
        <div className="flex gap-3">
          <label>
            <span className={PANEL_LABEL}>From</span>
            <input
              type="date"
              className={`${INPUT_CLASS} ml-2 h-9`}
              value={params.get('from') ?? ''}
              onChange={(e) => changeRange('from', e.target.value)}
            />
          </label>
          <label>
            <span className={PANEL_LABEL}>To</span>
            <input
              type="date"
              className={`${INPUT_CLASS} ml-2 h-9`}
              value={params.get('to') ?? ''}
              onChange={(e) => changeRange('to', e.target.value)}
            />
          </label>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Available"
          value={formatCents(data.balance.available_cents)}
          detail={`${formatCents(data.balance.pending_cents)} pending`}
        />
        <MetricTile label="Collected" value={formatCents(data.collected_cents)} detail={`${data.orders} orders`} />
        <MetricTile label="THINNR fees" value={formatCents(data.thinnr_fee_cents)} />
        <MetricTile
          label="Office net"
          value={formatCents(data.net_cents)}
          detail={`${formatCents(data.stripe_fee_cents)} Stripe fees`}
        />
        <MetricTile label="Active subscriptions" value={data.active_subscriptions} />
        <MetricTile label="To ship" value={data.to_ship} />
        <MetricTile label="Refunded" value={formatCents(data.refunded_cents)} />
        <MetricTile
          label="Next payout"
          value={data.next_payout ? formatCents(data.next_payout.amount_cents) : '—'}
          detail={data.next_payout ? formatDate(data.next_payout.arrival_date) : 'Not scheduled'}
        />
      </div>
      <SectionCard title="Collected and net" sub="Daily totals in the selected period.">
        <div className="flex h-48 items-end gap-3 p-5" role="img" aria-label="Collected and net payment trend">
          {data.series.map((point) => (
            <div
              key={point.date}
              className="flex h-full flex-1 items-end gap-1"
              title={`${formatDate(point.date)}: ${formatCents(point.collected_cents)} collected`}
            >
              <span
                className="w-1/2 rounded-t-sm bg-accent"
                style={{ height: `${(point.collected_cents / max) * 100}%` }}
              />
              <span className="w-1/2 rounded-t-sm bg-primary" style={{ height: `${(point.net_cents / max) * 100}%` }} />
            </div>
          ))}
        </div>
      </SectionCard>
      <div className="grid gap-3 sm:grid-cols-3">
        <Quick href="/transactions" label="View transactions" />
        <Quick href="/links" label="Payment links" />
        <Quick href="/payouts" label="Payouts" />
      </div>
    </div>
  );
}
function Quick({ href, label }: { href: string; label: string }) {
  return (
    <div className="relative rounded-lg border border-card-border bg-card p-4 shadow-soft has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-ring">
      <Link
        href={href}
        className="font-serif font-bold text-navy after:absolute after:inset-0 focus-visible:outline-none"
      >
        {label}
      </Link>
      <ArrowRight className="mt-3 text-primary" size={16} aria-hidden="true" />
    </div>
  );
}

function Prices() {
  return (
    <Boundary demo={demoPage('Products and prices', <PricesTable products={DEMO_PRICES} demo />)}>
      {(status) => <PricesQuery status={status} />}
    </Boundary>
  );
}
function PricesQuery({ status }: { status: OfficeBillingStatus }) {
  const query = useOfficePrices();
  if (query.isPending) return <div className={PAGE}>Loading prices…</div>;
  if (query.isError || !query.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <div className={PAGE}>
      <Header
        title="Products and prices"
        sub="Choose what your office offers and set each patient price."
        sandbox={status.sandbox}
      />
      <PricesTable products={query.data.products} />
    </div>
  );
}
function PricesTable({ products, demo = false }: { products: OfficePrice[]; demo?: boolean }) {
  return (
    <SectionCard title="Catalog" sub="Subscriptions renew every 4 weeks.">
      <div className="divide-y divide-border">
        {products.map((product) => (
          <PriceRow key={product.product_id} product={product} demo={demo} />
        ))}
      </div>
    </SectionCard>
  );
}
function PriceRow({ product, demo }: { product: OfficePrice; demo: boolean }) {
  const mutation = useUpdateOfficePrice();
  const { toast } = useToast();
  const [offered, setOffered] = useState(product.offered);
  const [subscription, setSubscription] = useState(product.subscription_enabled);
  const [price, setPrice] = useState(centsToDollarsInput(product.sell_price_cents));
  const [error, setError] = useState('');
  useEffect(() => {
    setOffered(product.offered);
    setSubscription(product.subscription_enabled);
    setPrice(centsToDollarsInput(product.sell_price_cents));
  }, [product]);
  const save = () => {
    let cents: number | null = null;
    if (offered) {
      const parsed = parseDollarsToCents(price);
      if (!parsed.ok) return setError(parsed.error);
      if (parsed.cents < product.break_even_minimum_cents)
        return setError(`Price must be at least ${formatCents(product.break_even_minimum_cents)}.`);
      cents = parsed.cents;
    }
    setError('');
    mutation.mutate(
      { productId: product.product_id, sell_price_cents: cents, subscription_enabled: offered && subscription },
      {
        onSuccess: (result) => {
          if ((result as unknown as { stripe_mirror?: string }).stripe_mirror === 'failed')
            toast({ variant: 'destructive', title: 'Price saved, but Stripe could not be updated' });
          else toast({ variant: 'success', title: `${product.name} saved` });
        },
        onError: (failure) => setError(failure instanceof Error ? failure.message : 'Price could not be saved.'),
      },
    );
  };
  return (
    <div
      className={`grid gap-3 p-5 lg:grid-cols-[1.5fr_1fr_1fr_1.2fr_auto_auto_auto] lg:items-end ${product.below_minimum ? 'bg-warn-bg' : ''}`}
      data-testid={`price-row-${product.product_id}`}
    >
      <div>
        <b className="text-sm text-navy">{product.name}</b>
        {product.below_minimum && <span className={`${CHIP_WARM} ml-2`}>Below minimum</span>}
      </div>
      <LabelValue label="Floor" value={formatCents(product.floor_price_cents)} />
      <LabelValue label="Minimum" value={formatCents(product.break_even_minimum_cents)} />
      <label>
        <span className={PANEL_LABEL}>Sell price</span>
        <input
          data-testid={`input-price-${product.product_id}`}
          className={`${INPUT_CLASS} mt-1 h-9 w-full`}
          value={price}
          disabled={!offered || demo}
          onChange={(e) => setPrice(e.target.value)}
          aria-invalid={Boolean(error)}
        />
      </label>
      <Check label="Offered" checked={offered} disabled={demo} onChange={setOffered} />
      <Check
        label="4-week subscription"
        checked={subscription}
        disabled={!offered || demo}
        onChange={setSubscription}
      />
      <button
        data-testid={`button-save-price-${product.product_id}`}
        type="button"
        className={`${BTN_PRIMARY} h-9 px-3`}
        disabled={demo || mutation.isPending}
        onClick={save}
      >
        Save
      </button>
      {error && (
        <p role="alert" className="text-xs text-destructive lg:col-span-full">
          {error}
        </p>
      )}
    </div>
  );
}
function LabelValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={PANEL_LABEL}>{label}</p>
      <p className="mt-1 text-xs">{value}</p>
    </div>
  );
}
function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function LinksPage() {
  return (
    <Boundary demo={demoPage('Payment links', <LinksView status={null} links={DEMO_LINKS} demo />)}>
      {(status) => <LinksQuery status={status} />}
    </Boundary>
  );
}
function LinksQuery({ status }: { status: OfficeBillingStatus }) {
  const query = useOfficeLinks();
  if (query.isPending) return <div className={PAGE}>Loading links…</div>;
  if (query.isError || !query.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return <LinksView status={status} links={query.data.items} />;
}
function LinksView({
  status,
  links,
  demo = false,
}: {
  status: OfficeBillingStatus | null;
  links: PaymentLink[];
  demo?: boolean;
}) {
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [patients, setPatients] = useState<Array<{ id: string; name: string; email: string | null }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (demo || q.trim().length < 2) {
      setPatients([]);
      return;
    }
    const timer = setTimeout(() => {
      officeBilling.searchPatients(q.trim(), office).then(
        (r) => setPatients(r.items),
        () => setPatients([]),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [q, office, demo]);
  const create = useMutation({
    mutationFn: (patient_id: string | null) => officeBilling.createLink({ patient_id }, office),
    onSuccess: (r) => {
      void invalidate();
      void copy(r.link.url);
    },
    onError: (e) =>
      toast({
        variant: 'destructive',
        title: 'Link not created',
        description: e instanceof Error ? e.message : 'Try again.',
      }),
  });
  const deactivate = useMutation({
    mutationFn: (id: string) => officeBilling.deactivateLink(id, office),
    onSuccess: () => void invalidate(),
  });
  const copy = async (text: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      document.body.appendChild(input);
      input.select();
      ok = document.execCommand('copy');
      input.remove();
    }
    toast({ variant: ok ? 'success' : 'destructive', title: ok ? 'Link copied' : 'Copy the link manually' });
  };
  const generic = links.find((link) => !link.patient_id && link.active);
  return (
    <div className={demo ? '' : PAGE}>
      {!demo && (
        <Header
          title="Payment links"
          sub="Share an office link or create a link locked to one patient."
          sandbox={status?.sandbox}
        />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Office payment link">
          <div className="p-5">
            {generic ? (
              <>
                <p className="break-all text-xs">{generic.url}</p>
                <button className={`${BTN_SECONDARY} mt-3 h-9 px-3`} onClick={() => void copy(generic.url)}>
                  <Copy size={13} /> Copy link
                </button>
              </>
            ) : (
              <button className={`${BTN_PRIMARY} h-9 px-3`} disabled={demo} onClick={() => create.mutate(null)}>
                Create office link
              </button>
            )}
          </div>
        </SectionCard>
        <SectionCard title="Patient payment link" sub="Search, choose a patient, then create their private link.">
          <div className="p-5">
            <input
              data-testid="input-patient-search"
              className={`${INPUT_CLASS} h-9 w-full`}
              value={q}
              disabled={demo}
              placeholder="Search patients"
              onChange={(e) => setQ(e.target.value)}
            />
            {patients.map((patient) => (
              <button
                data-testid={`patient-result-${patient.id}`}
                key={patient.id}
                className={`mt-2 block w-full rounded-md border p-2 text-left text-xs ${selected === patient.id ? 'border-primary bg-accent' : 'border-border'}`}
                onClick={() => setSelected(patient.id)}
              >
                {patient.name}
                <span className="ml-2 text-muted-foreground">{patient.email}</span>
              </button>
            ))}
            <button
              data-testid="button-create-patient-link"
              className={`${BTN_PRIMARY} mt-3 h-9 px-3`}
              disabled={!selected || create.isPending || demo}
              onClick={() => selected && create.mutate(selected)}
            >
              Create and copy
            </button>
          </div>
        </SectionCard>
      </div>
      <SectionCard title="Links">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="p-4">Link</th>
                <th>Uses</th>
                <th>Last used</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id} className="border-b last:border-0">
                  <td className="p-4">{link.patient_name ?? link.label ?? 'Office link'}</td>
                  <td>{link.uses}</td>
                  <td>{formatDateTime(link.last_used_at)}</td>
                  <td className="p-4 text-right">
                    {link.active && (
                      <button
                        className={BTN_SECONDARY}
                        disabled={demo}
                        onClick={() => {
                          if (window.confirm('Deactivate this payment link?')) deactivate.mutate(link.id);
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}

function Transactions() {
  return (
    <Boundary demo={demoPage('Transactions', <OrdersTable rows={DEMO_ORDERS} demo />)}>
      {(status) => <TransactionsQuery status={status} />}
    </Boundary>
  );
}
function TransactionsQuery({ status }: { status: OfficeBillingStatus }) {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const [, navigate] = useLocation();
  const filters = {
    status: params.get('status'),
    fulfillment: params.get('fulfillment'),
    q: params.get('q'),
    from: params.get('from'),
    to: params.get('to'),
  };
  const query = useOfficeOrders(filters);
  const set = (key: string, value: string) => {
    value ? params.set(key, value) : params.delete(key);
    navigate(`/transactions?${params}`);
  };
  return (
    <div className={PAGE}>
      <Header title="Transactions" sub="Orders and refunds for your office." sandbox={status.sandbox} />
      <div className="flex flex-wrap gap-2">
        <input
          className={`${INPUT_CLASS} h-9`}
          placeholder="Search"
          value={params.get('q') ?? ''}
          onChange={(e) => set('q', e.target.value)}
        />
        <select
          className={`${INPUT_CLASS} h-9`}
          value={params.get('status') ?? ''}
          onChange={(e) => set('status', e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="paid">Paid</option>
          <option value="pending">Pending</option>
          <option value="refunded">Refunded</option>
        </select>
        <input
          type="date"
          className={`${INPUT_CLASS} h-9`}
          value={params.get('from') ?? ''}
          onChange={(e) => set('from', e.target.value)}
        />
        <input
          type="date"
          className={`${INPUT_CLASS} h-9`}
          value={params.get('to') ?? ''}
          onChange={(e) => set('to', e.target.value)}
        />
      </div>
      {query.isPending ? (
        <p>Loading transactions…</p>
      ) : query.isError ? (
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      ) : (
        <OrdersTable rows={query.data?.items ?? []} />
      )}
    </div>
  );
}
function OrdersTable({ rows, demo = false }: { rows: OrderSummary[]; demo?: boolean }) {
  const [, navigate] = useLocation();
  if (!rows.length)
    return (
      <SectionCard title="Transactions">
        <p className="p-5 text-xs text-muted-foreground">No transactions match these filters.</p>
      </SectionCard>
    );
  return (
    <SectionCard title="Transactions">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead>
            <tr className="border-b">
              <th className="p-4">Order</th>
              <th>Patient</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Fulfillment</th>
              <th>Total</th>
              <th>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="cursor-pointer border-b last:border-0 hover:bg-accent/40"
                onClick={(event) => {
                  if (
                    !event.defaultPrevented &&
                    !event.metaKey &&
                    !event.ctrlKey &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !(event.target as HTMLElement).closest('a,button,input,select,textarea') &&
                    !window.getSelection()?.toString()
                  )
                    navigate(`/transactions/${row.id}`);
                }}
              >
                <td className="p-4 font-semibold">{row.order_number}</td>
                <td>{row.payer.name}</td>
                <td>{ORDER_KIND_LABEL[row.kind]}</td>
                <td>
                  <StatusPill tone={orderStatusTone(row.status)}>{ORDER_STATUS_LABEL[row.status]}</StatusPill>
                </td>
                <td>
                  <StatusPill tone={fulfillmentTone(row.fulfillment_status)}>
                    {FULFILLMENT_LABEL[row.fulfillment_status]}
                  </StatusPill>
                </td>
                <td>
                  <MoneyCell cents={row.total_cents} />
                </td>
                <td className="p-4">
                  <Link aria-label={`Open order ${row.order_number}`} href={`/transactions/${row.id}`}>
                    <ArrowRight size={15} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

function TransactionDetail({ orderId }: { orderId: string }) {
  return (
    <Boundary demo={<DemoTransactionDetail orderId={orderId} />}>
      {(status) => <DetailQuery status={status} orderId={orderId} />}
    </Boundary>
  );
}

function DemoTransactionDetail({ orderId }: { orderId: string }) {
  const order = DEMO_ORDER_DETAILS[orderId];
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundNudge, setRefundNudge] = useState<string | null>(null);
  if (!order) {
    return (
      <div className={PAGE}>
        <Link className="text-xs font-semibold text-primary hover:underline" href="/transactions">Back to transactions</Link>
        <Header title="Transaction not found" sub="This transaction is not part of the guided demo." sandbox />
        <DemoNotice />
      </div>
    );
  }
  return (
    <DetailView
      order={order}
      sandbox
      demo
      refundOpen={refundOpen}
      setRefundOpen={(open) => {
        setRefundOpen(open);
        if (!open) setRefundNudge(null);
      }}
      onRefund={() => setRefundNudge('Refunds are read-only in the guided demo. Sign in to manage a live order.')}
      refundPending={false}
      refundError={refundNudge}
    />
  );
}

function DetailQuery({ status, orderId }: { status: OfficeBillingStatus; orderId: string }) {
  const query = useOfficeOrder(orderId);
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const [refundOpen, setRefundOpen] = useState(false);
  const refund = useMutation({
    mutationFn: ({ amount, reason }: { amount: number | undefined; reason: string }) =>
      officeBilling.refund(orderId, { amount_cents: amount, reason }, office),
    onSuccess: () => {
      setRefundOpen(false);
      void invalidate();
    },
  });
  if (query.isPending) return <div className={PAGE}>Loading transaction…</div>;
  if (query.isError || !query.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  const order = query.data;
  return (
    <DetailView
      order={order}
      sandbox={status.sandbox}
      refundOpen={refundOpen}
      setRefundOpen={setRefundOpen}
      onRefund={(amount, reason) => refund.mutate({ amount, reason })}
      refundPending={refund.isPending}
      refundError={refund.error instanceof Error ? refund.error.message : null}
    />
  );
}

function DetailView({
  order,
  sandbox,
  demo = false,
  refundOpen,
  setRefundOpen,
  onRefund,
  refundPending,
  refundError,
}: {
  order: OrderDetail;
  sandbox: boolean;
  demo?: boolean;
  refundOpen: boolean;
  setRefundOpen: (open: boolean) => void;
  onRefund: (amount: number | undefined, reason: string) => void;
  refundPending: boolean;
  refundError: string | null;
}) {
  return (
    <div className={PAGE}>
      <Link className="inline-flex text-xs font-semibold text-primary hover:underline" href="/transactions">
        Back to transactions
      </Link>
      <Header
        title={order.order_number}
        sub={`${order.payer.name} · ${formatDateTime(order.created_at)}`}
        sandbox={sandbox}
        action={
          <button className={`${BTN_SECONDARY} h-9 px-3 text-destructive`} onClick={() => setRefundOpen(true)}>
            Refund
          </button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Items">
          <div className="divide-y">
            {order.items.map((item) => (
              <div className="flex justify-between p-4 text-xs" key={item.id}>
                <span>
                  {item.product_name} × {item.quantity}
                </span>
                <MoneyCell cents={item.unit_price_cents * item.quantity} />
              </div>
            ))}
          </div>
        </SectionCard>
        <SectionCard title="Fees and office net">
          <div className="p-5">
            <FeeBreakdown fees={order.fees} perspective="office" />
          </div>
        </SectionCard>
        <SectionCard title="Shipping">
          <div className="p-5 text-xs leading-relaxed">
            {formatAddress(order.shipping_address).map((line) => (
              <div key={line}>{line}</div>
            ))}
            <div className="mt-4">
              <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>
                {FULFILLMENT_LABEL[order.fulfillment_status]}
              </StatusPill>
              {order.tracking_number && (
                <p className="mt-2">
                  {order.carrier} {order.tracking_number}
                </p>
              )}
            </div>
          </div>
        </SectionCard>
        <SectionCard title="Payment">
          <div className="p-5">
            <DetailList
              items={[
                { label: 'Status', value: ORDER_STATUS_LABEL[order.status] },
                { label: 'Stripe invoice', value: order.stripe.invoice_id ?? '—' },
                { label: 'Payment intent', value: order.stripe.payment_intent_id ?? '—' },
              ]}
            />
          </div>
        </SectionCard>
      </div>
      {(order.refunds.length > 0 || order.disputes.length > 0) && (
        <SectionCard title="Refunds and disputes">
          <div className="divide-y">
            {order.refunds.map((row) => (
              <p className="p-4 text-xs" key={row.id}>
                Refund {formatCents(row.amount_cents)} · {row.reason ?? 'No reason supplied'}
              </p>
            ))}
            {order.disputes.map((row) => (
              <p className="p-4 text-xs" key={row.id}>
                Dispute {formatCents(row.amount_cents)} · {row.status}
              </p>
            ))}
          </div>
        </SectionCard>
      )}
      {order.ledger.length > 0 && (
        <SectionCard title="Timeline">
          <div className="divide-y divide-border">
            {order.ledger.map((line) => (
              <div className="flex items-center justify-between gap-4 p-4 text-xs" key={line.id}>
                <div>
                  <p className="font-semibold capitalize text-foreground">{line.kind.replace(/_/g, ' ')}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{formatDateTime(line.occurred_at)}</p>
                </div>
                <MoneyCell cents={line.amount_cents} signed />
              </div>
            ))}
          </div>
        </SectionCard>
      )}
      {demo && <DemoNotice />}
      {demo ? (
        <DemoRefundDialog
          order={order}
          open={refundOpen}
          onOpenChange={setRefundOpen}
          onConfirm={() => onRefund(undefined, 'Guided demo refund')}
          error={refundError}
        />
      ) : (
        <RefundDialog
          order={order}
          open={refundOpen}
          onOpenChange={setRefundOpen}
          onConfirm={onRefund}
          pending={refundPending}
          error={refundError}
        />
      )}
    </div>
  );
}

function DemoRefundDialog({
  order,
  open,
  onOpenChange,
  onConfirm,
  error,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  error: string | null;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`Refund ${order.order_number}`}>
      <div className="w-full max-w-md rounded-lg border border-card-border bg-card p-5 shadow-lifted">
        <h2 className="font-serif text-lg font-bold text-navy">Refund {order.order_number}</h2>
        <p className="mt-2 text-xs text-muted-foreground">This guided example shows where a live office can issue a refund.</p>
        {error && <p className="mt-4 text-xs text-primary" role="status">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className={`${BTN_SECONDARY} h-9 px-3`} type="button" onClick={() => onOpenChange(false)}>Close</button>
          <button className={`${BTN_PRIMARY} h-9 px-3`} type="button" onClick={onConfirm}>Confirm refund</button>
        </div>
      </div>
    </div>
  );
}

function SubscriptionsPage() {
  return (
    <Boundary
      demo={demoPage('Product subscriptions', <SubscriptionsView status={null} items={DEMO_SUBSCRIPTIONS} demo />)}
    >
      {(status) => <SubscriptionsQuery status={status} />}
    </Boundary>
  );
}
function SubscriptionsQuery({ status }: { status: OfficeBillingStatus }) {
  const params = new URLSearchParams(useSearch());
  const query = useOfficeSubscriptions({ status: params.get('status') });
  if (query.isPending) return <div className={PAGE}>Loading subscriptions…</div>;
  if (query.isError)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return <SubscriptionsView status={status} items={query.data?.items ?? []} />;
}
function SubscriptionsView({
  status,
  items,
  demo = false,
}: {
  status: OfficeBillingStatus | null;
  items: typeof DEMO_SUBSCRIPTIONS;
  demo?: boolean;
}) {
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const [canceling, setCanceling] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: ({ id, later }: { id: string; later: boolean }) =>
      officeBilling.cancelSubscription(id, { at_period_end: later }, office),
    onSuccess: () => {
      setCanceling(null);
      void invalidate();
    },
  });
  return (
    <div className={demo ? '' : PAGE}>
      {!demo && (
        <Header title="Product subscriptions" sub="Products that renew every 4 weeks." sandbox={status?.sandbox} />
      )}
      <SectionCard title="Subscriptions">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="p-4">Patient</th>
                <th>Product</th>
                <th>Status</th>
                <th>Next renewal</th>
                <th>Price</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr className="border-b last:border-0" key={row.id}>
                  <td className="p-4">{row.payer.name}</td>
                  <td>{row.product_name}</td>
                  <td>
                    <StatusPill tone={subscriptionTone(row.status)}>{SUBSCRIPTION_STATUS_LABEL[row.status]}</StatusPill>
                  </td>
                  <td>
                    {row.cancel_at_period_end && row.status !== 'canceled'
                      ? `Ends ${formatDate(row.current_period_end)}`
                      : formatDate(row.current_period_end)}
                  </td>
                  <td>
                    <MoneyCell cents={row.unit_price_cents + row.shipping_charge_cents} />
                  </td>
                  <td className="p-4 text-right">
                    {row.status !== 'canceled' && !row.cancel_at_period_end && (
                      <button className={BTN_SECONDARY} disabled={demo} onClick={() => setCanceling(row.id)}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && <p className="p-5 text-xs text-muted-foreground">No subscriptions match this status.</p>}
        </div>
      </SectionCard>
      {canceling && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/30">
          <div className="w-full max-w-sm rounded-lg bg-card p-5 shadow-lifted">
            <h2 className="font-serif text-lg font-bold text-navy">Cancel subscription</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Choose whether access ends now or after the current 4-week period.
            </p>
            <div className="mt-5 flex gap-2">
              <button className={BTN_SECONDARY} onClick={() => setCanceling(null)}>
                Keep active
              </button>
              <button className={BTN_SECONDARY} onClick={() => cancel.mutate({ id: canceling, later: true })}>
                At period end
              </button>
              <button className={BTN_PRIMARY} onClick={() => cancel.mutate({ id: canceling, later: false })}>
                Cancel now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PayoutsPage() {
  return (
    <Boundary
      demo={demoPage(
        'Payouts',
        <p className="text-xs text-muted-foreground">
          Available balance {formatCents(DEMO_DASHBOARD.balance.available_cents)}. No demo payouts are pending.
        </p>,
      )}
    >
      {(status) => <PayoutsQuery status={status} />}
    </Boundary>
  );
}
function PayoutsQuery({ status }: { status: OfficeBillingStatus }) {
  const query = useOfficePayouts();
  if (query.isPending) return <div className={PAGE}>Loading payouts…</div>;
  if (query.isError || !query.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <div className={PAGE}>
      <Header title="Payouts" sub="Money Stripe has sent or is preparing for your bank." sandbox={status.sandbox} />
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricTile label="Available balance" value={formatCents(query.data.balance.available_cents)} />
        <MetricTile label="Pending balance" value={formatCents(query.data.balance.pending_cents)} />
      </div>
      <SectionCard title="Payout history">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="p-4">Amount</th>
                <th>Arrival</th>
                <th>Status</th>
                <th>Method</th>
              </tr>
            </thead>
            <tbody>
              {query.data.items.map((row) => (
                <tr className="border-b last:border-0" key={row.id}>
                  <td className="p-4">
                    <MoneyCell cents={row.amount_cents} />
                  </td>
                  <td>{formatDate(row.arrival_date)}</td>
                  <td>{row.status}</td>
                  <td>{row.method ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!query.data.items.length && <p className="p-5 text-xs text-muted-foreground">No payout history yet.</p>}
        </div>
      </SectionCard>
    </div>
  );
}

const SETTINGS_TABS = ['bank', 'identity', 'tax', 'documents'] as const;
function SettingsPage() {
  return (
    <Boundary
      demo={demoPage(
        'Payment settings',
        <p className="text-xs text-muted-foreground">Secure Stripe settings are available after sign in.</p>,
      )}
    >
      {(status) => <SettingsView status={status} />}
    </Boundary>
  );
}
function SettingsView({ status }: { status: OfficeBillingStatus }) {
  const { office } = useOfficeBillingScope();
  const search = new URLSearchParams(useSearch());
  const [, navigate] = useLocation();
  const raw = search.get('tab');
  const tab = SETTINGS_TABS.includes(raw as (typeof SETTINGS_TABS)[number])
    ? (raw as (typeof SETTINGS_TABS)[number])
    : 'bank';
  const select = (next: string) => navigate(`/settings?tab=${next}`);
  return (
    <div className={PAGE}>
      <Header
        title="Payment settings"
        sub="Manage sensitive payment details securely through Stripe."
        sandbox={status.sandbox}
      />
      <div className="flex flex-wrap gap-2" role="tablist">
        {SETTINGS_TABS.map((key) => (
          <button
            role="tab"
            aria-selected={tab === key}
            className={`${tab === key ? BTN_PRIMARY : BTN_SECONDARY} h-9 px-3`}
            onClick={() => select(key)}
            key={key}
          >
            {key === 'bank'
              ? 'Bank and payouts'
              : key === 'identity'
                ? 'Identity and business'
                : key === 'tax'
                  ? 'Sales tax'
                  : 'Documents'}
          </button>
        ))}
      </div>
      <SectionCard
        title={
          tab === 'bank'
            ? 'Bank and payouts'
            : tab === 'identity'
              ? 'Identity and business'
              : tab === 'tax'
                ? 'Sales tax'
                : 'Documents'
        }
      >
        {tab === 'tax' && (
          <p className="px-5 pt-5 text-xs leading-relaxed text-muted-foreground">
            Sales tax is your office’s responsibility. Stripe Tax pricing applies directly to your connected account.
          </p>
        )}
        <div className="p-5">
          {tab === 'bank' && (
            <ConnectEmbed components={['payouts']} office={office}>
              <ConnectPayouts />
            </ConnectEmbed>
          )}
          {tab === 'identity' && (
            <ConnectEmbed components={['account_management']} office={office}>
              <ConnectAccountManagement />
            </ConnectEmbed>
          )}
          {tab === 'tax' && (
            <div className="space-y-6">
              <ConnectEmbed components={['tax_settings']} office={office}>
                <ConnectTaxSettings />
              </ConnectEmbed>
              <ConnectEmbed components={['tax_registrations']} office={office}>
                <ConnectTaxRegistrations />
              </ConnectEmbed>
            </div>
          )}
          {tab === 'documents' && (
            <ConnectEmbed components={['documents']} office={office}>
              <ConnectDocuments />
            </ConnectEmbed>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

export default function OfficePaymentsArea() {
  return (
    <Switch>
      <Route path="/get-paid" component={GetPaid} />
      <Route path="/" component={Dashboard} />
      <Route path="/transactions/:orderId">{(params) => <TransactionDetail orderId={params.orderId} />}</Route>
      <Route path="/transactions" component={Transactions} />
      <Route path="/prices" component={Prices} />
      <Route path="/links" component={LinksPage} />
      <Route path="/subscriptions" component={SubscriptionsPage} />
      <Route path="/payouts" component={PayoutsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}
