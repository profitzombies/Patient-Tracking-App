/**
 * Order confirmation — reached only from a `paid` checkout answer. Shows
 * the order number(s), which subscriptions were started, and the amount
 * charged, then routes back into the app (Payments & orders keeps the
 * receipts). Reloading this URL without params shows a neutral message
 * rather than inventing an order.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { formatCents } from '@/lib/cart-math';
import { arrivalWindow } from '@/lib/patient-billing-core';

function list(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(',') : value ?? '';
  return raw.split(',').map(part => part.trim()).filter(Boolean);
}

export default function OrderConfirmationScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    orders?: string;
    subscriptions?: string;
    total?: string;
    office?: string;
    shippingMethod?: string;
    shippingSource?: string;
    windowStart?: string;
    windowEnd?: string;
  }>();
  const orders = list(params.orders);
  const subscriptions = list(params.subscriptions);
  const total = Number(params.total ?? '');
  const office = typeof params.office === 'string' ? params.office : '';
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const hasResult = orders.length > 0 || subscriptions.length > 0;
  const shippingLabel = params.shippingSource === 'fallback' || params.shippingMethod !== 'expedited'
    ? 'Standard shipping'
    : 'Expedited shipping';
  const window = params.shippingSource === 'live'
    ? arrivalWindow(
        typeof params.windowStart === 'string' ? params.windowStart : null,
        typeof params.windowEnd === 'string' ? params.windowEnd : null,
      )
    : null;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <View style={[styles.badge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
          <Feather name="check" size={26} color={colors.cobalt} />
        </View>
        <Text testID="confirmation-title" accessibilityRole="header" style={[styles.title, { color: colors.navy }]}>
          {hasResult ? 'Thank you' : 'No order to show'}
        </Text>
        <Text style={[styles.lead, { color: colors.bodyText }]}>
          {hasResult
            ? `Your payment to ${office || 'your office'} went through.${Number.isFinite(total) && total > 0 ? ` ${formatCents(total)} charged today.` : ''}`
            : 'Open Payments & orders to see your purchases.'}
        </Text>
        {hasResult ? (
          <Text testID="confirmation-shipping" style={[styles.shipping, { color: colors.bodyText }]}>
            {shippingLabel}{window ? ` · ${window}` : ''}
          </Text>
        ) : null}
        {orders.length ? (
          <LedgerCard testID="confirmation-orders" style={{ padding: 14, gap: 6, marginTop: 18 }}>
            <Text style={[styles.label, { color: colors.labelText }]}>{orders.length === 1 ? 'ORDER NUMBER' : 'ORDER NUMBERS'}</Text>
            {orders.map(number => (
              <Text key={number} testID={`confirmation-order-${number}`} style={[styles.value, { color: colors.navy }]}>{number}</Text>
            ))}
            <Text style={[styles.body, { color: colors.bodyText }]}>We’ll email your receipt. Shipping details follow once the office sends your order.</Text>
          </LedgerCard>
        ) : null}
        {subscriptions.length ? (
          <LedgerCard testID="confirmation-subscriptions" style={{ padding: 14, gap: 6, marginTop: 12 }}>
            <Text style={[styles.label, { color: colors.labelText }]}>
              {subscriptions.length === 1 ? 'SUBSCRIPTION STARTED' : 'SUBSCRIPTIONS STARTED'}
            </Text>
            {subscriptions.map(number => (
              <Text key={number} testID={`confirmation-subscription-${number}`} style={[styles.value, { color: colors.navy }]}>{number}</Text>
            ))}
            <Text style={[styles.body, { color: colors.bodyText }]}>
              The first delivery is paid. Renewals charge your saved card on schedule; change or cancel anytime from Payments & orders.
            </Text>
          </LedgerCard>
        ) : null}
        <PrimaryButton
          testID="confirmation-orders-link"
          label="View payments & orders"
          onPress={() => router.replace('/billing' as Href)}
          style={{ marginTop: 22 }}
        />
        <GhostButton testID="confirmation-done" label="Back to Today" onPress={() => router.replace('/today' as Href)} style={{ marginTop: 8 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, maxWidth: 520, width: '100%', alignSelf: 'center', paddingTop: 40 },
  badge: { width: 56, height: 56, borderRadius: 28, borderWidth: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  title: { fontSize: 26, fontFamily: 'PlayfairDisplay_700Bold', textAlign: 'center', marginTop: 18 },
  lead: { fontSize: 14, lineHeight: 20, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 8 },
  label: { fontSize: 9.5, letterSpacing: 1.2, fontFamily: 'Inter_700Bold' },
  value: { fontSize: 18, fontFamily: 'PlayfairDisplay_600SemiBold' },
  body: { fontSize: 12.5, lineHeight: 17, fontFamily: 'Inter_400Regular', marginTop: 4 },
  shipping: { fontSize: 12.5, lineHeight: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'center', marginTop: 8 },
});
