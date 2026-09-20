import { useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { BTN_PRIMARY } from '@/components/patient/heritage';

const stripeInstances = new Map<string, PromiseLike<Stripe | null>>();

function stripeFor(publishableKey: string, stripeAccount: string) {
  const cacheKey = `${publishableKey}:${stripeAccount}`;
  let instance = stripeInstances.get(cacheKey);
  if (!instance) {
    instance = loadStripe(publishableKey, { stripeAccount });
    stripeInstances.set(cacheKey, instance);
  }
  return instance;
}

function PaymentForm({ returnUrl, onProcessing }: { returnUrl: string; onProcessing: (processing: boolean) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements || submitting) return;
    setSubmitting(true);
    setError(null);
    onProcessing(true);
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
    });
    if (result.error) setError(result.error.message ?? 'Your payment could not be completed. Please try again.');
    setSubmitting(false);
    onProcessing(false);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4" data-testid="stripe-payment-form">
      <PaymentElement />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        className={`h-11 w-full ${BTN_PRIMARY}`}
        disabled={!stripe || !elements || submitting}
        data-testid="button-pay"
      >
        {submitting ? 'Processing payment…' : 'Pay securely'}
      </button>
    </form>
  );
}

export function StripeElementsForm({
  publishableKey,
  stripeAccount,
  clientSecret,
  returnUrl,
  onProcessing = () => {},
}: {
  publishableKey: string;
  stripeAccount: string;
  clientSecret: string;
  returnUrl: string;
  onProcessing?: (processing: boolean) => void;
}) {
  const stripe = useMemo(() => stripeFor(publishableKey, stripeAccount), [publishableKey, stripeAccount]);
  const options = useMemo(
    () => ({
      clientSecret,
      appearance: {
        theme: 'stripe' as const,
        variables: {
          colorPrimary: '#3159a6',
          borderRadius: '6px',
          fontFamily: 'Inter, system-ui, sans-serif',
        },
      },
    }),
    [clientSecret],
  );

  return (
    <Elements key={`${publishableKey}:${stripeAccount}:${clientSecret}`} stripe={stripe} options={options}>
      <PaymentForm returnUrl={returnUrl} onProcessing={onProcessing} />
    </Elements>
  );
}
