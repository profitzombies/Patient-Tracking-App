import { useEffect, useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { BTN_PRIMARY } from '@/components/patient/heritage';

const stripeInstances = new Map<string, PromiseLike<Stripe | null>>();

function stripeFor(publishableKey: string, stripeAccount: string) {
  const key = `${publishableKey}:${stripeAccount}`;
  let stripe = stripeInstances.get(key);
  if (!stripe) {
    stripe = loadStripe(publishableKey, { stripeAccount });
    stripeInstances.set(key, stripe);
  }
  return stripe;
}

export type HandleNextAction = (clientSecret: string) => Promise<string | null>;

function Form({
  onPaymentMethod,
  onReady,
  submitLabel,
}: {
  onPaymentMethod: (paymentMethodId: string) => Promise<void> | void;
  onReady?: (handler: HandleNextAction) => void;
  submitLabel: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!stripe || !onReady) return;
    onReady(async (clientSecret) => {
      const result = await stripe.handleNextAction({ clientSecret });
      return result.error?.message ?? null;
    });
  }, [stripe, onReady]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await elements.submit();
      if (submitted.error) throw new Error(submitted.error.message);
      const created = await stripe.createPaymentMethod({ elements });
      if (created.error || !created.paymentMethod)
        throw new Error(created.error?.message ?? 'Card details are incomplete.');
      await onPaymentMethod(created.paymentMethod.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your card could not be prepared. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)} data-testid="stripe-payment-method-form">
      <PaymentElement />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className={`h-11 w-full ${BTN_PRIMARY}`} disabled={!stripe || !elements || busy}>
        {busy ? 'Processing…' : submitLabel}
      </button>
      {busy ? (
        <p className="text-center text-xs text-muted-foreground" aria-live="polite">
          Charging the card and setting up the order. This can take up to half a minute; keep this window open.
        </p>
      ) : null}
    </form>
  );
}

export function StripePaymentMethodForm({
  publishableKey,
  stripeAccount,
  amount,
  onPaymentMethod,
  onReady,
  submitLabel = 'Pay securely',
}: {
  publishableKey: string;
  stripeAccount: string;
  amount: number;
  onPaymentMethod: (paymentMethodId: string) => Promise<void> | void;
  onReady?: (handler: HandleNextAction) => void;
  submitLabel?: string;
}) {
  const stripe = useMemo(() => stripeFor(publishableKey, stripeAccount), [publishableKey, stripeAccount]);
  const options = useMemo(
    () => ({
      mode: 'payment' as const,
      amount: Math.max(50, amount),
      currency: 'usd',
      setupFutureUsage: 'off_session' as const,
      // createPaymentMethod({ elements }) is only allowed on a manual-creation instance.
      paymentMethodCreation: 'manual' as const,
      appearance: {
        theme: 'stripe' as const,
        variables: {
          colorPrimary: '#3159a6',
          borderRadius: '6px',
          fontFamily: 'Inter, system-ui, sans-serif',
        },
      },
    }),
    [amount],
  );
  return (
    <Elements stripe={stripe} options={options}>
      <Form onPaymentMethod={onPaymentMethod} onReady={onReady} submitLabel={submitLabel} />
    </Elements>
  );
}
