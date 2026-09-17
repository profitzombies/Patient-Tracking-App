import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { PriceRow, ShopHeader } from '@/components/shop/ShopChrome';
import { useCareTeamChat } from '@/context/CareTeamChatContext';
import { useCart } from '@/context/CartContext';
import { useColors } from '@/hooks/useColors';
import {
  cadenceLabel,
  clampQuantity,
  formatCents,
  localQuote,
  toQuoteRequest,
  type CartLine,
} from '@/lib/cart-math';
import { quoteCart } from '@/lib/patient-billing-api';
import { buildDemoShop, findShopProduct } from '@/lib/shop-catalog';
import type { CartQuote } from '@/lib/patient-billing-types';

export default function CareTeamBundleScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ clientId?: string | string[] }>();
  const clientId = Array.isArray(params.clientId) ? params.clientId[0] : params.clientId;
  const { messages } = useCareTeamChat();
  const cart = useCart();
  const message = messages.find(item => item.clientId === clientId);
  const suggestion = message?.sender === 'care_team' && message.suggestion?.mode === 'bundle'
    ? message.suggestion
    : null;
  const shop = useMemo(
    () => cart.shop ?? (cart.demo ? buildDemoShop() : null),
    [cart.demo, cart.shop],
  );

  useEffect(() => {
    if (cart.shopStatus === 'idle') void cart.loadShop();
  }, [cart.shopStatus, cart.loadShop]);

  const prepared = useMemo(() => {
    if (!suggestion || !shop?.available) return { lines: [] as CartLine[], unavailable: new Set<string>() };
    const unavailable = new Set<string>();
    const lines: CartLine[] = [];
    for (const item of suggestion.items) {
      const product = findShopProduct(shop.products, item.productId) ??
        findShopProduct(shop.products, item.slug);
      const canSubscribe = product?.subscription_available &&
        product.subscription_unit_price_cents !== null &&
        product.subscription_cadences_weeks.includes(item.cadenceWeeks as never);
      if (!product || (item.purchase === 'subscription' && !canSubscribe)) {
        unavailable.add(`${item.productId}:${item.purchase}`);
        continue;
      }
      lines.push({
        product_id: product.product_id,
        purchase: item.purchase,
        cadence_weeks: item.purchase === 'subscription' ? item.cadenceWeeks : null,
        quantity: clampQuantity(item.quantity),
      });
    }
    return { lines, unavailable };
  }, [shop, suggestion]);

  const estimate = useMemo(() => {
    if (!shop?.available) return null;
    return localQuote(prepared.lines, shop.products, shop.shipping_charge_cents, shop.tax_enabled);
  }, [shop, prepared.lines]);
  const [liveQuote, setLiveQuote] = useState<CartQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  useEffect(() => {
    setLiveQuote(null);
    setQuoteError(null);
    if (cart.demo || prepared.lines.length === 0) return;
    let active = true;
    void quoteCart(toQuoteRequest(prepared.lines))
      .then(quote => {
        if (active) setLiveQuote(quote);
      })
      .catch(caught => {
        if (active) setQuoteError(caught instanceof Error && caught.message
          ? caught.message
          : 'Couldn’t refresh this bundle total.');
      });
    return () => {
      active = false;
    };
  }, [cart.demo, prepared.lines]);

  const quote = cart.demo ? estimate : liveQuote;
  // The rows show the prices your care team saw when they sent the bundle;
  // the summary is today's pricing. Say so when the two no longer agree.
  const sentSubtotal = suggestion
    ? suggestion.items
      .filter(item => !prepared.unavailable.has(`${item.productId}:${item.purchase}`))
      .reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0)
    : 0;
  const pricesChanged = quote !== null && quote !== undefined && quote.subtotal_cents !== sentSubtotal;
  const installLines = () => {
    const result = cart.replaceLines(prepared.lines);
    if (!result.ok) return;
    router.push('/checkout' as Href);
  };
  const checkout = () => {
    if (cart.lines.length === 0) {
      installLines();
      return;
    }
    const message = 'Checking out this bundle will replace the items currently in your cart.';
    if (Platform.OS === 'web') {
      if (globalThis.window?.confirm(message)) installLines();
      return;
    }
    Alert.alert('Replace your cart?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace and continue', onPress: installLines },
    ]);
  };

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  if (!suggestion) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
        <ShopHeader title="Care team bundle" testIDPrefix="bundle" backFallback={'/care-team-chat' as Href} />
        <View testID="care-team-bundle-missing" style={styles.missing}>
          <Text style={[styles.missingTitle, { color: colors.navy }]}>This bundle isn't available anymore</Text>
          <GhostButton label="Back to care team chat" onPress={() => router.replace('/care-team-chat' as Href)} />
        </View>
      </View>
    );
  }

  const checkoutDisabled = cart.locked || prepared.lines.length === 0 || (!cart.demo && !quote);
  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <ShopHeader title="Care team bundle" testIDPrefix="bundle" backFallback={'/care-team-chat' as Href} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <SectionHeader label="Recommended by your care team" />
        <LedgerCard testID="care-team-bundle-summary" style={{ paddingVertical: 4 }}>
          {suggestion.items.map((item, index) => {
            const unavailable = prepared.unavailable.has(`${item.productId}:${item.purchase}`);
            return (
              <View key={`${item.productId}:${item.purchase}`}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.itemRow}>
                  <View style={styles.itemText}>
                    <Text style={[styles.itemName, { color: colors.navy }, unavailable && styles.struck]}>
                      {item.name}
                    </Text>
                    <Text style={[styles.itemDetail, { color: colors.bodyText }]}>
                      {item.purchase === 'subscription' ? cadenceLabel(item.cadenceWeeks) : 'One-time'} · ×{item.quantity}
                    </Text>
                    {unavailable ? (
                      <Text style={[styles.unavailable, { color: colors.riskText }]}>not available right now</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.itemPrice, { color: colors.navy }, unavailable && styles.struck]}>
                    {formatCents(item.unitPriceCents * item.quantity)}
                  </Text>
                </View>
              </View>
            );
          })}
        </LedgerCard>

        <SectionHeader label="Summary" style={styles.sectionGap} />
        <LedgerCard style={{ padding: 14 }}>
          <PriceRow label="Items" cents={quote?.subtotal_cents ?? suggestion.totalCents} />
          {quote ? <PriceRow label="Shipping" cents={quote.shipping_charge_cents} /> : null}
          {quote?.tax_cents !== null && quote?.tax_cents !== undefined
            ? <PriceRow label="Tax" cents={quote.tax_cents} />
            : null}
          <Divider style={{ marginVertical: 7 }} />
          <PriceRow
            label={quote?.tax_enabled && quote.tax_cents === null ? 'Total before tax' : 'Total'}
            cents={quote?.total_due_cents ?? quote?.total_cents ?? suggestion.totalCents}
            strong
            testID="care-team-bundle-total"
          />
          {pricesChanged ? (
            <Text testID="care-team-bundle-prices-changed" style={[styles.locked, { color: colors.bodyText }]}>
              Prices have changed since your care team sent this bundle. The summary shows today's prices.
            </Text>
          ) : null}
          {quoteError ? <Text style={[styles.error, { color: colors.riskText }]}>{quoteError}</Text> : null}
          {cart.locked ? (
            <Text testID="care-team-bundle-locked" style={[styles.locked, { color: colors.bodyText }]}>
              Your last payment attempt hasn't been confirmed yet. Your cart can't change until it settles.
            </Text>
          ) : null}
          <PrimaryButton
            testID="care-team-bundle-checkout"
            label="Check out"
            disabled={checkoutDisabled}
            onPress={checkout}
            style={styles.checkout}
          />
        </LedgerCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  missing: { alignItems: 'center', gap: 16, padding: 28 },
  missingTitle: { fontSize: 20, fontFamily: 'PlayfairDisplay_600SemiBold', textAlign: 'center' },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  itemText: { flex: 1, gap: 3 },
  itemName: { fontSize: 15, fontFamily: 'PlayfairDisplay_600SemiBold' },
  itemDetail: { fontSize: 11.5, fontFamily: 'Inter_400Regular' },
  itemPrice: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  unavailable: { fontSize: 10.5, fontFamily: 'Inter_600SemiBold' },
  struck: { textDecorationLine: 'line-through', opacity: 0.6 },
  sectionGap: { marginTop: 18 },
  error: { fontSize: 12, marginTop: 10, fontFamily: 'Inter_600SemiBold' },
  locked: { fontSize: 12, lineHeight: 17, marginTop: 10, fontFamily: 'Inter_400Regular' },
  checkout: { marginTop: 14 },
});