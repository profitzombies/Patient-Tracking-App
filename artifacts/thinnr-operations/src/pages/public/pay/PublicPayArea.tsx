/**
 * Public payment pages (no session): /pay/:token, /pay/:token/done,
 * /pay/cancel/:cancelToken. Mounted with `nest` at /pay ahead of the persona
 * router, like /email and /security/report. Filled in by the payments build.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Switch, useParams, useSearch } from 'wouter';
import NotFound from '@/pages/not-found';
import { SandboxBadge } from '@/components/billing/primitives';
import { StripeElementsForm } from '@/components/billing/StripeElementsForm';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS } from '@/components/patient/heritage';
import { formatCents, formatDate } from '@/lib/billing-format';
import { PublicBillingError, publicBilling } from '@/lib/billing-api';
import type {
  PublicLink,
  PublicOrderRequest,
  PublicOrderResponse,
  PublicOrderStatus,
  PublicSubscription,
  ShippingAddress,
} from '@/lib/billing-types';

const STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
];

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-8 text-foreground sm:py-12">
      <main className="mx-auto w-full max-w-[640px]">
        <Link
          href="~/"
          className="inline-block font-serif text-2xl font-bold tracking-[.04em] text-navy"
          aria-label="THINNR home"
        >
          THINNR
        </Link>
        {children}
      </main>
    </div>
  );
}

function Loading() {
  return (
    <div
      className="mt-8 h-56 animate-pulse rounded-lg border border-border bg-card"
      aria-label="Loading payment details"
    />
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}

function Field({
  label,
  name,
  value,
  onChange,
  error,
  required,
  type = 'text',
  readOnly,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  readOnly?: boolean;
}) {
  const errorId = `${name}-error`;
  return (
    <label className="block text-xs font-semibold text-foreground">
      {label}
      <input
        className={`mt-1 h-10 w-full ${INPUT_CLASS}`}
        name={name}
        type={type}
        value={value}
        required={required}
        readOnly={readOnly}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        data-testid={`input-${name}`}
      />
      {error ? (
        <span id={errorId} className="mt-1 block text-xs text-destructive" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

const blankShipping: ShippingAddress = {
  name: '',
  line1: '',
  line2: null,
  city: '',
  state: '',
  postal_code: '',
  country: 'US',
  phone: null,
};

function CheckoutPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [link, setLink] = useState<PublicLink | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; inactive: boolean } | null>(null);
  const [reload, setReload] = useState(0);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [purchase, setPurchase] = useState<'one_time' | 'subscription'>('one_time');
  const [payer, setPayer] = useState({ name: '', email: '', phone: '' });
  const [shipping, setShipping] = useState<ShippingAddress>(blankShipping);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [order, setOrder] = useState<PublicOrderResponse | null>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    publicBilling
      .link(token)
      .then((result) => {
        if (!live) return;
        if (!result.active)
          setLoadError({
            message: 'This payment link is no longer active. Ask your office for a new one.',
            inactive: true,
          });
        else {
          setLink(result);
          const preselected = result.products.find(
            (product) => product.product_id === result.preselected_product_id,
          );
          setQuantities(preselected ? { [preselected.product_id]: 1 } : {});
          // Checkout has always defaulted to a one-time order. Preselection
          // chooses an item, not a commitment to recurring billing.
          setPurchase('one_time');
          if (result.locked_payer) {
            setPayer({
              name: result.locked_payer.name,
              email: result.locked_payer.email ?? '',
              phone: result.locked_payer.phone ?? '',
            });
            setShipping((current) => ({ ...current, name: current.name || result.locked_payer!.name }));
          }
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        const inactive = error instanceof PublicBillingError && error.status === 404;
        setLoadError({
          inactive,
          message: inactive
            ? 'This payment link is no longer active. Ask your office for a new one.'
            : error instanceof Error
              ? error.message
              : 'Could not load this payment link.',
        });
      });
    return () => {
      live = false;
    };
  }, [token, reload]);

  const hasSubscriptions = link?.products.some((product) => product.subscription_available) ?? false;
  const subtotal = useMemo(
    () =>
      link?.products.reduce(
        (sum, product) => sum + product.unit_price_cents * (quantities[product.product_id] ?? 0),
        0,
      ) ?? 0,
    [link, quantities],
  );

  const setQuantity = (productId: string, value: number) => {
    const next = Math.max(0, Math.min(10, value));
    setQuantities((current) =>
      purchase === 'subscription' ? { [productId]: next > 0 ? 1 : 0 } : { ...current, [productId]: next },
    );
  };

  const choosePurchase = (mode: 'one_time' | 'subscription') => {
    setPurchase(mode);
    if (mode === 'subscription') {
      const selected =
        link?.products.find((product) => product.subscription_available && (quantities[product.product_id] ?? 0) > 0) ??
        link?.products.find((product) => product.subscription_available);
      setQuantities(selected ? { [selected.product_id]: 1 } : {});
    }
  };

  const validate = () => {
    const errors: Record<string, string> = {};
    if (!Object.values(quantities).some((quantity) => quantity > 0)) errors.items = 'Choose at least one product.';
    if (!link?.locked_payer) {
      if (!payer.name.trim()) errors.name = 'Enter your name.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payer.email.trim())) errors.email = 'Enter a valid email address.';
      if (!/^\+?[\d ()-]{7,}$/.test(payer.phone.trim())) errors.phone = 'Enter a valid phone number.';
    }
    if (!shipping.name.trim()) errors.shipping_name = 'Enter the recipient name.';
    if (!shipping.line1.trim()) errors.line1 = 'Enter a street address.';
    if (!shipping.city.trim()) errors.city = 'Enter a city.';
    if (!shipping.state) errors.state = 'Choose a state.';
    if (!/^\d{5}(-\d{4})?$/.test(shipping.postal_code.trim())) errors.postal_code = 'Enter a valid ZIP code.';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const createOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!link || !validate()) return;
    const body: PublicOrderRequest = {
      items: link.products.flatMap((product) => {
        const quantity = quantities[product.product_id] ?? 0;
        return quantity ? [{ product_id: product.product_id, quantity }] : [];
      }),
      shipping_address: {
        ...shipping,
        name: shipping.name.trim(),
        line1: shipping.line1.trim(),
        line2: shipping.line2?.trim() || null,
        city: shipping.city.trim(),
        postal_code: shipping.postal_code.trim(),
        phone: shipping.phone?.trim() || null,
      },
      purchase,
      ...(!link.locked_payer
        ? { payer: { name: payer.name.trim(), email: payer.email.trim(), phone: payer.phone.trim() } }
        : {}),
    };
    setCreating(true);
    setSubmitError(null);
    try {
      setOrder(await publicBilling.createOrder(token, body));
    } catch (error) {
      if (error instanceof PublicBillingError && error.field) {
        const field = error.field.split('.').at(-1) ?? error.field;
        setFieldErrors((current) => ({
          ...current,
          [field === 'name' && error.field?.startsWith('shipping_address.') ? 'shipping_name' : field]: error.message,
        }));
      } else setSubmitError(error instanceof Error ? error.message : 'Could not prepare this order.');
    } finally {
      setCreating(false);
    }
  };

  if (loadError)
    return (
      <Frame>
        <section className="mt-8 rounded-lg border border-border bg-card p-6 shadow-soft">
          <h1 className="font-serif text-2xl font-bold text-navy">Payment link unavailable</h1>
          <div className="mt-4">
            <Alert>{loadError.message}</Alert>
          </div>
          {!loadError.inactive ? (
            <button
              type="button"
              className={`mt-5 h-10 px-4 ${BTN_SECONDARY}`}
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
          ) : null}
        </section>
      </Frame>
    );
  if (!link)
    return (
      <Frame>
        <Loading />
      </Frame>
    );

  const displayedTotals = order?.totals ?? {
    subtotal_cents: subtotal,
    shipping_charge_cents: link.shipping_charge_cents,
    tax_cents: 0,
    total_cents: subtotal + link.shipping_charge_cents,
  };
  return (
    <Frame>
      <header className="mt-7 border-b border-border pb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Secure checkout</p>
            <h1 className="mt-2 font-serif text-3xl font-bold text-navy">{link.office.name}</h1>
            {link.office.city || link.office.state ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {[link.office.city, link.office.state].filter(Boolean).join(', ')}
              </p>
            ) : null}
          </div>
          <SandboxBadge sandbox={link.sandbox} />
        </div>
        <p className="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">Powered by THINNR</p>
      </header>

      <form className="mt-6 space-y-5" onSubmit={(event) => void createOrder(event)}>
        <fieldset disabled={Boolean(order)} className="space-y-5 disabled:opacity-75">
          {hasSubscriptions ? (
            <fieldset>
              <legend className="text-sm font-semibold text-navy">Purchase option</legend>
              <div className="mt-2 grid grid-cols-2 rounded-md border border-border bg-card p-1">
                {(['one_time', 'subscription'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={purchase === mode}
                    className={`rounded px-2 py-2 text-xs font-semibold ${purchase === mode ? 'bg-primary text-primary-foreground' : 'text-foreground'}`}
                    onClick={() => choosePurchase(mode)}
                  >
                    {mode === 'one_time' ? 'One-time order' : 'Subscribe every 4 weeks'}
                  </button>
                ))}
              </div>
              {purchase === 'subscription' ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Ships every 4 weeks. Cancel any time from your receipt email.
                </p>
              ) : null}
            </fieldset>
          ) : null}

          <fieldset>
            <legend className="text-sm font-semibold text-navy">Choose products</legend>
            <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
              {link.products.map((product) => {
                const unavailable = purchase === 'subscription' && !product.subscription_available;
                const quantity = quantities[product.product_id] ?? 0;
                return (
                  <div
                    key={product.product_id}
                    className={`flex items-center justify-between gap-3 p-4 ${unavailable ? 'opacity-45' : ''}`}
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {product.image_url ? (
                        <img
                          src={product.image_url}
                          alt=""
                          className="h-12 w-12 shrink-0 rounded-md border border-border object-cover"
                          loading="lazy"
                        />
                      ) : null}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">{product.name}</p>
                        {product.description ? (
                          <p className="text-xs leading-relaxed text-muted-foreground">{product.description}</p>
                        ) : null}
                        <p className="mt-0.5 text-xs font-semibold text-navy">{formatCents(product.unit_price_cents)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2" aria-label={`${product.name} quantity`}>
                      <button
                        type="button"
                        className="h-9 w-9 rounded-md border border-border bg-background text-lg"
                        disabled={unavailable || quantity === 0}
                        onClick={() => setQuantity(product.product_id, quantity - 1)}
                        aria-label={`Remove one ${product.name}`}
                      >
                        −
                      </button>
                      <span
                        className="w-5 text-center text-sm tabular-nums"
                        data-testid={`quantity-${product.product_id}`}
                      >
                        {quantity}
                      </span>
                      <button
                        type="button"
                        className="h-9 w-9 rounded-md border border-border bg-background text-lg"
                        disabled={unavailable || quantity >= (purchase === 'subscription' ? 1 : 10)}
                        onClick={() => setQuantity(product.product_id, quantity + 1)}
                        aria-label={`Add one ${product.name}`}
                      >
                        +
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {fieldErrors.items ? (
              <p className="mt-1 text-xs text-destructive" role="alert">
                {fieldErrors.items}
              </p>
            ) : null}
          </fieldset>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="font-serif text-lg font-bold text-navy">Contact details</h2>
            {link.locked_payer ? (
              <dl className="mt-3 space-y-1 text-sm" data-testid="locked-payer">
                <div>
                  <dt className="inline font-semibold">Name: </dt>
                  <dd className="inline">{payer.name}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Email: </dt>
                  <dd className="inline">{payer.email || 'Not provided'}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Phone: </dt>
                  <dd className="inline">{payer.phone || 'Not provided'}</dd>
                </div>
              </dl>
            ) : (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field
                  label="Name"
                  name="name"
                  value={payer.name}
                  error={fieldErrors.name}
                  required
                  onChange={(value) => {
                    setPayer({ ...payer, name: value });
                    if (!shipping.name) setShipping({ ...shipping, name: value });
                  }}
                />
                <Field
                  label="Email"
                  name="email"
                  type="email"
                  value={payer.email}
                  error={fieldErrors.email}
                  required
                  onChange={(value) => setPayer({ ...payer, email: value })}
                />
                <Field
                  label="Phone"
                  name="phone"
                  type="tel"
                  value={payer.phone}
                  error={fieldErrors.phone}
                  required
                  onChange={(value) => setPayer({ ...payer, phone: value })}
                />
              </div>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="font-serif text-lg font-bold text-navy">Shipping address</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field
                label="Recipient name"
                name="shipping_name"
                value={shipping.name}
                error={fieldErrors.shipping_name}
                required
                onChange={(value) => setShipping({ ...shipping, name: value })}
              />
              <Field
                label="Street address"
                name="line1"
                value={shipping.line1}
                error={fieldErrors.line1}
                required
                onChange={(value) => setShipping({ ...shipping, line1: value })}
              />
              <Field
                label="Apartment, suite, or unit"
                name="line2"
                value={shipping.line2 ?? ''}
                onChange={(value) => setShipping({ ...shipping, line2: value })}
              />
              <Field
                label="City"
                name="city"
                value={shipping.city}
                error={fieldErrors.city}
                required
                onChange={(value) => setShipping({ ...shipping, city: value })}
              />
              <label className="block text-xs font-semibold">
                State
                <select
                  name="state"
                  value={shipping.state}
                  required
                  aria-invalid={Boolean(fieldErrors.state)}
                  className={`mt-1 h-10 w-full ${INPUT_CLASS}`}
                  onChange={(event) => setShipping({ ...shipping, state: event.target.value })}
                  data-testid="input-state"
                >
                  <option value="">Choose state</option>
                  {STATES.map((state) => (
                    <option key={state}>{state}</option>
                  ))}
                </select>
                {fieldErrors.state ? (
                  <span className="mt-1 block text-xs text-destructive" role="alert">
                    {fieldErrors.state}
                  </span>
                ) : null}
              </label>
              <Field
                label="ZIP code"
                name="postal_code"
                value={shipping.postal_code}
                error={fieldErrors.postal_code}
                required
                onChange={(value) => setShipping({ ...shipping, postal_code: value })}
              />
              <Field label="Country" name="country" value="United States" readOnly onChange={() => {}} />
              <Field
                label="Shipping phone (optional)"
                name="shipping_phone"
                type="tel"
                value={shipping.phone ?? ''}
                onChange={(value) => setShipping({ ...shipping, phone: value })}
              />
            </div>
          </section>
        </fieldset>

        <section className="rounded-lg border border-border bg-card p-5" data-testid="order-summary">
          <h2 className="font-serif text-lg font-bold text-navy">Order summary</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt>Subtotal</dt>
              <dd>{formatCents(displayedTotals.subtotal_cents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Shipping</dt>
              <dd>{formatCents(displayedTotals.shipping_charge_cents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Tax</dt>
              <dd>
                {order ? formatCents(displayedTotals.tax_cents) : link.tax_enabled ? 'Calculated at payment' : '—'}
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold">
              <dt>Total</dt>
              <dd>{formatCents(displayedTotals.total_cents)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Your payment goes to {link.office.name}, the merchant for this order. THINNR provides the platform.
          </p>
        </section>
        {submitError ? <Alert>{submitError}</Alert> : null}
        {!order ? (
          <button type="submit" className={`h-11 w-full ${BTN_PRIMARY}`} disabled={creating}>
            {creating ? 'Preparing payment…' : 'Continue to payment'}
          </button>
        ) : (
          <button type="button" className={`h-10 w-full ${BTN_SECONDARY}`} onClick={() => setOrder(null)}>
            Edit order
          </button>
        )}
      </form>
      {order ? (
        <section className="mt-5 rounded-lg border border-border bg-card p-5 shadow-soft">
          <h2 className="mb-4 font-serif text-xl font-bold text-navy">Payment</h2>
          <StripeElementsForm
            publishableKey={order.publishable_key}
            stripeAccount={order.stripe_account_id}
            clientSecret={order.client_secret}
            returnUrl={`${window.location.origin}/pay/${encodeURIComponent(token)}/done?order=${encodeURIComponent(order.order_id)}&token=${encodeURIComponent(token)}`}
          />
        </section>
      ) : null}
    </Frame>
  );
}

function DonePage() {
  const { token: pathToken = '' } = useParams<{ token: string }>();
  const search = new URLSearchParams(useSearch());
  const orderId = search.get('order') ?? '';
  const token = search.get('token') ?? pathToken;
  const [status, setStatus] = useState<PublicOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!orderId || !token) {
      setError('This confirmation link is incomplete.');
      return;
    }
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async () => {
      try {
        const result = await publicBilling.orderStatus(orderId, token);
        if (canceled) return;
        setStatus(result);
        if (result.status === 'pending' && attempts < 30) {
          attempts += 1;
          timer = setTimeout(() => void poll(), 2000);
        } else if (result.status === 'pending') setTimedOut(true);
      } catch (caught) {
        if (!canceled) setError(caught instanceof Error ? caught.message : 'Could not check this payment.');
      }
    };
    void poll();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [orderId, token, refresh]);

  if (error)
    return (
      <Frame>
        <section className="mt-8">
          <Alert>{error}</Alert>
        </section>
      </Frame>
    );
  if (!status)
    return (
      <Frame>
        <Loading />
      </Frame>
    );
  if (status.status === 'failed')
    return (
      <Frame>
        <section className="mt-8 rounded-lg border border-border bg-card p-6">
          <h1 className="font-serif text-2xl font-bold text-navy">Payment did not go through</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            No payment was completed. You can return to checkout and try again.
          </p>
          <Link className={`mt-5 h-10 px-4 ${BTN_PRIMARY}`} href={`/${encodeURIComponent(token)}`}>
            Return to checkout
          </Link>
        </section>
      </Frame>
    );
  if (timedOut || status.status === 'pending')
    return (
      <Frame>
        <section className="mt-8 rounded-lg border border-border bg-card p-6">
          <h1 className="font-serif text-2xl font-bold text-navy">
            {timedOut ? 'Still confirming…' : 'Confirming your payment…'}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {timedOut
              ? 'Check your email for your receipt, or refresh this page.'
              : 'This usually takes only a moment.'}
          </p>
          {timedOut ? (
            <button
              type="button"
              className={`mt-5 h-10 px-4 ${BTN_SECONDARY}`}
              onClick={() => {
                setTimedOut(false);
                setRefresh((value) => value + 1);
              }}
            >
              Refresh status
            </button>
          ) : null}
        </section>
      </Frame>
    );
  return (
    <Frame>
      <section className="mt-8 rounded-lg border border-border bg-card p-6 shadow-soft" data-testid="payment-receipt">
        <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Payment received</p>
        <h1 className="mt-2 font-serif text-3xl font-bold text-navy">Thank you for your order</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {status.office_name} · Order {status.order_number}
        </p>
        <div className="mt-5 border-y border-border py-3">
          {status.items.map((item, index) => (
            <div key={`${item.name}-${index}`} className="flex justify-between py-1 text-sm">
              <span>
                {item.quantity} × {item.name}
              </span>
              <span>{formatCents(item.unit_price_cents * item.quantity)}</span>
            </div>
          ))}
        </div>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatCents(status.subtotal_cents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Shipping</dt>
            <dd>{formatCents(status.shipping_charge_cents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Tax</dt>
            <dd>{formatCents(status.tax_cents)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd>{formatCents(status.total_cents)}</dd>
          </div>
        </dl>
        {status.payer_email ? <p className="mt-5 text-sm">Receipt sent to {status.payer_email}</p> : null}
        {status.subscription ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Your order ships every 4 weeks
            {status.subscription.renews_on ? ` and renews on ${formatDate(status.subscription.renews_on)}` : ''}.
          </p>
        ) : null}
      </section>
    </Frame>
  );
}

function CancelPage() {
  const { cancelToken = '' } = useParams<{ cancelToken: string }>();
  const [subscription, setSubscription] = useState<PublicSubscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    let live = true;
    publicBilling
      .subscription(cancelToken)
      .then((result) => {
        if (live) setSubscription(result);
      })
      .catch((caught) => {
        if (live) setError(caught instanceof Error ? caught.message : 'Could not load this subscription.');
      });
    return () => {
      live = false;
    };
  }, [cancelToken]);
  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      setSubscription(await publicBilling.cancelSubscription(cancelToken));
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not cancel this subscription.');
    } finally {
      setBusy(false);
    }
  };
  if (error && !subscription)
    return (
      <Frame>
        <section className="mt-8">
          <Alert>{error}</Alert>
        </section>
      </Frame>
    );
  if (!subscription)
    return (
      <Frame>
        <Loading />
      </Frame>
    );
  const alreadyCanceled = subscription.status === 'canceled' || subscription.cancel_at_period_end;
  return (
    <Frame>
      <section
        className="mt-8 rounded-lg border border-border bg-card p-6 shadow-soft"
        data-testid="subscription-cancel"
      >
        <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Subscription</p>
        <h1 className="mt-2 font-serif text-2xl font-bold text-navy">{subscription.product_name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subscription.office_name}</p>
        <dl className="mt-5 space-y-2 border-y border-border py-4 text-sm">
          <div className="flex justify-between">
            <dt>Every 4 weeks</dt>
            <dd>{formatCents(subscription.unit_price_cents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Shipping</dt>
            <dd>{formatCents(subscription.shipping_charge_cents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Next renewal</dt>
            <dd>{formatDate(subscription.current_period_end)}</dd>
          </div>
        </dl>
        {done ? (
          <p className="mt-5 text-sm font-semibold text-primary" role="status">
            Your subscription will end after the current period.
          </p>
        ) : alreadyCanceled ? (
          <p className="mt-5 rounded-md bg-secondary p-3 text-sm">
            This subscription is already canceled or scheduled to end.
          </p>
        ) : (
          <button
            type="button"
            className={`mt-5 h-11 w-full px-4 ${BTN_PRIMARY}`}
            disabled={busy}
            onClick={() => void cancel()}
          >
            {busy ? 'Canceling…' : 'Cancel at the end of the current period'}
          </button>
        )}
        {error ? (
          <div className="mt-4">
            <Alert>{error}</Alert>
          </div>
        ) : null}
      </section>
    </Frame>
  );
}

export default function PublicPayArea() {
  return (
    <Switch>
      <Route path="/cancel/:cancelToken" component={CancelPage} />
      <Route path="/:token/done" component={DonePage} />
      <Route path="/:token" component={CheckoutPage} />
      <Route component={NotFound} />
    </Switch>
  );
}
