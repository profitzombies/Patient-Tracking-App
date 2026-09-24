import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';
import { Button, InlineNotice } from './primitives';
import type { OfficeAccessCardFormProps } from './OfficeAccessCardForm';

export default function OfficeAccessCardForm({ intent, onConfirmed }: OfficeAccessCardFormProps) {
  const host = useRef<HTMLElement | null>(null);
  const stripe = useRef<Stripe | null>(null);
  const elements = useRef<StripeElements | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let payment: { mount: (node: HTMLElement) => void; destroy: () => void } | null = null;
    void loadStripe(intent.publishableKey).then((loaded) => {
      if (!mounted || !loaded || !host.current) return;
      stripe.current = loaded;
      elements.current = loaded.elements({ clientSecret: intent.clientSecret });
      const paymentElement = elements.current.create('payment');
      payment = paymentElement;
      paymentElement.mount(host.current);
      setReady(true);
    });
    return () => { mounted = false; payment?.destroy(); };
  }, [intent.clientSecret, intent.publishableKey]);
  const submit = async () => {
    if (!stripe.current || !elements.current) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await elements.current.submit();
      if (submitted.error) throw new Error(submitted.error.message);
      const result = await stripe.current.confirmSetup({
        elements: elements.current,
        clientSecret: intent.clientSecret,
        redirect: 'if_required',
      });
      const paymentMethod = result.setupIntent?.payment_method;
      const paymentMethodId = typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id;
      if (result.error || !paymentMethodId) {
        throw new Error(result.error?.message ?? 'The card could not be saved.');
      }
      await onConfirmed(paymentMethodId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The card could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 10 }} testID="office-stripe-card-form">
      <div ref={(node) => { host.current = node; }} />
      {error ? <InlineNotice tone="bad" testID="office-card-error">{error}</InlineNotice> : null}
      <Button label="Save card" testID="button-save-office-card" variant="primary" busy={busy} disabled={!ready} onPress={() => void submit()} />
    </View>
  );
}