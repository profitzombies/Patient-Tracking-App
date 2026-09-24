import React, { useState } from 'react';
import { Button, InlineNotice } from './primitives';
import { getStaffCardBridgeForTests } from '@/lib/staff-card-bridge';
import type { OfficeAccessSetupIntent } from '@/lib/office-access-types';

export interface OfficeAccessCardFormProps {
  intent: OfficeAccessSetupIntent;
  onConfirmed: (paymentMethodId: string) => Promise<void>;
}

/** Node verification fallback; Metro selects the native/web Stripe implementation. */
export default function OfficeAccessCardForm({
  onConfirmed,
}: OfficeAccessCardFormProps) {
  const bridge = getStaffCardBridgeForTests();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!bridge?.createPaymentMethod) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirmed(await bridge.createPaymentMethod());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The card could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {error ? <InlineNotice tone="bad" testID="office-card-error">{error}</InlineNotice> : null}
      <Button
        label="Save payment method"
        testID="button-save-office-card"
        variant="primary"
        busy={busy}
        disabled={!bridge?.createPaymentMethod}
        onPress={() => void submit()}
      />
    </>
  );
}