import React, { useCallback, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { BillingScreen, SectionLabel } from '@/components/billing/BillingScreen';
import { OrderCard } from '@/components/billing/BillingPieces';
import { useBillingResource } from '@/components/billing/useBillingResource';
import { ErrorBox, GhostButton } from '@/components/onboarding/OnboardingFields';
import { DEMO_ORDERS } from '@/data/patient-billing-demo';
import { useColors } from '@/hooks/useColors';
import { listOrders } from '@/lib/patient-billing-api';
import { errorMessage, orderHref } from '@/lib/patient-billing-core';
import type { PatientOrderList } from '@/lib/patient-billing-types';

const PAGE_SIZE = 20;

export default function OrdersScreen() {
  const colors = useColors();
  const load = useCallback((): Promise<PatientOrderList> => listOrders(null, PAGE_SIZE), []);
  const orders = useBillingResource<PatientOrderList>(load, () => ({ items: DEMO_ORDERS, next_cursor: null }));
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const rows = orders.data?.items ?? [];
  const cursor = orders.data?.next_cursor ?? null;

  // Older pages append to what is already on screen; a failed page keeps the
  // loaded history and offers the same button again.
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listOrders(cursor, PAGE_SIZE);
      orders.setData(current => {
        if (!current) return page;
        const seen = new Set(current.items.map(order => order.id));
        return { items: [...current.items, ...page.items.filter(order => !seen.has(order.id))], next_cursor: page.next_cursor };
      });
    } catch (caught) {
      setMoreError(errorMessage(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <BillingScreen
      title="Orders"
      testID="screen-orders"
      loading={orders.loading}
      error={orders.error}
      onRetry={() => void orders.reload()}
      hasContent={orders.data !== null}
      demo={orders.demo}
    >
      <SectionLabel text="Order history" />
      {rows.length ? rows.map(order => (
        <OrderCard key={order.id} order={order} onPress={() => router.push(orderHref(order.id) as never)} />
      )) : (
        <Text testID="text-orders-empty" style={[styles.empty, { color: colors.subtleText }]}>
          No orders yet. Anything you buy from your office shows up here.
        </Text>
      )}
      {moreError ? <ErrorBox testID="text-orders-more-error" message={moreError} /> : null}
      {cursor ? (
        <GhostButton
          testID="button-orders-more"
          label={loadingMore ? 'Loading…' : 'Show older orders'}
          accessibilityLabel="Show older orders"
          disabled={loadingMore}
          onPress={() => void loadMore()}
          style={styles.more}
        />
      ) : null}
    </BillingScreen>
  );
}

const styles = StyleSheet.create({
  empty: { fontSize: 13, padding: 14, textAlign: 'center', fontFamily: 'Inter_500Medium' },
  more: { marginTop: 12 },
});
