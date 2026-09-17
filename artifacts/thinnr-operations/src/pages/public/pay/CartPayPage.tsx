import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'wouter';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS } from '@/components/patient/heritage';
import { SandboxBadge } from '@/components/billing/primitives';
import { StripePaymentMethodForm, type HandleNextAction } from '@/components/billing/StripePaymentMethodForm';
import { formatCents } from '@/lib/billing-format';
import { PublicBillingError, publicBilling } from '@/lib/billing-api';
import type {
  CartCheckoutItem,
  PublicCartDetails,
  PublicCartPeek,
  PublicCartStatus,
  ShippingAddress,
} from '@/lib/billing-types';

const blank: ShippingAddress = {
  name: '',
  line1: '',
  line2: null,
  city: '',
  state: '',
  postal_code: '',
  country: 'US',
  phone: null,
};

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-8 text-foreground sm:py-12">
      <main className="mx-auto w-full max-w-[640px]">
        <Link href="~/" className="font-serif text-2xl font-bold tracking-[.04em] text-navy">
          THINNR
        </Link>
        {children}
      </main>
    </div>
  );
}
function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}
function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="text-xs font-semibold">
      {label}
      <input
        className={`${INPUT_CLASS} mt-1 h-10 w-full`}
        value={value}
        type={type}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
const terminalCopy: Record<string, [string, string]> = {
  expired: ['This cart has expired', 'Ask your office to create a new QR code.'],
  used: ['This cart has already been used', 'This checkout can only be completed once.'],
  revoked: ['This cart was canceled', 'Ask your office if you still need to make this purchase.'],
  locked: ['This cart is locked', 'Too many phone numbers were entered. Ask your office to create a new cart.'],
};

export default function CartPayPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [peek, setPeek] = useState<PublicCartPeek | null>(null);
  const [stage, setStage] = useState<'phone' | 'code' | 'details' | 'action' | 'paid' | 'partial' | 'failed'>(
    'phone',
  );
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [session, setSession] = useState('');
  const [details, setDetails] = useState<PublicCartDetails | null>(null);
  const [address, setAddress] = useState<ShippingAddress>(blank);
  const [payer, setPayer] = useState({ name: '', email: '', phone: '' });
  const [status, setStatus] = useState<Pick<PublicCartStatus, 'orders' | 'office_name' | 'paid_at'> | null>(null);
  const [outcomes, setOutcomes] = useState<Array<Pick<CartCheckoutItem, 'order_number' | 'status' | 'total_cents' | 'error'>>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const action = useRef<HandleNextAction | null>(null);

  useEffect(() => {
    publicBilling
      .cartPeek(token)
      .then(setPeek, (caught) => setError(caught instanceof Error ? caught.message : 'This cart could not be loaded.'));
  }, [token]);

  const sendPhone = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await publicBilling.cartPhone(token, phone);
      setRequestId(response.request_id);
      setDevCode(response.devCode ?? null);
      setStage('code');
    } catch (caught) {
      const suffix =
        caught instanceof PublicBillingError && caught.attemptsLeft != null
          ? ` ${caught.attemptsLeft} attempts left.`
          : '';
      setError(`${caught instanceof Error ? caught.message : 'The code could not be sent.'}${suffix}`);
      if (caught instanceof PublicBillingError && caught.status === 423)
        setPeek({
          status: 'locked',
          office: peek?.office ?? { name: 'Your office' },
          sandbox: peek?.sandbox ?? false,
        });
    } finally {
      setBusy(false);
    }
  };
  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const verified = await publicBilling.cartVerify(token, requestId, code);
      const loaded = await publicBilling.cartDetails(token, verified.session);
      setSession(verified.session);
      setDetails(loaded);
      setAddress(
        loaded.default_address ?? {
          ...blank,
          name: loaded.patient?.name ?? '',
          phone: loaded.patient?.phone ?? null,
        },
      );
      setPayer({
        name: loaded.patient?.name ?? '',
        email: loaded.patient?.email ?? '',
        phone: loaded.patient?.phone ?? phone,
      });
      setStage('details');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That code could not be verified.');
    } finally {
      setBusy(false);
    }
  };
  const pay = async (paymentMethodId: string) => {
    if (!details) return;
    setError(null);
    try {
      const response = await publicBilling.cartCheckout(token, session, {
        shipping_address: address,
        payment_method_id: paymentMethodId,
        ...(!details.patient ? { payer } : {}),
      });
      const responseOutcomes = response.items.map((item) => ({
        order_number: item.order_number,
        status: item.status,
        total_cents: item.total_cents,
        error: item.error,
      }));
      setOutcomes(responseOutcomes);
      const responseHasPaid = response.items.some((item) => item.status === 'paid');
      if (response.status === 'partial' || (responseHasPaid && response.items.some((item) => item.status !== 'paid'))) {
        setStage('partial');
        return;
      }
      if (response.status === 'paid') {
        setStatus({
          orders: response.items.map((item) => ({
            order_number: item.order_number,
            kind: item.kind,
            status: item.status,
            total_cents: item.total_cents,
          })),
          office_name: details.office.name,
          paid_at: new Date().toISOString(),
        });
        setStage('paid');
        return;
      }
      if (response.status === 'requires_action') {
        setStage('action');
        for (const item of response.items.filter((entry) => entry.client_secret)) {
          const actionError = await action.current?.(item.client_secret!);
          if (actionError) {
            setError(actionError);
            setStage('failed');
            return;
          }
        }
        for (let attempt = 0; attempt < 30; attempt += 1) {
          const current = await publicBilling.cartStatus(token, session);
          setStatus(current);
          setOutcomes(
            current.orders.map((order) => ({
              order_number: order.order_number,
              status: order.status as CartCheckoutItem['status'],
              total_cents: order.total_cents,
              error: null,
            })),
          );
          if (current.status === 'paid') {
            setStage(current.partial ? 'partial' : 'paid');
            return;
          }
          if (current.status === 'failed') {
            setStage(current.partial || current.orders.some((order) => order.status === 'paid') ? 'partial' : 'failed');
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        setError('Payment is still confirming. Please check again shortly.');
      } else setStage('failed');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Payment could not be completed.');
    }
  };

  if (error && !peek)
    return (
      <Frame>
        <div className="mt-8">
          <ErrorText>{error}</ErrorText>
        </div>
      </Frame>
    );
  if (!peek)
    return (
      <Frame>
        <div className="mt-8 h-56 animate-pulse rounded-lg border bg-card" aria-label="Loading cart" />
      </Frame>
    );
  if (terminalCopy[peek.status])
    return (
      <Frame>
        <section className="mt-8 rounded-lg border bg-card p-6">
          <h1 className="font-serif text-2xl font-bold text-navy">{terminalCopy[peek.status][0]}</h1>
          <p className="mt-3 text-sm text-muted-foreground">{terminalCopy[peek.status][1]}</p>
        </section>
      </Frame>
    );

  return (
    <Frame>
      <header className="mt-7 border-b pb-6">
        <div className="flex justify-between">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Secure checkout</p>
            <h1 className="mt-2 font-serif text-3xl font-bold text-navy">{details?.office.name ?? peek.office.name}</h1>
          </div>
          <SandboxBadge sandbox={peek.sandbox} />
        </div>
      </header>
      {error ? (
        <div className="mt-5">
          <ErrorText>{error}</ErrorText>
        </div>
      ) : null}
      {stage === 'phone' ? (
        <form className="mt-6 rounded-lg border bg-card p-5" onSubmit={(e) => void sendPhone(e)}>
          <h2 className="font-serif text-xl font-bold text-navy">Enter the mobile number on file</h2>
          <p className="mt-2 text-sm text-muted-foreground">We’ll text a code to confirm this cart belongs to you.</p>
          <div className="mt-4">
            <Field label="Mobile number" type="tel" value={phone} onChange={setPhone} />
          </div>
          <button className={`${BTN_PRIMARY} mt-4 h-11 w-full`} disabled={busy}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : null}
      {stage === 'code' ? (
        <form className="mt-6 rounded-lg border bg-card p-5" onSubmit={(e) => void verify(e)}>
          <h2 className="font-serif text-xl font-bold text-navy">Enter your code</h2>
          {devCode ? (
            <p className="mt-3 rounded bg-secondary p-3 text-sm">
              <b>Test-mode code:</b> {devCode}
            </p>
          ) : null}
          <div className="mt-4">
            <Field label="Verification code" value={code} onChange={setCode} />
          </div>
          <button className={`${BTN_PRIMARY} mt-4 h-11 w-full`} disabled={busy}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      ) : null}
      {details && stage === 'details' ? (
        <div className="mt-6 space-y-5">
          <section className="rounded-lg border bg-card p-5">
            <h2 className="font-serif text-xl font-bold text-navy">Your cart</h2>
            {details.lines.map((line) => (
              <div className="mt-3 flex justify-between text-sm" key={`${line.product_id}-${line.purchase}`}>
                <span>
                  {line.quantity} × {line.name}
                  {line.cadence_weeks ? ` · every ${line.cadence_weeks} weeks` : ''}
                </span>
                <span>{formatCents(line.line_total_cents)}</span>
              </div>
            ))}
            <div className="mt-3 flex justify-between border-t pt-3 font-bold">
              <span>Total today</span>
              <span>{formatCents(details.quote.total_cents)}</span>
            </div>
          </section>
          <section className="grid gap-3 rounded-lg border bg-card p-5 sm:grid-cols-2">
            <h2 className="font-serif text-xl font-bold text-navy sm:col-span-2">Contact and shipping</h2>
            {!details.patient ? (
              <>
                <Field label="Name" value={payer.name} onChange={(v) => setPayer({ ...payer, name: v })} />
                <Field
                  label="Email"
                  type="email"
                  value={payer.email}
                  onChange={(v) => setPayer({ ...payer, email: v })}
                />
                <Field
                  label="Phone"
                  type="tel"
                  value={payer.phone}
                  onChange={(v) => setPayer({ ...payer, phone: v })}
                />
              </>
            ) : (
              <div className="text-sm sm:col-span-2">
                {payer.name} · {payer.email} · {payer.phone}
              </div>
            )}
            {(
              [
                ['Recipient name', 'name'],
                ['Street address', 'line1'],
                ['Apartment or suite', 'line2'],
                ['City', 'city'],
                ['State', 'state'],
                ['ZIP code', 'postal_code'],
              ] as const
            ).map(([label, key]) => (
              <Field
                key={key}
                label={label}
                value={address[key] ?? ''}
                onChange={(v) =>
                  setAddress({
                    ...address,
                    [key]: v || (key === 'line2' ? null : ''),
                  })
                }
              />
            ))}
          </section>
          <section className="rounded-lg border bg-card p-5">
            <h2 className="mb-4 font-serif text-xl font-bold text-navy">Payment</h2>
            <StripePaymentMethodForm
              publishableKey={details.publishable_key}
              stripeAccount={details.stripe_account_id}
              amount={details.quote.total_cents}
              onReady={(handler) => {
                action.current = handler;
              }}
              onPaymentMethod={pay}
            />
          </section>
        </div>
      ) : null}
      {stage === 'action' ? (
        <section className="mt-6 rounded-lg border bg-card p-6">
          <h2 className="font-serif text-xl font-bold text-navy">Confirming your payment…</h2>
          <p className="mt-2 text-sm text-muted-foreground">This usually takes only a moment.</p>
        </section>
      ) : null}
      {stage === 'failed' ? (
        <section className="mt-6 rounded-lg border bg-card p-6">
          <h2 className="font-serif text-xl font-bold text-navy">Payment did not go through</h2>
          <p className="mt-2 text-sm text-muted-foreground">No payment was completed. You can try another card.</p>
          <button className={`${BTN_SECONDARY} mt-4 h-10 px-4`} onClick={() => setStage('details')}>
            Try another card
          </button>
        </section>
      ) : null}
      {stage === 'partial' ? (
        <section className="mt-6 rounded-lg border bg-card p-6" data-testid="cart-partial-receipt">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Payment partly completed</p>
          <h2 className="mt-2 font-serif text-2xl font-bold text-navy">Some items were paid</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Contact the office for help completing the remaining items. Do not enter another card here.
          </p>
          {outcomes.map((item) => (
            <div className="mt-4 border-t pt-3 text-sm" key={item.order_number}>
              <div className="flex justify-between gap-4">
                <span>
                  Order {item.order_number} ·{' '}
                  <b>{item.status === 'paid' ? 'Paid' : item.status === 'failed' ? 'Failed' : 'Needs confirmation'}</b>
                </span>
                <b>{formatCents(item.total_cents)}</b>
              </div>
              {item.error ? <p className="mt-1 text-xs text-destructive">{item.error}</p> : null}
            </div>
          ))}
        </section>
      ) : null}
      {stage === 'paid' && status ? (
        <section className="mt-6 rounded-lg border bg-card p-6" data-testid="cart-payment-receipt">
          <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Payment received</p>
          <h2 className="mt-2 font-serif text-3xl font-bold text-navy">Thank you for your order</h2>
          {status.orders.map((order) => (
            <div className="mt-4 flex justify-between text-sm" key={order.order_number}>
              <span>Order {order.order_number}</span>
              <b>{formatCents(order.total_cents)}</b>
            </div>
          ))}
          <p className="mt-4 border-t pt-3 text-right font-bold">
            Total {formatCents(status.orders.reduce((sum, order) => sum + order.total_cents, 0))}
          </p>
        </section>
      ) : null}
    </Frame>
  );
}
