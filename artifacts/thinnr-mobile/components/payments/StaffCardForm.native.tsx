import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, InlineNotice } from "./primitives";
import type { StaffCardFormProps } from "./StaffCardForm";

export default function StaffCardForm({
  publishableKey,
  stripeAccount,
  onPaymentMethod,
  onReady,
  submitLabel = "Pay securely",
}: StaffCardFormProps) {
  const [sdk, setSdk] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    import("@stripe/stripe-react-native")
      .then((module) => {
        if (!current) return;
        module.initStripe({ publishableKey, stripeAccountId: stripeAccount });
        setSdk(module);
        onReady?.(async (clientSecret) => {
          const result = await module.handleNextAction(clientSecret);
          return result.error?.message ?? null;
        });
      })
      .catch(() =>
        setError(
          "Card entry is unavailable on this device. Choose the QR option instead.",
        ),
      );
    return () => {
      current = false;
    };
  }, [onReady, publishableKey, stripeAccount]);
  const submit = async () => {
    if (!sdk) return;
    setBusy(true);
    setError(null);
    try {
      const result = await sdk.createPaymentMethod({
        paymentMethodType: "Card",
      });
      if (result.error || !result.paymentMethod)
        throw new Error(
          result.error?.message ?? "Card details are incomplete.",
        );
      await onPaymentMethod(result.paymentMethod.id);
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
  const CardField = sdk?.CardField;
  return (
    <View testID="stripe-payment-method-form">
      {CardField ? (
        <CardField postalCodeEnabled style={{ width: "100%", height: 48 }} />
      ) : null}
      {error ? <InlineNotice tone="warn">{error}</InlineNotice> : null}
      <Button
        label={busy ? "Processing…" : submitLabel}
        onPress={() => void submit()}
        disabled={!sdk}
        busy={busy}
        variant="primary"
        testID="button-charge-card"
      />
    </View>
  );
}
