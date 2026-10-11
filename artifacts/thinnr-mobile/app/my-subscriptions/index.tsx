import React, { useCallback } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { BillingScreen, SectionLabel } from '@/components/billing/BillingScreen';
import { SubscriptionCard } from '@/components/billing/BillingPieces';
import { useBillingResource } from '@/components/billing/useBillingResource';
import { useColors } from '@/hooks/useColors';
import { listSubscriptions } from '@/lib/patient-billing-api';
import { subscriptionHref } from '@/lib/patient-billing-core';
import type { PatientSubscriptionDetail } from '@/lib/patient-billing-types';

export default function SubscriptionsScreen() {
  const colors = useColors();
  const load = useCallback(async (): Promise<PatientSubscriptionDetail[]> => (await listSubscriptions()).items, []);
  const subscriptions = useBillingResource<PatientSubscriptionDetail[]>(load, 'subscriptions');
  const rows = subscriptions.data ?? [];
  const current = rows.filter(row => row.status !== 'canceled');
  const ended = rows.filter(row => row.status === 'canceled');
  const open = (id: string) => router.push(subscriptionHref(id) as never);
  return (
    <BillingScreen
      title="Subscriptions"
      testID="screen-subscriptions"
      loading={subscriptions.loading}
      error={subscriptions.error}
      onRetry={() => void subscriptions.reload()}
      hasContent={subscriptions.data !== null}
    >
      <SectionLabel text="Your subscriptions" />
      {current.length ? current.map(subscription => (
        <SubscriptionCard key={subscription.id} subscription={subscription} onPress={() => open(subscription.id)} />
      )) : (
        <Text testID="text-subscriptions-empty" style={[styles.empty, { color: colors.subtleText }]}>
          No active subscriptions. Subscribe from your office’s shop to have products ship on a schedule.
        </Text>
      )}
      {ended.length ? (
        <>
          <SectionLabel text="Ended" />
          {ended.map(subscription => (
            <SubscriptionCard key={subscription.id} subscription={subscription} onPress={() => open(subscription.id)} />
          ))}
        </>
      ) : null}
    </BillingScreen>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, padding: 14, textAlign: 'center', fontFamily: 'Inter_500Medium' },
});
