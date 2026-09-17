import React, { useEffect, useState } from "react";
import { Button, InlineNotice } from "./primitives";
import {
  getStaffCardBridgeForTests,
  type HandleNextAction,
} from "@/lib/staff-card-bridge";

export interface StaffCardFormProps {
  publishableKey: string;
  stripeAccount: string;
  amount: number;
  onPaymentMethod: (paymentMethodId: string) => Promise<void> | void;
  onReady?: (handler: HandleNextAction) => void;
  submitLabel?: string;
}

/**
 * Node verification fallback. Metro selects StaffCardForm.web/native in real
 * builds; this implementation also provides the intentionally small test seam.
 */
export default function StaffCardForm({
  onPaymentMethod,
  onReady,
  submitLabel = "Pay securely",
}: StaffCardFormProps) {
  const bridge = getStaffCardBridgeForTests();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (bridge?.handleNextAction) onReady?.(bridge.handleNextAction);
  }, [bridge, onReady]);
  const submit = async () => {
    if (!bridge?.createPaymentMethod) return;
    setBusy(true);
    setError(null);
    try {
      await onPaymentMethod(await bridge.createPaymentMethod());
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
    <>
      {error ? (
        <InlineNotice tone="bad" testID="staff-card-error">
          {error}
        </InlineNotice>
      ) : null}
      {!bridge?.createPaymentMethod ? (
        <InlineNotice tone="warn">
          Card entry is unavailable on this device. Choose the QR option
          instead.
        </InlineNotice>
      ) : null}
      <Button
        label={busy ? "Processing…" : submitLabel}
        onPress={() => void submit()}
        busy={busy}
        disabled={!bridge?.createPaymentMethod}
        variant="primary"
        testID="button-charge-card"
      />
      {busy ? (
        <InlineNotice>
          Charging the card and setting up the order. This can take up to half a
          minute; keep this window open.
        </InlineNotice>
      ) : null}
    </>
  );
}
