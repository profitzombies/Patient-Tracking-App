/**
 * Card entry — WEB build on Stripe.js (CardElement). The native build is
 * StripeCardEntry.tsx; both implement CardEntryHandle so checkout never
 * branches on platform. React Native Web renders real DOM, so the Stripe
 * iframe element mounts directly inside the RN View.
 *
 * Stripe.js instances are cached per publishable key + connected account:
 * loadStripe injects the script once, and every PaymentMethod is created on
 * the office's account (stripeAccount) where the server confirms it.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { CardElement, Elements, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useColors } from '@/hooks/useColors';
import {
  CARD_ENTRY_UNAVAILABLE,
  type CardBillingDetails,
  type CardEntryHandle,
  type CardEntryProps,
  type NextActionOutcome,
} from './card-entry-types';

const instances = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string, stripeAccount: string): Promise<Stripe | null> {
  const cacheKey = `${publishableKey}:${stripeAccount}`;
  let instance = instances.get(cacheKey);
  if (!instance) {
    instance = loadStripe(publishableKey, { stripeAccount }).catch(() => null);
    instances.set(cacheKey, instance);
  }
  return instance;
}

const Inner = forwardRef<CardEntryHandle, Omit<CardEntryProps, 'config'>>(function Inner(
  { onChange, disabled, hidden, testID },
  ref,
) {
  const colors = useColors();
  const stripe = useStripe();
  const elements = useElements();
  const complete = useRef(false);
  const [focused, setFocused] = useState(false);

  useImperativeHandle(ref, () => ({
    async createPaymentMethod(billing: CardBillingDetails) {
      const card = elements?.getElement(CardElement);
      if (!stripe || !card) throw new Error(CARD_ENTRY_UNAVAILABLE);
      if (!complete.current) throw new Error('Enter your full card details to continue.');
      const result = await stripe.createPaymentMethod({
        type: 'card',
        card,
        billing_details: {
          name: billing.name,
          ...(billing.email ? { email: billing.email } : {}),
          ...(billing.phone ? { phone: billing.phone } : {}),
          address: {
            line1: billing.address.line1,
            ...(billing.address.line2 ? { line2: billing.address.line2 } : {}),
            city: billing.address.city,
            state: billing.address.state,
            postal_code: billing.address.postal_code,
            country: billing.address.country,
          },
        },
      });
      if (result.error) throw new Error(result.error.message ?? 'Your card couldn’t be used. Try another card.');
      return { paymentMethodId: result.paymentMethod.id };
    },
    async handleNextAction(clientSecret: string): Promise<NextActionOutcome> {
      if (!stripe) throw new Error(CARD_ENTRY_UNAVAILABLE);
      const result = await stripe.handleNextAction({ clientSecret });
      if (result.error) throw new Error(result.error.message ?? 'Your bank didn’t approve the payment.');
      const status = result.paymentIntent?.status;
      if (status === 'succeeded') return 'succeeded';
      if (status === 'processing') return 'processing';
      if (status === 'requires_payment_method') return 'requires_payment_method';
      return 'failed';
    },
  }), [stripe, elements]);

  return (
    <View
      testID={testID}
      accessibilityLabel="Card details"
      aria-hidden={hidden}
      style={[
        styles.frame,
        hidden && styles.hidden,
        {
          backgroundColor: colors.card,
          borderColor: focused ? colors.cobalt : colors.border,
          borderRadius: colors.radiusSm,
          opacity: disabled ? 0.6 : 1,
        },
      ]}
    >
      <CardElement
        options={{
          hidePostalCode: true,
          disabled,
          style: {
            base: {
              fontSize: '15px',
              color: colors.navy,
              fontFamily: 'Inter, system-ui, sans-serif',
              '::placeholder': { color: colors.subtleText },
            },
            invalid: { color: colors.destructive },
          },
        }}
        onChange={event => {
          complete.current = event.complete;
          onChange?.(event.complete);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </View>
  );
});

export const StripeCardEntry = forwardRef<CardEntryHandle, CardEntryProps>(function StripeCardEntry(
  { config, onError, ...rest },
  ref,
) {
  const stripe = useMemo(() => stripeFor(config.publishableKey, config.stripeAccountId), [config.publishableKey, config.stripeAccountId]);
  useEffect(() => {
    let cancelled = false;
    void stripe.then(instance => {
      if (!cancelled && !instance) onError?.(CARD_ENTRY_UNAVAILABLE);
    });
    return () => { cancelled = true; };
  }, [stripe, onError]);
  return (
    <Elements stripe={stripe}>
      <Inner ref={ref} {...rest} />
    </Elements>
  );
});

const styles = StyleSheet.create({
  frame: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 13,
    minHeight: 48,
    justifyContent: 'center',
  },
  hidden: { display: 'none' },
});
