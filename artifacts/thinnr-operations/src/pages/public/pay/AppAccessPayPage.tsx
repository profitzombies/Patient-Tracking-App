/**
 * Public app-access checkout: /pay/app-access/:token (+ /done, /cancelled).
 *
 * The token is minted by the patient's entitlement endpoint and opened from
 * the mobile app in an external browser, so there is no session here — the
 * token IS the patient's authorization. The page shows the office's price and
 * cadence, starts the subscription on the office's connected account and
 * confirms the first payment with Stripe Elements. Nothing ships.
 */
import { useEffect, useState } from 'react';
import { Link, Route, Switch, useParams, useSearch } from 'wouter';
import { SandboxBadge } from '@/components/billing/primitives';
import { StripeElementsForm } from '@/components/billing/StripeElementsForm';
import { BTN_PRIMARY, BTN_SECONDARY } from '@/components/patient/heritage';
import { formatCents, formatDate } from '@/lib/billing-format';
import { publicBilling } from '@/lib/billing-api';
import type { PublicAppAccessCheckout, PublicAppAccessOrderStatus, PublicAppAccessPreview } from '@/lib/billing-types';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-background px-4 py-8 text-foreground sm:py-12">
      <main className="mx-auto w-full max-w-[560px]">
        <Link href="~/" className="inline-block font-serif text-2xl font-bold tracking-[.04em] text-navy" aria-label="THINNR home">
          THINNR
        </Link>
        {children}
      </main>
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}

function Loading() {
  return <div className="mt-8 h-56 animate-pulse rounded-lg border border-border bg-card" aria-label="Loading subscription details" />;
}

const RETURN_TO_APP = "You're all set. Close this window and return to the THINNR app — your AI features unlock on the next check.";

function cadenceSentence(cadence: PublicAppAccessPreview['cadence']): string {
  return cadence === '2_weeks' ? 'every 2 weeks' : 'every month';
}

function CheckoutPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [preview, setPreview] = useState<PublicAppAccessPreview | null>(null);
  const [order, setOrder] = useState<PublicAppAccessCheckout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setPreview(null);
    publicBilling
      .appAccessPreview(token)
      .then((result) => { if (live) setPreview(result); })
      .catch((caught) => { if (live) setError(caught instanceof Error ? caught.message : 'This checkout link could not be loaded.'); });
    return () => { live = false; };
  }, [token]);

  const start = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setOrder(await publicBilling.appAccessCheckout(token, preview.billing_scope));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The subscription could not be started.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !preview) return <Frame><section className="mt-8"><Alert>{error}</Alert></section></Frame>;
  if (!preview) return <Frame><Loading /></Frame>;

  return (
    <Frame>
      <header className="mt-7 border-b border-border pb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Secure checkout</p>
            <h1 className="mt-2 font-serif text-3xl font-bold text-navy" data-testid="text-app-access-office">{preview.office_name}</h1>
          </div>
          <SandboxBadge sandbox={preview.sandbox} />
        </div>
      </header>
      {error ? <div className="mt-5"><Alert>{error}</Alert></div> : null}
      {preview.already_subscribed ? (
        <section className="mt-6 rounded-lg border border-border bg-card p-6" data-testid="app-access-already-subscribed">
          <h2 className="font-serif text-2xl font-bold text-navy">You already have an app subscription</h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Your premium AI features are covered. Manage the subscription from the THINNR app under Subscriptions.
          </p>
        </section>
      ) : (
        <>
          <section className="mt-6 rounded-lg border border-border bg-card p-5" data-testid="app-access-offer">
            <h2 className="font-serif text-xl font-bold text-navy">THINNR premium AI features</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The AI coach, photo and menu reads, and barcode lookup — billed by {preview.office_name}. Cancel any time from the app; access continues through the paid period.
            </p>
            <div className="mt-4 flex items-baseline justify-between border-t border-border pt-4">
              <span className="text-sm font-semibold text-navy">Price</span>
              <span className="text-sm" data-testid="text-app-access-price">
                <b className="text-lg text-navy">{formatCents(preview.price_cents)}</b> {cadenceSentence(preview.cadence)}
              </span>
            </div>
          </section>
          {order ? (
            <section className="mt-5 rounded-lg border border-border bg-card p-5 shadow-soft">
              <h2 className="mb-4 font-serif text-xl font-bold text-navy">Payment</h2>
              <StripeElementsForm
                publishableKey={order.publishable_key}
                stripeAccount={order.stripe_account_id}
                clientSecret={order.client_secret}
                returnUrl={`${window.location.origin}/pay/app-access/${encodeURIComponent(token)}/done?order=${encodeURIComponent(order.order_id)}`}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                First charge today; renews {cadenceSentence(order.cadence)}{order.renews_on ? `, next on ${formatDate(order.renews_on)}` : ''}.
              </p>
            </section>
          ) : (
            <button
              type="button"
              className={`${BTN_PRIMARY} mt-5 h-11 w-full`}
              data-testid="button-app-access-continue"
              disabled={busy}
              onClick={() => void start()}
            >
              {busy ? 'Preparing…' : `Subscribe for ${formatCents(preview.price_cents)} ${cadenceSentence(preview.cadence)}`}
            </button>
          )}
          <p className="mt-4 text-center text-xs text-muted-foreground">
            <Link href={`/app-access/${encodeURIComponent(token)}/cancelled`} className="underline" data-testid="link-app-access-not-now">Not now</Link>
          </p>
        </>
      )}
    </Frame>
  );
}

function DonePage() {
  const { token = '' } = useParams<{ token: string }>();
  const orderId = new URLSearchParams(useSearch()).get('order') ?? '';
  const [status, setStatus] = useState<PublicAppAccessOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!orderId) { setError('This confirmation link is incomplete.'); return; }
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const poll = async () => {
      try {
        const result = await publicBilling.appAccessOrderStatus(token, orderId);
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
    return () => { canceled = true; clearTimeout(timer); };
  }, [orderId, token, refresh]);

  if (error) return <Frame><section className="mt-8"><Alert>{error}</Alert></section></Frame>;
  if (!status) return <Frame><Loading /></Frame>;
  if (status.status === 'failed')
    return (
      <Frame>
        <section className="mt-8 rounded-lg border border-border bg-card p-6" data-testid="app-access-failed">
          <h1 className="font-serif text-2xl font-bold text-navy">Payment did not go through</h1>
          <p className="mt-3 text-sm text-muted-foreground">No payment was completed. You can return to checkout and try again.</p>
          <Link className={`mt-5 h-10 px-4 ${BTN_PRIMARY}`} href={`/app-access/${encodeURIComponent(token)}`}>Return to checkout</Link>
        </section>
      </Frame>
    );
  if (timedOut || status.status === 'pending')
    return (
      <Frame>
        <section className="mt-8 rounded-lg border border-border bg-card p-6" data-testid="app-access-pending">
          <h1 className="font-serif text-2xl font-bold text-navy">{timedOut ? 'Still confirming…' : 'Confirming your payment…'}</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {timedOut ? 'Your access unlocks as soon as the payment confirms. Refresh this page to check again.' : 'This usually takes only a moment.'}
          </p>
          {timedOut ? (
            <button type="button" className={`mt-5 h-10 px-4 ${BTN_SECONDARY}`} onClick={() => { setTimedOut(false); setRefresh((value) => value + 1); }}>
              Refresh status
            </button>
          ) : null}
        </section>
      </Frame>
    );
  return (
    <Frame>
      <section className="mt-8 rounded-lg border border-border bg-card p-6 shadow-soft" data-testid="app-access-receipt">
        <p className="text-[10px] font-bold uppercase tracking-[.14em] text-primary">Payment received</p>
        <h1 className="mt-2 font-serif text-3xl font-bold text-navy">Your AI features are unlocked</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Your receipt is on its way by email. You can view or cancel this subscription any time from the THINNR app under Subscriptions.
        </p>
        <p className="mt-5 text-sm text-muted-foreground" data-testid="text-return-to-app">{RETURN_TO_APP}</p>
      </section>
    </Frame>
  );
}

function CancelledPage() {
  const { token = '' } = useParams<{ token: string }>();
  return (
    <Frame>
      <section className="mt-8 rounded-lg border border-border bg-card p-6" data-testid="app-access-cancelled">
        <h1 className="font-serif text-2xl font-bold text-navy">No charge was made</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          You can subscribe later from the THINNR app whenever you want the AI features back. Food logging, your shop and messages with your care team keep working.
        </p>
        <Link className={`mt-5 h-10 px-4 ${BTN_SECONDARY}`} href={`/app-access/${encodeURIComponent(token)}`} data-testid="link-app-access-back">Back to checkout</Link>
      </section>
    </Frame>
  );
}

export default function AppAccessPayArea() {
  return (
    <Switch>
      <Route path="/app-access/:token/done" component={DonePage} />
      <Route path="/app-access/:token/cancelled" component={CancelledPage} />
      <Route path="/app-access/:token" component={CheckoutPage} />
    </Switch>
  );
}
