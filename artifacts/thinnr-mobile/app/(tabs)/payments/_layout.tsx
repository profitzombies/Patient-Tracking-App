/**
 * Payments area of the provider app: a stack nested under the Payments
 * destination of the provider launcher. Every section of the office web
 * payments area has a screen here; the section strip in the shared header
 * (components/payments/PaymentsScreen) moves between them, and the
 * transaction detail is the one pushed page with a back link.
 */
import React from 'react';
import { Stack } from 'expo-router';
import { PaymentsRangeProvider } from '@/components/payments/range';

export default function PaymentsLayout() {
  return (
    <PaymentsRangeProvider>
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" options={{ title: 'Payments overview' }} />
      <Stack.Screen name="activity" options={{ title: 'Payment activity' }} />
      <Stack.Screen name="transactions/index" options={{ title: 'Transactions' }} />
      <Stack.Screen name="transactions/[orderId]" options={{ title: 'Transaction' }} />
      <Stack.Screen name="refunds" options={{ title: 'Refunds and disputes' }} />
      <Stack.Screen name="fulfillment" options={{ title: 'Fulfillment' }} />
      <Stack.Screen name="subscriptions" options={{ title: 'Subscriptions' }} />
      <Stack.Screen name="payouts" options={{ title: 'Payouts' }} />
      <Stack.Screen name="links" options={{ title: 'Payment links' }} />
      <Stack.Screen name="prices" options={{ title: 'Prices' }} />
      <Stack.Screen name="get-paid" options={{ title: 'Get paid' }} />
      <Stack.Screen name="settings" options={{ title: 'Payment settings' }} />
    </Stack>
    </PaymentsRangeProvider>
  );
}
