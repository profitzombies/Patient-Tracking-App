import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, useSearch } from 'wouter';
import { ArrowRight, Copy, ExternalLink, MoreHorizontal, Package } from 'lucide-react';
import { useLaunchData } from '@/hooks/use-launch';
import { MoneyInput, normalizeDollarsInput } from '@/components/billing/MoneyInput';
import { MetricTile } from '@/components/admin/primitives';
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
import { RefreshControl } from '@/components/billing/RefreshControl';
import { CustomerEmailsCard } from '@/components/billing/CustomerEmailsCard';
import { demoEmailDatasetForOrder } from '@/components/billing/customer-emails-demo';
import { StripeCustomerEmailsFlag, StripeCustomerEmailsNotice } from '@/components/billing/StripeCustomerEmails';
import { CancelSubscriptionDialog } from '@/components/billing/CancelSubscriptionDialog';
import { SellToPatientDialog } from '@/components/billing/SellToPatientDialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useHqCanManageEmails,
  useInvalidateOfficeBilling,
  useOfficeBillingScope,
  useOfficeLinks,
  useOfficeOrder,
  useOfficeOrders,
  useOfficePayouts,
  useOfficePrices,
  useOfficeShippingSettings,
  useOfficeSubscriptions,
  useUpdateOfficePrice,
  useUpdateOfficeShippingSettings,
} from '@/hooks/use-billing';
import { useToast } from '@/hooks/use-toast';
import { BillingApiError, officeBilling } from '@/lib/billing-api';
import {
  accountStatusLabel,
  centsToDollarsInput,
  formatCents,
  formatDate,
  formatDateTime,
  formatDeliveryWindow,
  fulfillmentTone,
  deliveredLabel,
  warehouseFeedDetail,
  FULFILLMENT_LABEL,
  humanizeRequirement,
  ORDER_KIND_LABEL,
  ORDER_STATUS_LABEL,
  orderStatusTone,
  parseDollarsToCents,
  SUBSCRIPTION_STATUS_LABEL,
  subscriptionTone,
  cadenceSummary,
} from '@/lib/billing-format';
import type { OfficeBillingStatus, OfficePrice, OfficeShippingSettings, OrderDetail, OrderSummary, PaymentLink, PaymentLinkInput, PaymentLinkUpdate, SubscriptionChangeQuote, SubscriptionRow } from '@/lib/billing-types';
import { DEMO_DASHBOARD, DEMO_LINKS, DEMO_ORDER_DETAILS, DEMO_ORDERS, DEMO_PRICES, DEMO_SUBSCRIPTIONS } from './demo-data';
import NotFound from '@/pages/not-found';
import PaymentMethods from '@/pages/PaymentMethods';

import { Boundary, DemoNotice, demoPage, ErrorBox, Header, PAGE } from './shared';
import { OfficeOverview } from './OfficeOverview';
import { OfficeActivity, OfficeFulfillment, OfficeRefunds } from './OfficeStatusPages';

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
  const launchQuery = useLaunchData();
  const scope = launchQuery.data?.billingScope ?? '';
  const create = useMutation({
    mutationFn: () => officeBilling.createAccount(scope, office),
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
      window.location.assign((await officeBilling.oauthStart(scope, office)).url);
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
        tabs={Boolean(account)}
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
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
              <Flag label="Charges" on={account.charges_enabled} />
              <Flag label="Payouts" on={account.payouts_enabled} />
              <Flag label="Details submitted" on={account.details_submitted} />
              <StripeCustomerEmailsFlag account={account} />
            </div>
            {account.stripe_customer_emails !== 'off' && (
              <div className="px-5 pb-5">
                <StripeCustomerEmailsNotice account={account} />
              </div>
            )}
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
// Fixed widths for the chip columns: `auto` would size each grid (header vs
// each row) to its own content and drift the header labels off the values.
const PRICE_GRID = 'lg:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_9.5rem_6.25rem_11.25rem_5rem]';
function PricesTable({ products, demo = false }: { products: OfficePrice[]; demo?: boolean }) {
  return (
    <SectionCard
      title="Catalog"
      sub="Set your own price for each product; anything you have not priced is sold to your patients at the THINNR default (floor) price, one-time only. Subscriptions need your own price at or above the minimum."
    >
      <div className={`hidden gap-4 border-b border-border bg-secondary/50 px-5 py-2.5 lg:grid lg:items-center ${PRICE_GRID}`} aria-hidden="true">
        <span className={PANEL_LABEL}>Product</span>
        <span className={PANEL_LABEL}>Floor</span>
        <span className={PANEL_LABEL}>Minimum</span>
        <span className={PANEL_LABEL}>Sell price</span>
        <span className={PANEL_LABEL}>Own price</span>
        <span className={PANEL_LABEL}>Subscription</span>
        <span />
      </div>
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
  const toggleOffered = (next: boolean) => {
    setOffered(next);
    setError('');
    // Turning a product on with no price yet starts from the floor so the
    // field is never silently blank; staff can still type their own number.
    if (next && !price.trim()) setPrice(centsToDollarsInput(product.floor_price_cents));
  };
  const save = () => {
    let cents: number | null = null;
    if (offered) {
      const parsed = parseDollarsToCents(price);
      if (!parsed.ok)
        return setError(
          price.trim()
            ? parsed.error
            : `Enter a sell price of at least ${formatCents(product.break_even_minimum_cents)}, or uncheck Own price to sell ${product.name} at the default price.`,
        );
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
  const dirty =
    offered !== product.offered
    || (offered && subscription !== product.subscription_enabled)
    || (offered && price !== centsToDollarsInput(product.sell_price_cents));
  return (
    <div
      className={`grid gap-x-4 gap-y-3 px-5 py-4 lg:items-center ${PRICE_GRID} ${product.below_minimum ? 'bg-warn-bg' : ''}`}
      data-testid={`price-row-${product.product_id}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-secondary">
          {product.image_url ? (
            <img src={product.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <Package size={16} aria-hidden="true" className="text-muted-foreground" />
          )}
        </span>
        <div className="min-w-0">
          <b className="block text-sm text-navy">
            {product.name}
            {product.below_minimum && <span className={`${CHIP_WARM} ml-2 align-middle`}>Below minimum</span>}
          </b>
          {product.description && <p className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{product.description}</p>}
          <p className="text-[11px] text-muted-foreground" data-testid={`text-price-plan-${product.product_id}`}>
            Subscriptions {cadenceSummary(product.offered_cadences_weeks, product.default_cadence_weeks).toLowerCase()}
            {product.subscribe_save_percent > 0 && product.subscription_price_cents != null
              ? ` · subscribe and save ${product.subscribe_save_percent}% (${formatCents(product.subscription_price_cents)} per renewal)`
              : ''}
          </p>
        </div>
      </div>
      <LabelValue label="Floor" value={formatCents(product.floor_price_cents)} />
      <LabelValue label="Minimum" value={formatCents(product.break_even_minimum_cents)} />
      <label className="block">
        <span className={`${PANEL_LABEL} lg:sr-only`}>Sell price</span>
        <MoneyInput
          data-testid={`input-price-${product.product_id}`}
          className="mt-1 lg:mt-0"
          value={price}
          disabled={!offered || demo}
          aria-label={`${product.name} sell price`}
          onChange={(e) => {
            setPrice(e.target.value);
            setError('');
          }}
          onBlur={() => setPrice((current) => normalizeDollarsInput(current))}
          invalid={Boolean(error)}
        />
        {!offered && <span className="mt-1 block text-[11px] text-muted-foreground lg:hidden">Default price</span>}
      </label>
      <Check label="Own price" checked={offered} disabled={demo} onChange={toggleOffered} />
      <Check
        label="Subscription"
        checked={subscription}
        disabled={!offered || demo}
        onChange={setSubscription}
      />
      <button
        data-testid={`button-save-price-${product.product_id}`}
        type="button"
        className={`${dirty ? BTN_PRIMARY : BTN_SECONDARY} h-9 w-full px-3 lg:w-auto`}
        disabled={demo || mutation.isPending}
        onClick={save}
      >
        {mutation.isPending ? 'Saving…' : 'Save'}
      </button>
      {error && (
        <p role="alert" className="text-xs font-semibold text-destructive lg:col-span-full">
          {error}
        </p>
      )}
    </div>
  );
}
function LabelValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={`${PANEL_LABEL} lg:sr-only`}>{label}</p>
      <p className="mt-1 text-sm tabular-nums text-foreground lg:mt-0">{value}</p>
    </div>
  );
}
/** Bordered checkbox chip: reads as a control on the row instead of a bare tick box. */
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
    <label
      className={`inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-md border px-3 text-xs font-semibold transition ${
        checked && !disabled ? 'border-accent-border bg-accent text-primary' : 'border-border bg-card text-foreground'
      } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-accent/60'}`}
    >
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
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
  const prices = useOfficePrices();
  if (query.isPending || prices.isPending) return <div className={PAGE}>Loading links…</div>;
  if (query.isError || !query.data || prices.isError || !prices.data)
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return <LinksView status={status} links={query.data.items} products={prices.data.products} />;
}
function LinksView({
  status,
  links,
  products = DEMO_PRICES,
  demo = false,
}: {
  status: OfficeBillingStatus | null;
  links: PaymentLink[];
  products?: OfficePrice[];
  demo?: boolean;
}) {
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [patients, setPatients] = useState<Array<{ id: string; name: string; email: string | null }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [salePatient, setSalePatient] = useState<{ id: string; name: string } | null>(null);
  const [expiresHours, setExpiresHours] = useState('');
  const [useLimit, setUseLimit] = useState('');
  const [productId, setProductId] = useState('');
  const [editing, setEditing] = useState<PaymentLink | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editExpiry, setEditExpiry] = useState('');
  const [editMaxUses, setEditMaxUses] = useState('');
  const [editActive, setEditActive] = useState(true);
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
    mutationFn: (input: PaymentLinkInput) => officeBilling.createLink(input, office),
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
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: PaymentLinkUpdate }) => officeBilling.updateLink(id, body, office),
    onSuccess: () => {
      setEditing(null);
      void invalidate();
      toast({ variant: 'success', title: 'Link updated' });
    },
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Link not updated', description: error.message }),
  });
  const linkInput = (patient_id: string | null): PaymentLinkInput => ({
    patient_id,
    expires_in_hours: expiresHours ? Number(expiresHours) : null,
    max_uses: useLimit ? Number(useLimit) : null,
    product_id: productId || null,
  });
  const openEdit = (link: PaymentLink) => {
    setEditing(link);
    setEditLabel(link.label ?? '');
    setEditExpiry(link.expires_at ? link.expires_at.slice(0, 16) : '');
    setEditMaxUses(link.max_uses == null ? '' : String(link.max_uses));
    setEditActive(link.active);
  };
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
               <button className={`${BTN_PRIMARY} h-9 px-3`} disabled={demo} onClick={() => create.mutate(linkInput(null))}>
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
              onClick={() => selected && create.mutate(linkInput(selected))}
            >
              Create and copy
            </button>
            <button
              data-testid="button-sell-to-patient"
              className={`${BTN_SECONDARY} ml-2 mt-3 h-9 px-3`}
              disabled={!selected || demo}
              onClick={() => {
                const match = patients.find((item) => item.id === selected);
                if (match) setSalePatient({ id: match.id, name: match.name });
              }}
            >
              Sell to patient
            </button>
          </div>
       <SectionCard title="New link options" sub="These options apply to the next office or patient link you create.">
         <div className="grid gap-4 p-5 sm:grid-cols-3">
           <label className="text-xs">
             <span className={PANEL_LABEL}>Expires</span>
             <select data-testid="select-link-expiry" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={expiresHours} disabled={demo} onChange={(e) => setExpiresHours(e.target.value)}>
               <option value="">Never</option><option value="24">24 hours</option><option value="168">7 days</option><option value="720">30 days</option>
             </select>
           </label>
           <div className="text-xs">
             <span className={PANEL_LABEL}>Use limit</span>
             <label className="mt-2 flex items-center gap-2">
               <input data-testid="toggle-link-single-use" type="checkbox" checked={useLimit === '1'} disabled={demo} onChange={(e) => setUseLimit(e.target.checked ? '1' : '')} />
               Single-use
             </label>
             <label className="mt-2 block">
               Up to N uses
               <input data-testid="input-link-max-uses" type="number" min="2" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={useLimit === '1' ? '' : useLimit} disabled={demo || useLimit === '1'} onChange={(e) => setUseLimit(e.target.value)} placeholder="Unlimited" />
             </label>
           </div>
           <label className="text-xs">
             <span className={PANEL_LABEL}>Preselect a product</span>
             <select data-testid="select-link-product" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={productId} disabled={demo} onChange={(e) => setProductId(e.target.value)}>
               <option value="">Payer chooses</option>
               {products.filter((product) => product.active && product.offered && product.sell_price_cents != null).map((product) => <option key={product.product_id} value={product.product_id}>{product.name}</option>)}
             </select>
           </label>
         </div>
       </SectionCard>
        </SectionCard>
      </div>
      {salePatient ? (
        <SellToPatientDialog
          open
          onOpenChange={(next) => { if (!next) setSalePatient(null); }}
          patient={salePatient}
          office={office}
        />
      ) : null}
      <SectionCard title="Links">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="p-4">Link</th>
                <th>Uses</th>
                 <th>Expires</th>
                 <th>Product</th>
                 <th>Status</th>
                <th>Last used</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {links.map((link) => (
                <tr key={link.id} data-testid={`link-row-${link.id}`} className={`border-b last:border-0 ${!link.usable ? 'bg-secondary/40 text-muted-foreground opacity-70' : ''}`}>
                  <td className="p-4">{link.patient_name ?? link.label ?? 'Office link'}</td>
                  <td>{link.max_uses ? `${link.uses} of ${link.max_uses} used` : `${link.uses} ${link.uses === 1 ? 'use' : 'uses'}`}</td>
                  <td>{link.expires_at ? (!link.usable && !(link.max_uses != null && link.uses >= link.max_uses) ? 'Expired' : `Expires ${formatDate(link.expires_at)}`) : 'Never'}</td>
                  <td>{link.product_name ?? 'Payer chooses'}</td>
                  <td><StatusPill tone={link.usable ? 'good' : link.active ? 'warn' : 'neutral'}>{link.usable ? 'Usable' : link.active ? 'Unavailable' : 'Inactive'}</StatusPill></td>
                  <td>{formatDateTime(link.last_used_at)}</td>
                  <td className="p-4 text-right">
                    <span className="flex flex-wrap justify-end gap-1">
                      <button className={`${BTN_SECONDARY} h-8 px-3`} onClick={() => void copy(link.url)}><Copy size={12} aria-hidden="true" /> Copy link</button>
                      <button className={`${BTN_SECONDARY} h-8 px-3`} disabled={demo} onClick={() => openEdit(link)}>Edit</button>
                    {link.active && (
                      <button
                        className={`${BTN_SECONDARY} h-8 px-3`}
                        disabled={demo}
                        onClick={() => {
                          if (window.confirm('Deactivate this payment link?')) deactivate.mutate(link.id);
                        }}
                      >
                        Deactivate
                      </button>
                    )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
      <Dialog open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-serif text-navy">Edit payment link</DialogTitle><DialogDescription>Change availability and use limits for this link.</DialogDescription></DialogHeader>
          <div className="grid gap-3">
            <label className="text-xs"><span className={PANEL_LABEL}>Label</span><input data-testid="input-edit-link-label" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={editLabel} onChange={(e) => setEditLabel(e.target.value)} /></label>
            <label className="text-xs"><span className={PANEL_LABEL}>Expiry</span><input data-testid="input-edit-link-expiry" type="datetime-local" className={`${INPUT_CLASS} mt-1 h-9 w-full bg-white`} value={editExpiry} onChange={(e) => setEditExpiry(e.target.value)} /></label>
            <label className="text-xs"><span className={PANEL_LABEL}>Maximum uses</span><input data-testid="input-edit-link-max-uses" type="number" min="1" className={`${INPUT_CLASS} mt-1 h-9 w-full`} value={editMaxUses} onChange={(e) => setEditMaxUses(e.target.value)} placeholder="Unlimited" /></label>
            <Check label="Active" checked={editActive} onChange={setEditActive} />
          </div>
          <DialogFooter>
            <button className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => setEditing(null)}>Close</button>
            <button data-testid="button-save-link" className={`${BTN_PRIMARY} h-9 px-3`} disabled={update.isPending} onClick={() => editing && update.mutate({ id: editing.id, body: { label: editLabel || null, expires_at: editExpiry ? new Date(editExpiry).toISOString() : null, max_uses: editMaxUses ? Number(editMaxUses) : null, active: editActive } })}>Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Transactions() {
  return (
    <Boundary demo={demoPage('Transactions', <OrdersTable rows={DEMO_ORDERS} demo />, undefined, <RefreshControl subject="Transactions" demo />)}>
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
      <Header
        title="Transactions"
        sub="Orders and refunds for your office."
        sandbox={status.sandbox}
        action={<RefreshControl subject="Transactions" sources={[query]} />}
      />
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
      ) : query.isError && !query.data ? (
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
        <Header
          title="Transaction not found"
          sub="This transaction is not part of the guided demo."
          sandbox
          tabs={false}
          back={{ href: '/transactions', label: 'Back to transactions' }}
        />
        <DemoNotice />
      </div>
    );
  }
  return (
    <DetailView
      order={order}
      sandbox
      demo
      refresh={<RefreshControl subject="Order" demo />}
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
  // HQ drill-ins resolve as the office owner server-side, but email writes still need HQ provider-manage rights.
  const canActAsHq = useHqCanManageEmails();
  const [refundOpen, setRefundOpen] = useState(false);
  const refund = useMutation({
    mutationFn: ({ amount, reason }: { amount: number; reason: string }) =>
      officeBilling.refund(orderId, { amount_cents: amount, reason }, office),
    onSuccess: () => {
      setRefundOpen(false);
      void invalidate();
    },
  });
  if (query.isPending) return <div className={PAGE}>Loading transaction…</div>;
  if (!query.data)
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
      refresh={<RefreshControl subject="Order" sources={[query]} />}
      canManageEmails={status.viewer.can_manage && canActAsHq}
      refundOpen={refundOpen}
      setRefundOpen={(open) => {
        if (open) refund.reset();
        setRefundOpen(open);
      }}
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
  refresh,
  canManageEmails = false,
  refundOpen,
  setRefundOpen,
  onRefund,
  refundPending,
  refundError,
}: {
  order: OrderDetail;
  sandbox: boolean;
  demo?: boolean;
  refresh?: ReactNode;
  /** Whether this viewer may resend emails and edit notification contacts (office owner/admin, HQ Admin). */
  canManageEmails?: boolean;
  refundOpen: boolean;
  setRefundOpen: (open: boolean) => void;
  onRefund: (amount: number, reason: string) => void;
  refundPending: boolean;
  refundError: string | null;
}) {
  const shipping = order.fees.shipping ?? {
    shipping_method: 'standard' as const,
    shipping_source: 'fallback' as const,
    carrier_service_name: null,
    carrier_cost_cents: order.fees.shipping_charge_cents,
    pick_pack_fee_cents: 0,
    packaging_cents: 0,
    pick_pack_passed_through: false,
    delivery_window_start: null,
    delivery_window_end: null,
  };
  return (
    <div className={PAGE}>
      <Header
        title={order.order_number}
        sub={`${order.payer.name} · ${formatDateTime(order.created_at)}`}
        sandbox={sandbox}
        tabs={false}
        back={{ href: '/transactions', label: 'Back to transactions' }}
        action={
          <>
            {refresh}
            <button className={`${BTN_SECONDARY} h-9 px-3 text-destructive`} onClick={() => setRefundOpen(true)}>
              Refund
            </button>
          </>
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
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <StatusPill tone={fulfillmentTone(order.fulfillment_status)}>
                  {FULFILLMENT_LABEL[order.fulfillment_status]}
                </StatusPill>
                {deliveredLabel(order.shipment) && (
                  <StatusPill tone="good" testId="pill-office-delivered">{deliveredLabel(order.shipment)}</StatusPill>
                )}
                {order.shipment?.back_ordered && (
                  <StatusPill tone="warn" testId="pill-office-back-ordered">Back-ordered</StatusPill>
                )}
              </span>
              {order.tracking_number && (
                <p className="mt-2">
                  {order.carrier} {order.tracking_number}
                </p>
              )}
              {warehouseFeedDetail(order.shipment) && (
                <p className="mt-2 text-muted-foreground" data-testid="text-office-warehouse-feed">{warehouseFeedDetail(order.shipment)}</p>
              )}
            </div>
            <div className="mt-4 border-t border-border pt-4" data-testid="office-shipping-breakdown">
              <DetailList items={[
                { label: 'Shipping method', value: `${shipping.shipping_method === 'expedited' ? 'Expedited' : 'Standard'}${shipping.carrier_service_name ? ` · ${shipping.carrier_service_name}` : ''}` },
                { label: 'Rate', value: <StatusPill tone={shipping.shipping_source === 'live' ? 'good' : 'neutral'}>{shipping.shipping_source === 'live' ? 'Live rate' : 'Flat rate'}</StatusPill> },
                { label: 'Delivery window', value: shipping.shipping_source === 'live' ? formatDeliveryWindow(shipping.delivery_window_start, shipping.delivery_window_end) ?? '—' : '—' },
                { label: 'Carrier cost', value: formatCents(shipping.carrier_cost_cents) },
                { label: 'Pick-and-pack fee', value: formatCents(shipping.pick_pack_fee_cents) },
                { label: 'Packaging', value: formatCents(shipping.packaging_cents) },
              ]} />
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
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {formatDateTime(line.occurred_at)}
                    {line.kind === 'sale' && line.detail?.fee_pending === true ? ' · before card fees (Stripe fee not yet reported)' : ''}
                  </p>
                </div>
                <MoneyCell cents={line.amount_cents} signed />
              </div>
            ))}
          </div>
        </SectionCard>
      )}
      <CustomerEmailsCard
        area="office"
        filter={{ order_id: order.id }}
        payer={order.payer}
        canAct={canManageEmails}
        demo={demo ? demoEmailDatasetForOrder(order) : null}
        sub={`Every email sent to ${order.payer.name} about this order.`}
      />
      {demo && <DemoNotice />}
      {demo ? (
        <DemoRefundDialog
          order={order}
          open={refundOpen}
          onOpenChange={setRefundOpen}
          onConfirm={() => onRefund(0, 'Guided demo refund')}
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
      demo={demoPage(
        'Product subscriptions',
        <SubscriptionsView status={null} items={DEMO_SUBSCRIPTIONS} demo />,
        undefined,
        <RefreshControl subject="Subscriptions" demo />,
      )}
    >
      {(status) => <SubscriptionsQuery status={status} />}
    </Boundary>
  );
}
function SubscriptionsQuery({ status }: { status: OfficeBillingStatus }) {
  const params = new URLSearchParams(useSearch());
  const query = useOfficeSubscriptions({ status: params.get('status') });
  const prices = useOfficePrices();
  if (query.isPending || prices.isPending) return <div className={PAGE}>Loading subscriptions…</div>;
  if ((query.isError && !query.data) || (prices.isError && !prices.data))
    return (
      <div className={PAGE}>
        <ErrorBox error={query.error ?? prices.error} retry={() => { void query.refetch(); void prices.refetch(); }} />
      </div>
    );
  return (
    <SubscriptionsView
      status={status}
      items={query.data?.items ?? []}
      products={prices.data?.products ?? []}
      refresh={<RefreshControl subject="Subscriptions" sources={[query, prices]} />}
    />
  );
}
function SubscriptionsView({
  status,
  items,
  products = DEMO_PRICES,
  demo = false,
  refresh,
}: {
  status: OfficeBillingStatus | null;
  items: SubscriptionRow[];
  products?: OfficePrice[];
  demo?: boolean;
  refresh?: ReactNode;
}) {
  const { office } = useOfficeBillingScope();
  const invalidate = useInvalidateOfficeBilling();
  const { toast } = useToast();
  const [canceling, setCanceling] = useState<SubscriptionRow | null>(null);
  const [changing, setChanging] = useState<SubscriptionRow | null>(null);
  const [nextProduct, setNextProduct] = useState('');
  const [quote, setQuote] = useState<SubscriptionChangeQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const cancel = useMutation({
    mutationFn: ({ id, later }: { id: string; later: boolean }) =>
      officeBilling.cancelSubscription(id, { at_period_end: later }, office),
    onSuccess: (_result, variables) => {
      setCanceling(null);
      void invalidate();
      toast({ variant: 'success', title: variables.later ? 'Subscription ends at period end' : 'Subscription canceled' });
    },
  });
  const retry = useMutation({
    mutationFn: (id: string) => officeBilling.retrySubscriptionPayment(id, office),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Payment retry started' });
    },
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Payment retry failed', description: error.message }),
  });
  const resend = useMutation({
    mutationFn: (id: string) => officeBilling.resendSubscriptionPaymentEmail(id, office),
    onSuccess: () => toast({ variant: 'success', title: 'Payment link emailed' }),
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Email could not be sent', description: error.message }),
  });
  const pause = useMutation({
    mutationFn: (id: string) => officeBilling.pauseSubscription(id, office),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Subscription paused' });
    },
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Subscription not paused', description: error.message }),
  });
  const resume = useMutation({
    mutationFn: (id: string) => officeBilling.resumeSubscription(id, office),
    onSuccess: () => {
      void invalidate();
      toast({ variant: 'success', title: 'Subscription resumed' });
    },
    onError: (error: Error) => toast({ variant: 'destructive', title: 'Subscription not resumed', description: error.message }),
  });
  const change = useMutation({
    mutationFn: ({ id, productId }: { id: string; productId: string }) =>
      officeBilling.changeSubscription(id, { product_id: productId }, office),
    onSuccess: () => {
      setChanging(null);
      void invalidate();
      toast({ variant: 'success', title: 'Product change scheduled' });
    },
    onError: (error: Error) => setQuoteError(error.message),
  });
  const chooseProduct = async (productId: string) => {
    setNextProduct(productId);
    setQuote(null);
    setQuoteError('');
    if (!changing || !productId) return;
    try {
      setQuote(await officeBilling.subscriptionChangeQuote(changing.id, productId, office));
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : 'Quote could not be loaded.');
    }
  };
  const eligibleProducts = products.filter(
    (product) => product.active && product.offered && product.subscription_enabled && product.sell_price_cents != null,
  );
  return (
    <div className={demo ? '' : PAGE}>
      {!demo && (
        <Header title="Product subscriptions" sub="Products that renew every 4 weeks." sandbox={status?.sandbox} action={refresh} />
      )}
      <SectionCard title="Subscriptions">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-secondary/50">
                <th className={`${PANEL_LABEL} px-5 py-2.5`}>Patient</th>
                <th className={`${PANEL_LABEL} py-2.5 pr-4`}>Product</th>
                <th className={`${PANEL_LABEL} py-2.5 pr-4`}>Status</th>
                <th className={`${PANEL_LABEL} py-2.5 pr-4`}>Started</th>
                <th className={`${PANEL_LABEL} py-2.5 pr-4`}>Next renewal</th>
                <th className={`${PANEL_LABEL} py-2.5 pr-4 text-right`}>Renewals</th>
                <th className={`${PANEL_LABEL} py-2.5 pr-4 text-right`}>Price</th>
                <th className="px-5 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => {
                const failed = row.status === 'past_due' || row.status === 'unpaid';
                const live = row.status !== 'canceled';
                return (
                  <tr className="border-b border-border last:border-0" key={row.id} data-testid={`subscription-row-${row.id}`}>
                    <td className="px-5 py-3.5 align-top">
                      <b className="block text-navy">{row.payer.name}</b>
                      {row.payer.email && <span className="block text-[11px] text-muted-foreground">{row.payer.email}</span>}
                    </td>
                    <td className="py-3.5 pr-4 align-top">
                      {row.product_name}
                      {row.pending_change && (
                        <p className="mt-1 max-w-56 text-[11px] text-muted-foreground">
                          Changes to {row.pending_change.product_name} ({formatCents(row.pending_change.unit_price_cents)}) on {formatDate(row.pending_change.effective_at)}
                        </p>
                      )}
                    </td>
                    <td className="py-3.5 pr-4 align-top">
                      <StatusPill tone={subscriptionTone(row.status)}>{SUBSCRIPTION_STATUS_LABEL[row.status]}</StatusPill>
                      {row.paused_at && (
                        <p className="mt-1">
                          <StatusPill tone="warn">Paused</StatusPill>
                          <span className="ml-1 text-[11px] text-muted-foreground">since {formatDate(row.paused_at)}</span>
                        </p>
                      )}
                      {failed && (
                        <p className="mt-1 max-w-52 text-[11px] text-red-700">
                          Card declined {row.payment_failure_count} {row.payment_failure_count === 1 ? 'time' : 'times'}, last on {formatDate(row.last_payment_failed_at)}
                        </p>
                      )}
                    </td>
                    <td className="py-3.5 pr-4 align-top tabular-nums text-muted-foreground">{formatDate(row.created_at)}</td>
                    <td className="py-3.5 pr-4 align-top tabular-nums">
                      {row.cancel_at_period_end && live
                        ? <span className="text-red-700">Ends {formatDate(row.current_period_end)}</span>
                        : formatDate(row.current_period_end)}
                    </td>
                    <td className="py-3.5 pr-4 text-right align-top tabular-nums">{row.renewals}</td>
                    <td className="py-3.5 pr-4 text-right align-top">
                      <MoneyCell cents={row.unit_price_cents + row.shipping_charge_cents} />
                      {row.shipping_charge_cents > 0 && (
                        <span className="block text-[11px] text-muted-foreground">incl. {formatCents(row.shipping_charge_cents)} shipping</span>
                      )}
                      {row.shipping && (
                        <>
                          <span className="block text-[11px] text-muted-foreground" data-testid={`subscription-shipping-${row.id}`}>
                            {row.shipping.shipping_method === 'expedited' ? 'Expedited' : 'Standard'} · {row.shipping.shipping_source === 'live' ? 'Live' : 'Flat'}
                            {row.shipping.carrier_service_name ? ` · ${row.shipping.carrier_service_name}` : ''}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            Last re-quoted {row.shipping_requoted_at ? formatDateTime(row.shipping_requoted_at) : '—'}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right align-top">
                      {live && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              data-testid={`button-subscription-actions-${row.id}`}
                              className="inline-grid h-8 w-8 place-items-center rounded-md border border-border bg-card text-muted-foreground transition hover:bg-accent hover:text-primary"
                              aria-label={`Actions for ${row.payer.name}'s ${row.product_name} subscription`}
                            >
                              <MoreHorizontal size={16} aria-hidden="true" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-52">
                            {failed && (
                              <>
                                <DropdownMenuItem disabled={demo || retry.isPending} onSelect={() => retry.mutate(row.id)}>
                                  Retry payment
                                </DropdownMenuItem>
                                <DropdownMenuItem disabled={demo || resend.isPending} onSelect={() => resend.mutate(row.id)}>
                                  Email patient a payment link
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuItem
                              disabled={demo || pause.isPending || resume.isPending}
                              onSelect={() => (row.paused_at ? resume.mutate(row.id) : pause.mutate(row.id))}
                            >
                              {row.paused_at ? 'Resume' : 'Pause'}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              data-testid={`button-change-product-${row.id}`}
                              disabled={demo}
                              onSelect={() => {
                                setChanging(row);
                                setNextProduct('');
                                setQuote(null);
                                setQuoteError('');
                              }}
                            >
                              Change product
                            </DropdownMenuItem>
                            {!row.cancel_at_period_end && (
                              <DropdownMenuItem
                                data-testid={`button-cancel-subscription-${row.id}`}
                                className="text-destructive focus:text-destructive"
                                disabled={demo}
                                onSelect={() => {
                                  cancel.reset();
                                  setCanceling(row);
                                }}
                              >
                                Cancel subscription…
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!items.length && <p className="p-5 text-xs text-muted-foreground">No subscriptions match this status.</p>}
        </div>
      </SectionCard>
      <CancelSubscriptionDialog
        row={canceling}
        open={Boolean(canceling)}
        onOpenChange={(open) => !open && setCanceling(null)}
        onConfirm={(atPeriodEnd) => canceling && cancel.mutate({ id: canceling.id, later: atPeriodEnd })}
        pending={cancel.isPending}
        error={cancel.error instanceof Error ? cancel.error.message : null}
        demo={demo}
      />
      <Dialog open={Boolean(changing)} onOpenChange={(open) => !open && setChanging(null)}>
        <DialogContent aria-describedby="change-product-description">
          <DialogHeader>
            <DialogTitle className="font-serif text-navy">Change product</DialogTitle>
            <DialogDescription id="change-product-description">
              Choose the product this subscription should use at its next renewal.
            </DialogDescription>
          </DialogHeader>
          <label className="block text-xs">
            <span className={PANEL_LABEL}>New product</span>
            <select
              data-testid="select-change-product"
              className={`${INPUT_CLASS} mt-1 h-9 w-full`}
              value={nextProduct}
              onChange={(event) => void chooseProduct(event.target.value)}
            >
              <option value="">Choose a product…</option>
              {eligibleProducts.filter((product) => product.product_id !== changing?.product_id).map((product) => (
                <option key={product.product_id} value={product.product_id}>
                  {product.name} · {formatCents(product.sell_price_cents)}
                </option>
              ))}
            </select>
          </label>
          {nextProduct && !quote && !quoteError && <p className="text-xs text-muted-foreground">Loading quote…</p>}
          {quote && (
            <div data-testid="subscription-change-quote" className="rounded-md border border-border bg-secondary p-4 text-xs">
              <p>Current: <b>{quote.current.product_name} · {formatCents(quote.current.unit_price_cents)}</b></p>
              <p className="mt-2">Next: <b>{quote.next.product_name} · {formatCents(quote.next.unit_price_cents)}</b></p>
              <p className="mt-1">Shipping: {formatCents(quote.next.shipping_charge_cents)}</p>
              <p className="mt-2 text-muted-foreground">Takes effect at next renewal on {formatDate(quote.effective_at)}</p>
            </div>
          )}
          {quoteError && <p role="alert" className="text-xs text-destructive">{quoteError}</p>}
          <DialogFooter>
            <button type="button" className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => setChanging(null)}>Close</button>
            <button
              type="button"
              className={`${BTN_PRIMARY} h-9 px-3`}
              disabled={!quote || change.isPending}
              onClick={() => changing && nextProduct && change.mutate({ id: changing.id, productId: nextProduct })}
            >
              Confirm change
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const demoSettings: OfficeShippingSettings = {
    pick_pack_pass_through: null,
    effective_pick_pack_pass_through: false,
    hq_default_pick_pack_pass_through: false,
    version: 1,
    updated_at: null,
  };
  return (
    <Boundary
      allowReadOnly
      demo={demoPage(
        'Payment settings',
        <div className="space-y-5">
          <PickPackSettingsCard settings={demoSettings} canWrite={false} demo />
          <p className="text-xs text-muted-foreground">Secure Stripe settings are available after sign in.</p>
        </div>,
      )}
    >
      {(status) => <SettingsView status={status} />}
    </Boundary>
  );
}
function SettingsView({ status }: { status: OfficeBillingStatus }) {
  const settings = useOfficeShippingSettings();
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
      {settings.isPending ? (
        <Skeleton className="h-40" />
      ) : settings.isError || !settings.data ? (
        <ErrorBox error={settings.error} retry={() => void settings.refetch()} />
      ) : (
        <PickPackSettingsCard
          settings={settings.data}
          canWrite={status.viewer.can_manage}
          onReload={() => settings.refetch()}
        />
      )}
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

export function PickPackSettingsCard({
  settings,
  canWrite,
  demo = false,
  onReload,
}: {
  settings: OfficeShippingSettings;
  canWrite: boolean;
  demo?: boolean;
  onReload?: () => Promise<unknown>;
}) {
  const mutation = useUpdateOfficeShippingSettings();
  const { toast } = useToast();
  const [value, setValue] = useState<boolean | null>(settings.pick_pack_pass_through);
  useEffect(() => setValue(settings.pick_pack_pass_through), [settings.version, settings.pick_pack_pass_through]);
  const save = () => {
    if (demo) return;
    mutation.mutate(
      { pick_pack_pass_through: value, expected_version: settings.version },
      {
        onSuccess: () => toast({ variant: 'success', title: 'Shipping setting saved' }),
        onError: async (error) => {
          if (error instanceof BillingApiError && error.status === 409) {
            await onReload?.();
            toast({
              variant: 'destructive',
              title: 'Shipping setting reloaded',
              description: 'Someone else changed it first. Review the latest choice and try again.',
            });
            return;
          }
          toast({ variant: 'destructive', title: 'Shipping setting not saved', description: error.message });
        },
      },
    );
  };
  return (
    <SectionCard
      title="Shipping fees"
      sub="Choose whether the patient or your office covers NovEx pick-and-pack and packaging."
    >
      <fieldset className="space-y-3 p-5" data-testid="office-pick-pack-setting">
        <legend className="text-sm font-semibold text-navy">Charge patients the pick-and-pack fee</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            { key: 'inherit', value: null, label: 'Follow HQ default', detail: settings.hq_default_pick_pack_pass_through ? 'HQ default is On' : 'HQ default is Off' },
            { key: 'on', value: true, label: 'On', detail: 'Patient pays the fee' },
            { key: 'off', value: false, label: 'Off', detail: 'Your office absorbs the fee' },
          ] as const).map((option) => (
            <label key={option.key} className="flex items-start gap-2 rounded-md border border-border p-3 text-xs">
              <input
                type="radio"
                name="pick-pack-pass-through"
                data-testid={`radio-pick-pack-${option.key}`}
                checked={value === option.value}
                disabled={!canWrite}
                onChange={() => setValue(option.value)}
              />
              <span>
                <b className="block text-navy">{option.label}</b>
                <span className="text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Effective now: {settings.effective_pick_pack_pass_through ? 'patients pay the fee' : 'your office absorbs the fee'}.
        </p>
        {canWrite ? (
          <button
            type="button"
            className={`${BTN_PRIMARY} h-9 px-3.5`}
            data-testid="button-save-pick-pack-setting"
            disabled={mutation.isPending || value === settings.pick_pack_pass_through}
            onClick={save}
          >
            {mutation.isPending ? 'Saving…' : 'Save shipping setting'}
          </button>
        ) : (
          <p className="text-xs text-muted-foreground">Only office owners and admins can change this setting.</p>
        )}
      </fieldset>
    </SectionCard>
  );
}

export default function OfficePaymentsArea() {
  return (
    <Switch>
      <Route path="/get-paid" component={GetPaid} />
      <Route path="/methods" component={PaymentMethods} />
      <Route path="/" component={OfficeOverview} />
      <Route path="/activity" component={OfficeActivity} />
      <Route path="/refunds" component={OfficeRefunds} />
      <Route path="/fulfillment" component={OfficeFulfillment} />
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
