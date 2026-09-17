/**
 * Card entry — NATIVE build (iOS / Android) on the Stripe React Native SDK.
 * The web build is StripeCardEntry.web.tsx; both implement CardEntryHandle
 * (see card-entry-types.ts) so checkout never branches on platform.
 *
 * StripeProvider is scoped to this component with the office's connected
 * account so the PaymentMethod lands where the server confirms it.
 */
import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CardField, StripeProvider, useStripe, type CardFieldInput } from '@stripe/stripe-react-native';
import { useColors } from '@/hooks/useColors';
import type { CardBillingDetails, CardEntryHandle, CardEntryProps, NextActionOutcome } from './card-entry-types';

const Inner = forwardRef<CardEntryHandle, Omit<CardEntryProps, 'config'>>(function Inner(
  { onChange, disabled, hidden, testID },
  ref,
) {
  const colors = useColors();
  const stripe = useStripe();
  const [complete, setComplete] = useState(false);
  const details = useRef<CardFieldInput.Details | null>(null);

  useImperativeHandle(ref, () => ({
    async createPaymentMethod(billing: CardBillingDetails) {
      if (!details.current?.complete) throw new Error('Enter your full card details to continue.');
      const result = await stripe.createPaymentMethod({
        paymentMethodType: 'Card',
        paymentMethodData: {
          billingDetails: {
            name: billing.name,
            ...(billing.email ? { email: billing.email } : {}),
            ...(billing.phone ? { phone: billing.phone } : {}),
            address: {
              line1: billing.address.line1,
              ...(billing.address.line2 ? { line2: billing.address.line2 } : {}),
              city: billing.address.city,
              state: billing.address.state,
              postalCode: billing.address.postal_code,
              country: billing.address.country,
            },
          },
        },
      });
      if (result.error) throw new Error(result.error.localizedMessage ?? result.error.message);
      return { paymentMethodId: result.paymentMethod.id };
    },
    async handleNextAction(clientSecret: string): Promise<NextActionOutcome> {
      const result = await stripe.handleNextAction(clientSecret);
      if (result.error) throw new Error(result.error.localizedMessage ?? result.error.message);
      const status = String(result.paymentIntent.status);
      if (status === 'Succeeded') return 'succeeded';
      if (status === 'Processing') return 'processing';
      if (status === 'RequiresPaymentMethod') return 'requires_payment_method';
      return 'failed';
    },
  }), [stripe]);

  return (
    <View
      testID={testID}
      accessibilityLabel="Card details"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={hidden ? styles.hidden : undefined}
    >
      <CardField
        testID={testID ? `${testID}-field` : undefined}
        postalCodeEnabled={false}
        disabled={disabled}
        placeholders={{ number: '4242 4242 4242 4242' }}
        cardStyle={{
          backgroundColor: colors.card,
          textColor: colors.navy,
          placeholderColor: colors.subtleText,
          borderColor: complete ? colors.cobalt : colors.border,
          borderWidth: 1,
          borderRadius: colors.radiusSm,
          fontSize: 15,
        }}
        style={styles.field}
        onCardChange={card => {
          details.current = card;
          setComplete(card.complete);
          onChange?.(card.complete);
        }}
      />
    </View>
  );
});

export const StripeCardEntry = forwardRef<CardEntryHandle, CardEntryProps>(function StripeCardEntry(
  { config, ...rest },
  ref,
) {
  return (
    <StripeProvider
      publishableKey={config.publishableKey}
      stripeAccountId={config.stripeAccountId}
      merchantIdentifier="merchant.com.thinnr.mobile"
    >
      <Inner ref={ref} {...rest} />
    </StripeProvider>
  );
});

const styles = StyleSheet.create({
  field: {
    width: '100%',
    height: 48,
  },
  hidden: { height: 0, overflow: 'hidden', opacity: 0 },
});
