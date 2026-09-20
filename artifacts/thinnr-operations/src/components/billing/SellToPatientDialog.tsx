import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLASS } from '@/components/patient/heritage';
import { formatCents } from '@/lib/billing-format';
import { BillingApiError, officeBilling } from '@/lib/billing-api';
import type {
  CartCheckoutResponse,
  CartLineInput,
  CartQuote,
  PrebuiltCart,
  ShippingAddress,
  StaffSaleContext,
} from '@/lib/billing-types';
import { StripePaymentMethodForm, type HandleNextAction } from './StripePaymentMethodForm';

const EMPTY_ADDRESS: ShippingAddress = {
  name: '',
  line1: '',
  line2: null,
  city: '',
  state: '',
  postal_code: '',
  country: 'US',
  phone: null,
};
type Step = 'products' | 'method' | 'card' | 'qr' | 'done';

function checkoutOutcome(status: string) {
  if (status === 'paid') return 'Paid';
  if (status === 'failed') return 'Failed';
  return 'Needs confirmation';
}

function copyText(text: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('Clipboard unavailable'));
}

export function SellToPatientDialog({
  open,
  onOpenChange,
  patient,
  office,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient: { id: string; name: string };
  office?: string | null;
}) {
  const [context, setContext] = useState<StaffSaleContext | null>(null);
  const [lines, setLines] = useState<CartLineInput[]>([]);
  const [quote, setQuote] = useState<CartQuote | null>(null);
  const [step, setStep] = useState<Step>('products');
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [contact, setContact] = useState({ name: '', email: '', phone: '' });
  const [result, setResult] = useState<CartCheckoutResponse | null>(null);
  const [cart, setCart] = useState<PrebuiltCart | null>(null);
  const [qr, setQr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const paymentMethod = useRef<string | null>(null);
  const definitiveFailure = useRef(false);
  const action = useRef<HandleNextAction | null>(null);
  const idempotencyKey = useRef('');

  useEffect(() => {
    if (!open) return;
    setContext(null);
    setLines([]);
    setQuote(null);
    setStep('products');
    setResult(null);
    setCart(null);
    setQr('');
    setError(null);
    definitiveFailure.current = false;
    officeBilling.saleContext(patient.id, office).then(
      (value) => {
        setContext(value);
        setContact({
          name: value.patient.name,
          email: value.patient.email ?? '',
          phone: value.patient.phone ?? '',
        });
        setAddress(
          value.default_address ?? {
            ...EMPTY_ADDRESS,
            name: value.patient.name,
            phone: value.patient.phone,
          },
        );
      },
      (caught) => setError(caught instanceof Error ? caught.message : 'Could not load products.'),
    );
  }, [open, patient.id, office]);

  useEffect(() => {
    if (!open || !lines.length) {
      setQuote(null);
      return;
    }
    // Each change owns its own request: a slower, older quote must never land
    // on top of a newer selection (and a failed quote must not leave a stale one).
    let current = true;
    const timer = setTimeout(() => {
      officeBilling.saleQuote({ patient_id: patient.id, lines }, office).then(
        (value) => {
          if (current) setQuote(value);
        },
        (caught) => {
          if (!current) return;
          setQuote(null);
          setError(caught instanceof Error ? caught.message : 'Could not update the quote.');
        },
      );
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, patient.id, lines, office]);

  useEffect(() => {
    if (!open || step !== 'qr' || !cart || !['open', 'verified', 'checkout'].includes(cart.status)) return;
    const timer = setInterval(() => officeBilling.cart(cart.id, office).then(setCart, () => {}), 3000);
    return () => clearInterval(timer);
  }, [open, step, cart?.id, cart?.status, office]);
  useEffect(() => {
    if (!open || step !== 'qr') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, step]);

  const setProduct = (productId: string, patch: Partial<CartLineInput> | null) => {
    setLines((current) => {
      const old = current.find((line) => line.product_id === productId);
      if (!patch) return current.filter((line) => line.product_id !== productId);
      const next = {
        ...(old ?? {
          product_id: productId,
          quantity: 1,
          purchase: 'one_time' as const,
        }),
        ...patch,
      };
      return [...current.filter((line) => line.product_id !== productId), next];
    });
  };
  const enterCard = () => {
    idempotencyKey.current = crypto.randomUUID();
    definitiveFailure.current = false;
    setStep('card');
  };
  const checkout = async (paymentMethodId?: string) => {
    const id = paymentMethodId ?? paymentMethod.current;
    if (!id || !quote) return;
    if (paymentMethodId && definitiveFailure.current) idempotencyKey.current = crypto.randomUUID();
    definitiveFailure.current = false;
    paymentMethod.current = id;
    setBusy(true);
    setError(null);
    try {
      const response = await officeBilling.saleCheckout(
        {
          patient_id: patient.id,
          lines,
          shipping_address: {
            ...address,
            name: contact.name,
            phone: contact.phone || null,
          },
          payment_method_id: id,
          cart_id: idempotencyKey.current,
        },
        office,
        idempotencyKey.current,
        context?.billing_scope,
      );
      setResult(response);
      definitiveFailure.current = response.status === 'failed';
      if (response.status === 'requires_action') {
        for (const item of response.items.filter(
          (entry) => entry.status === 'requires_action' && entry.client_secret,
        )) {
          const actionError = await action.current?.(item.client_secret!);
          if (actionError) setError(actionError);
        }
      } else if (response.status === 'paid' || response.status === 'partial') setStep('done');
    } catch (caught) {
      if (caught instanceof BillingApiError && caught.status === 402) definitiveFailure.current = true;
      setError(caught instanceof Error ? caught.message : 'The sale could not be completed.');
    } finally {
      setBusy(false);
    }
  };
  const createQr = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await officeBilling.createCart({ patient_id: patient.id, lines }, office);
      setCart(created);
      setQr(await QRCode.toDataURL(created.url, { width: 260, margin: 1 }));
      setStep('qr');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the QR code.');
    } finally {
      setBusy(false);
    }
  };
  const total = quote?.total_cents ?? 0;
  const remaining = cart ? Math.max(0, Math.ceil((new Date(cart.expires_at).getTime() - now) / 60000)) : 0;
  const cartPartlyPaid = Boolean(
    cart?.partial ||
      (cart?.orders.some((order) => order.status === 'paid') && cart.orders.some((order) => order.status !== 'paid')),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Sell to {patient.name}</DialogTitle>
          <DialogDescription>
            Build an order and charge a card here or let the patient scan a QR code.
          </DialogDescription>
        </DialogHeader>
        {!context && !error ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading products…</p>
        ) : null}
        {error ? (
          <p className="rounded-md bg-destructive/5 p-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {context && !context.available ? (
          <p className="py-6 text-sm">Sales are unavailable until this office connects Stripe and offers products.</p>
        ) : null}
        {context?.available && step === 'products' ? (
          <div className="space-y-4">
            <div className="divide-y rounded-lg border">
              {context.products.map((product) => {
                const line = lines.find((entry) => entry.product_id === product.product_id);
                return (
                  <div key={product.product_id} className="space-y-3 p-4">
                    <div className="flex justify-between gap-3">
                      <div>
                        <b className="text-sm">{product.name}</b>
                        <p className="text-xs text-muted-foreground">
                          {formatCents(product.unit_price_cents)} one-time
                          {product.subscription_unit_price_cents != null
                            ? ` · ${formatCents(product.subscription_unit_price_cents)} subscribe & save`
                            : ''}
                        </p>
                      </div>
                      <input
                        aria-label={`Select ${product.name}`}
                        type="checkbox"
                        checked={Boolean(line)}
                        onChange={(e) => setProduct(product.product_id, e.target.checked ? {} : null)}
                      />
                    </div>
                    {line ? (
                      <div className="grid grid-cols-3 gap-2">
                        <label className="text-xs">
                          Purchase
                          <select
                            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                            value={line.purchase}
                            onChange={(e) =>
                              setProduct(product.product_id, {
                                purchase: e.target.value as CartLineInput['purchase'],
                                cadence_weeks: e.target.value === 'subscription' ? product.default_cadence_weeks : null,
                              })
                            }
                          >
                            <option value="one_time">One-time</option>
                            {product.subscription_available ? <option value="subscription">Subscribe</option> : null}
                          </select>
                        </label>
                        <label className="text-xs">
                          Cadence
                          <select
                            aria-label={`${product.name} cadence`}
                            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                            disabled={line.purchase !== 'subscription'}
                            value={line.cadence_weeks ?? product.default_cadence_weeks}
                            onChange={(e) =>
                              setProduct(product.product_id, {
                                cadence_weeks: Number(e.target.value),
                              })
                            }
                          >
                            {product.subscription_cadences_weeks.map((weeks) => (
                              <option key={weeks} value={weeks}>
                                Every {weeks} weeks
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="text-xs">
                          Quantity
                          <input
                            aria-label={`${product.name} quantity`}
                            className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                            type="number"
                            min="1"
                            max="10"
                            value={line.quantity}
                            onChange={(e) =>
                              setProduct(product.product_id, {
                                quantity: Math.max(1, Math.min(10, Number(e.target.value))),
                              })
                            }
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {quote ? (
              <div className="rounded-lg border bg-card p-4" data-testid="sale-quote">
                <div className="space-y-1 text-sm">
                  {quote.lines.map((line) => (
                    <div className="flex justify-between" key={`${line.product_id}-${line.purchase}`}>
                      <span>
                        {line.quantity} × {line.name}
                        {line.cadence_weeks ? ` · every ${line.cadence_weeks} weeks` : ''}
                      </span>
                      <span>{formatCents(line.line_total_cents)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex justify-between border-t pt-3 font-bold">
                  <span>Total today</span>
                  <span>{formatCents(quote.total_cents)}</span>
                </div>
              </div>
            ) : null}
            <button className={`${BTN_PRIMARY} h-10 w-full`} disabled={!quote} onClick={() => setStep('method')}>
              Continue
            </button>
          </div>
        ) : null}
        {step === 'method' ? (
          <div className="grid gap-3 py-4 sm:grid-cols-2">
            <button className={`${BTN_PRIMARY} h-12`} onClick={enterCard}>
              Charge card here
            </button>
            <button className={`${BTN_SECONDARY} h-12`} disabled={busy} onClick={() => void createQr()}>
              Show QR code
            </button>
          </div>
        ) : null}
        {step === 'card' && context ? (
          <div className="space-y-5">
            <section className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
              {(
                [
                  ['Name', 'name', 'text'],
                  ['Email', 'email', 'email'],
                  ['Phone', 'phone', 'tel'],
                ] as const
              ).map(([label, key, type]) => (
                <label key={key} className="text-xs">
                  {label}
                  <input
                    className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                    type={type}
                    value={contact[key]}
                    onChange={(e) => setContact({ ...contact, [key]: e.target.value })}
                  />
                </label>
              ))}
              {(
                [
                  ['Street address', 'line1'],
                  ['Apartment or suite', 'line2'],
                  ['City', 'city'],
                  ['State', 'state'],
                  ['ZIP code', 'postal_code'],
                ] as const
              ).map(([label, key]) => (
                <label key={key} className="text-xs">
                  {label}
                  <input
                    className={`${INPUT_CLASS} mt-1 h-9 w-full`}
                    value={address[key] ?? ''}
                    onChange={(e) =>
                      setAddress({
                        ...address,
                        [key]: e.target.value || (key === 'line2' ? null : ''),
                      })
                    }
                  />
                </label>
              ))}
            </section>
            {result?.status === 'requires_action' ? (
              <div className="rounded-lg border p-4">
                <p className="text-sm">
                  Additional card verification is still required. Current item states are shown below.
                </p>
                {result.items.map((item) => (
                  <p className="mt-1 text-xs" key={item.order_id}>
                    {item.order_number}: {item.status}
                  </p>
                ))}
                <button className={`${BTN_SECONDARY} mt-3 h-9 px-3`} disabled={busy} onClick={() => void checkout()}>
                  Check again
                </button>
              </div>
            ) : result?.status === 'failed' ? (
              <div className="rounded-lg border p-4" data-testid="sale-failed">
                <h3 className="font-semibold text-navy">Sale not completed</h3>
                {result.items.map((item) => (
                  <p className="mt-1 text-xs" key={item.order_id}>
                    {item.order_number}: {checkoutOutcome(item.status)}
                    {item.error ? ` — ${item.error}` : ''}
                  </p>
                ))}
                <button
                  className={`${BTN_SECONDARY} mt-3 h-9 px-3`}
                  onClick={() => {
                    paymentMethod.current = null;
                    idempotencyKey.current = crypto.randomUUID();
                    definitiveFailure.current = false;
                    setResult(null);
                  }}
                >
                  Try another card
                </button>
              </div>
            ) : (
              <StripePaymentMethodForm
                publishableKey={context.publishable_key}
                stripeAccount={context.stripe_account_id!}
                amount={total}
                onReady={(handler) => {
                  action.current = handler;
                }}
                onPaymentMethod={checkout}
                submitLabel={`Charge ${formatCents(total)}`}
              />
            )}
          </div>
        ) : null}
        {step === 'done' && result ? (
          <div className="rounded-lg border bg-card p-6" data-testid="sale-completion">
            <h3 className="font-serif text-xl font-bold text-navy">
              {result.items.every((item) => item.status === 'paid') ? 'Sale complete' : 'Partly complete'}
            </h3>
            {result.items.map((item) => (
              <div key={item.order_id} className="mt-3 flex items-start justify-between gap-4 text-sm">
                <span>
                  {item.kind === 'subscription' ? 'Subscription' : 'Order'} {item.order_number}
                  <span className="ml-2 font-semibold">{checkoutOutcome(item.status)}</span>
                  {item.error ? <span className="mt-1 block text-xs text-destructive">{item.error}</span> : null}
                </span>
                <b>{formatCents(item.total_cents)}</b>
              </div>
            ))}
            {!result.items.every((item) => item.status === 'paid') ? (
              <button className={`${BTN_SECONDARY} mt-4 h-9 px-3`} disabled={busy} onClick={() => void checkout()}>
                Check again
              </button>
            ) : null}
          </div>
        ) : null}
        {step === 'qr' && cart ? (
          <div className="py-3 text-center" data-testid="sale-qr">
            <h3 className="font-serif text-xl font-bold text-navy">
              {cartPartlyPaid
                ? 'Partly paid'
                : cart.status === 'paid'
                  ? 'Paid'
                : cart.status === 'verified' || cart.status === 'checkout'
                  ? 'Phone verified'
                  : cart.status === 'open'
                    ? 'Waiting for patient'
                    : cart.status[0].toUpperCase() + cart.status.slice(1)}
            </h3>
            {cart.status === 'paid' || cartPartlyPaid || ['failed', 'expired', 'revoked', 'locked'].includes(cart.status) ? (
              cart.orders.map((order) => (
                <p key={order.order_id} className="mt-2 text-sm">
                  Order {order.order_number} · {checkoutOutcome(order.status)}
                </p>
              ))
            ) : (
              <>
                <img src={qr} alt="QR code for patient checkout" className="mx-auto mt-4 h-64 w-64" />
                <p className="mt-3 break-all text-sm">{cart.url}</p>
                <p className="mt-1 text-xs text-muted-foreground">Expires in {remaining} minutes</p>
                <div className="mt-4 flex justify-center gap-2">
                  <button className={`${BTN_SECONDARY} h-9 px-3`} onClick={() => void copyText(cart.url)}>
                    Copy link
                  </button>
                  <button
                    className={`${BTN_SECONDARY} h-9 px-3`}
                    onClick={() => void officeBilling.revokeCart(cart.id, office).then(setCart)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
