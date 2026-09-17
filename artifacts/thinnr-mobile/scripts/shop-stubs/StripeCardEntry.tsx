/**
 * Scripted stand-in for components/shop/StripeCardEntry (mapped by
 * tsconfig.shop.json). The suite decides what "the card SDK" answers:
 * `cardScript.createPaymentMethod` / `handleNextAction` are swapped per
 * scenario, and `cardScript.setComplete(true)` plays the patient finishing
 * the card fields. Mounts are counted so the suite can prove demo checkout
 * never loads card entry.
 */
import React, { forwardRef, useEffect, useImperativeHandle } from 'react';
import type { CardBillingDetails, CardEntryHandle, CardEntryProps, NextActionOutcome } from '../../components/shop/card-entry-types';

export const cardScript = {
  mounts: 0,
  configs: [] as CardEntryProps['config'][],
  billing: [] as CardBillingDetails[],
  nextActions: [] as string[],
  createPaymentMethod: async (_billing: CardBillingDetails): Promise<{ paymentMethodId: string }> => ({ paymentMethodId: 'pm_test_new' }),
  handleNextAction: async (_secret: string): Promise<NextActionOutcome> => 'succeeded',
  setComplete: (_complete: boolean): void => undefined,
};

export const StripeCardEntry = forwardRef<CardEntryHandle, CardEntryProps>(function StripeCardEntry(props, ref) {
  useEffect(() => { cardScript.mounts += 1; }, []);
  useEffect(() => {
    cardScript.configs.push(props.config);
    cardScript.setComplete = (complete: boolean) => props.onChange?.(complete);
    return () => { cardScript.setComplete = () => undefined; };
  }, [props.config, props.onChange]);
  useImperativeHandle(ref, () => ({
    createPaymentMethod: billing => {
      cardScript.billing.push(billing);
      return cardScript.createPaymentMethod(billing);
    },
    handleNextAction: secret => {
      cardScript.nextActions.push(secret);
      return cardScript.handleNextAction(secret);
    },
  }), []);
  return React.createElement('CardEntry', { testID: props.testID, disabled: props.disabled, hidden: props.hidden });
});
