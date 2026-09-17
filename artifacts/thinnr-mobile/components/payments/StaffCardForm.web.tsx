import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import {
  loadStripe,
  type Stripe,
  type StripeElements,
} from "@stripe/stripe-js";
import { Button, InlineNotice } from "./primitives";
import type { StaffCardFormProps } from "./StaffCardForm";

const instances = new Map<string, PromiseLike<Stripe | null>>();
function stripeFor(key: string, account: string) {
  const cacheKey = `${key}:${account}`;
  let value = instances.get(cacheKey);
  if (!value) {
    value = loadStripe(key, { stripeAccount: account });
    instances.set(cacheKey, value);
  }
  return value;
}

export default function StaffCardForm({
  publishableKey,
  stripeAccount,
  amount,
  onPaymentMethod,
  onReady,
  submitLabel = "Pay securely",
}: StaffCardFormProps) {
  const host = useRef<HTMLElement | null>(null);
  const stripe = useRef<Stripe | null>(null);
  const elements = useRef<StripeElements | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    let payment: {
      mount: (host: HTMLElement) => void;
      destroy: () => void;
    } | null = null;
    void Promise.resolve(stripeFor(publishableKey, stripeAccount)).then(
      (loaded) => {
        if (!current || !loaded || !host.current) return;
        stripe.current = loaded;
        elements.current = loaded.elements({
          mode: "payment",
          amount: Math.max(50, amount),
          currency: "usd",
          setupFutureUsage: "off_session",
          paymentMethodCreation: "manual",
          appearance: {
            theme: "stripe",
            variables: {
              colorPrimary: "#3159a6",
              borderRadius: "6px",
              fontFamily: "Inter, system-ui, sans-serif",
            },
          },
        });
        const paymentElement = elements.current.create("payment");
        payment = paymentElement;
        paymentElement.mount(host.current);
        onReady?.(async (clientSecret) => {
          const result = await loaded.handleNextAction({ clientSecret });
          return result.error?.message ?? null;
        });
        setReady(true);
      },
    );
    return () => {
      current = false;
      payment?.destroy();
    };
  }, [amount, onReady, publishableKey, stripeAccount]);
  const submit = async () => {
    if (!stripe.current || !elements.current) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await elements.current.submit();
      if (submitted.error) throw new Error(submitted.error.message);
      const made = await stripe.current.createPaymentMethod({
        elements: elements.current,
      });
      if (made.error || !made.paymentMethod)
        throw new Error(made.error?.message ?? "Card details are incomplete.");
      await onPaymentMethod(made.paymentMethod.id);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your card could not be prepared. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View testID="stripe-payment-method-form">
      <div
        ref={(node) => {
          host.current = node;
        }}
      />
      {error ? <InlineNotice tone="bad">{error}</InlineNotice> : null}
      <Button
        label={busy ? "Processing…" : submitLabel}
        onPress={() => void submit()}
        disabled={!ready}
        busy={busy}
        variant="primary"
        testID="button-charge-card"
      />
      {busy ? (
        <InlineNotice>
          Charging the card and setting up the order. This can take up to half a
          minute; keep this window open.
        </InlineNotice>
      ) : null}
    </View>
  );
}
