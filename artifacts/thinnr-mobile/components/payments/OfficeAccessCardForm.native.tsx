import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, InlineNotice } from './primitives';
import type { OfficeAccessCardFormProps } from './OfficeAccessCardForm';

export default function OfficeAccessCardForm({ intent, onConfirmed }: OfficeAccessCardFormProps) {
  const [sdk, setSdk] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    import('@stripe/stripe-react-native').then((module) => {
      if (!current) return;
      module.initStripe({ publishableKey: intent.publishableKey });
      setSdk(module);
    }).catch(() => setError('Secure card entry is unavailable on this device.'));
    return () => { current = false; };
  }, [intent.publishableKey]);
  const submit = async () => {
    if (!sdk) return;
    setBusy(true);
    setError(null);
    try {
      let paymentMethodId: string | undefined;
      if (intent.slot === 'bank') {
        const initialized = await sdk.initPaymentSheet({
          merchantDisplayName: 'THINNR',
          setupIntentClientSecret: intent.clientSecret,
        });
        if (initialized.error) throw new Error(initialized.error.message);
        const presented = await sdk.presentPaymentSheet();
        if (presented.error) throw new Error(presented.error.message);
        const retrieved = await sdk.retrieveSetupIntent(intent.clientSecret);
        paymentMethodId = retrieved.setupIntent?.paymentMethodId;
        if (retrieved.error) throw new Error(retrieved.error.message);
      } else {
        const result = await sdk.confirmSetupIntent(intent.clientSecret, {
          paymentMethodType: 'Card',
        });
        paymentMethodId = result.setupIntent?.paymentMethodId;
        if (result.error) throw new Error(result.error.message);
      }
      if (!paymentMethodId) throw new Error('The payment method could not be confirmed.');
      await onConfirmed(paymentMethodId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The card could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  const CardField = sdk?.CardField;
  return (
    <View style={{ gap: 10 }} testID="office-stripe-card-form">
      {intent.slot !== 'bank' && CardField ? <CardField postalCodeEnabled style={{ width: '100%', height: 48 }} /> : null}
      {error ? <InlineNotice tone="bad" testID="office-card-error">{error}</InlineNotice> : null}
      <Button label={intent.slot === 'bank' ? 'Choose bank account' : 'Save card'} testID="button-save-office-card" variant="primary" busy={busy} disabled={!sdk} onPress={() => void submit()} />
    </View>
  );
}