/**
 * Product detail (PDP) — shop-style page for a curated THINNR product:
 * hero render, description, supplement facts, price, and a clearly-labeled
 * DEMO purchase flow (no cart persistence, no payments; optional link out to
 * the real product page on getthinnr.com).
 *
 * Catalog content is quoted verbatim from getthinnr.com; prices are demo
 * values consistent with the staff operations dataset.
 */
import React, { useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { useAppMode } from '@/context/AppModeContext';
import { findCatalogProduct } from '@/data/product-catalog';
import { PRODUCT_IMAGES } from '@/data/product-images';

type DemoOrder = 'idle' | 'cart' | 'buy';

export default function ProductDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { id } = useLocalSearchParams<{ id: string }>();
  const product = findCatalogProduct(id ?? '');

  const [demoOrder, setDemoOrder] = useState<DemoOrder>('idle');

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (!product) {
    return (
      <View style={[styles.container, styles.missing, { backgroundColor: colors.background, paddingTop: topPad }]}>
        <Text style={[styles.missingText, { color: colors.bodyText }]}>Product not found.</Text>
        <Pressable onPress={goBack} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Text style={[styles.missingLink, { color: colors.cobalt }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const formatChips = product.format.split('·').map(part => part.trim()).filter(Boolean);

  const openSite = () => {
    Haptics.selectionAsync();
    Linking.openURL(product.sourceUrl);
  };

  const placeDemoOrder = (kind: Exclude<DemoOrder, 'idle'>) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setDemoOrder(kind);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable
          testID="pdp-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.labelText }]}>THINNR SHOP · DEMO</Text>
        <Pressable
          testID="pdp-site-link"
          accessibilityLabel="View on getthinnr.com"
          onPress={openSite}
          style={({ pressed }) => [
            styles.topBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
          ]}
        >
          <Feather name="external-link" size={15} color={colors.bodyText} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <View style={[styles.heroWrap, { borderBottomColor: colors.border, backgroundColor: colors.card }]}>
          <Image
            source={PRODUCT_IMAGES[product.id]}
            style={styles.hero}
            contentFit="contain"
            transition={150}
          />
        </View>

        <View style={styles.body}>
          <View style={styles.chipRow}>
            {formatChips.map(chip => (
              <View key={chip} style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Text style={[styles.chipText, { color: colors.bodyText }]}>{chip.toUpperCase()}</Text>
              </View>
            ))}
          </View>

          <Text style={[styles.name, { color: colors.navy }]}>{product.name}</Text>
          <Text style={[styles.tagline, { color: colors.cobalt }]}>{product.tagline}</Text>

          <View style={styles.priceRow}>
            <Text testID="pdp-price" style={[styles.price, { color: colors.navy }]}>${product.price}</Text>
            <Text style={[styles.priceHint, { color: colors.orangeText }]}>DEMO PRICING</Text>
          </View>

          <Text style={[styles.description, { color: colors.bodyText }]}>{product.description}</Text>

          {/* ── Benefits ── */}
          <SectionHeader label="Highlights" style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ paddingVertical: 4 }}>
            {product.benefits.map((benefit, index) => (
              <View key={benefit}>
                {index > 0 && <Divider />}
                <View style={styles.benefitRow}>
                  <View style={[styles.benefitDot, { backgroundColor: colors.cobalt }]} />
                  <Text style={[styles.benefitText, { color: colors.bodyText }]}>{benefit}</Text>
                </View>
              </View>
            ))}
          </LedgerCard>

          {/* ── Supplement facts ── */}
          <SectionHeader label={product.factsTitle} style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ paddingVertical: 4 }}>
            {product.facts.map((fact, index) => (
              <View key={fact.name}>
                {index > 0 && <Divider />}
                <View style={styles.factRow}>
                  <Text style={[styles.factName, { color: colors.navy }]}>{fact.name}</Text>
                  {fact.detail ? (
                    <Text style={[styles.factDetail, { color: colors.bodyText }]}>{fact.detail}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </LedgerCard>

          {product.suggestedUse ? (
            <>
              <SectionHeader label="Suggested Use" style={{ marginTop: 18, marginBottom: 8 }} />
              <LedgerCard style={{ padding: 14 }}>
                <Text style={[styles.suggestedUse, { color: colors.bodyText }]}>{product.suggestedUse}</Text>
              </LedgerCard>
            </>
          ) : null}

          {/* ── Demo order panel ── */}
          <SectionHeader label="Order · Demo Only" style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ padding: 16 }}>
            {demoOrder === 'idle' ? (
              <>
                <View style={styles.orderPriceRow}>
                  <Text style={[styles.orderPriceLabel, { color: colors.labelText }]}>ONE-TIME · SHIPS FROM PROVIDER</Text>
                  <Text style={[styles.orderPrice, { color: colors.navy }]}>${product.price}</Text>
                </View>
                <Pressable
                  testID="pdp-buy"
                  onPress={() => placeDemoOrder('buy')}
                  style={({ pressed }) => [
                    styles.buyBtn,
                    { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Text style={[styles.buyBtnText, { color: colors.primaryForeground }]}>Buy Now — ${product.price}</Text>
                </Pressable>
                <Pressable
                  testID="pdp-add-cart"
                  onPress={() => placeDemoOrder('cart')}
                  style={({ pressed }) => [
                    styles.cartBtn,
                    { borderColor: colors.cobalt, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
                  ]}
                >
                  <Text style={[styles.cartBtnText, { color: colors.cobalt }]}>Add to Cart</Text>
                </Pressable>
                <Text style={[styles.orderHint, { color: colors.subtleText }]}>
                  Demo shop — no payments are collected and no real orders are placed.
                </Text>
              </>
            ) : (
              <View testID="pdp-demo-confirm">
                <View style={styles.confirmHead}>
                  <View style={[styles.confirmIcon, { backgroundColor: colors.cobalt }]}>
                    <Feather name="check" size={14} color={colors.primaryForeground} />
                  </View>
                  <Text style={[styles.confirmLabel, { color: colors.cobalt }]}>
                    {demoOrder === 'buy' ? 'DEMO ORDER SIMULATED' : 'ADDED TO CART · DEMO'}
                  </Text>
                </View>
                <Text style={[styles.confirmBody, { color: colors.bodyText }]}>
                  This is a demo confirmation only. No payment was collected and no real order was
                  placed. In the live app this would {demoOrder === 'buy' ? 'order' : 'add'}{' '}
                  {product.name} (${product.price}){demoOrder === 'buy' ? ' from your provider' : ' to your cart'}.
                </Text>
                <Pressable
                  testID="pdp-demo-site"
                  onPress={openSite}
                  style={({ pressed }) => [
                    styles.cartBtn,
                    { borderColor: colors.cobalt, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm, marginTop: 12 },
                  ]}
                >
                  <Text style={[styles.cartBtnText, { color: colors.cobalt }]}>View the real product on getthinnr.com</Text>
                </Pressable>
                <Pressable
                  testID="pdp-demo-dismiss"
                  onPress={() => setDemoOrder('idle')}
                  style={({ pressed }) => [styles.dismissBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[styles.dismissText, { color: colors.subtleText }]}>Back to product</Text>
                </Pressable>
              </View>
            )}
          </LedgerCard>

          <Text style={[styles.disclaimer, { color: colors.subtleText }]}>{product.disclaimer}</Text>
          <Text style={[styles.sourceNote, { color: colors.subtleText }]}>
            {product.sourceNote}
          </Text>

          <SyntheticDisclaimer />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  missing: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  missingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  missingLink: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  topBtn: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTitle: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
  },
  heroWrap: {
    borderBottomWidth: 1,
    alignItems: 'center',
    paddingVertical: 18,
  },
  hero: {
    width: '78%',
    maxWidth: 320,
    aspectRatio: 1,
  },
  body: {
    padding: 16,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 10,
  },
  chip: {
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 5,
  },
  chipText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
  name: {
    fontSize: 23,
    letterSpacing: -0.3,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  tagline: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 4,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 10,
  },
  price: {
    fontSize: 25,
    letterSpacing: -0.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  priceHint: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  benefitDot: {
    width: 5,
    height: 5,
    marginTop: 6,
  },
  benefitText: {
    fontSize: 12.5,
    lineHeight: 18,
    flex: 1,
    fontFamily: 'Inter_400Regular',
  },
  factRow: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  factName: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  factDetail: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
    fontFamily: 'Inter_400Regular',
  },
  suggestedUse: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
  },
  orderPriceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  orderPriceLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
    flexShrink: 1,
  },
  orderPrice: {
    fontSize: 18,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  buyBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  buyBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  cartBtn: {
    marginTop: 8,
    paddingVertical: 11,
    alignItems: 'center',
    borderWidth: 1,
  },
  cartBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  orderHint: {
    fontSize: 10,
    marginTop: 10,
    textAlign: 'center',
    fontFamily: 'Inter_400Regular',
  },
  confirmHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  confirmIcon: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  confirmLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  confirmBody: {
    fontSize: 12.5,
    lineHeight: 18,
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
  },
  dismissBtn: {
    marginTop: 10,
    alignItems: 'center',
    paddingVertical: 6,
  },
  dismissText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  disclaimer: {
    fontSize: 9.5,
    lineHeight: 14,
    marginTop: 16,
    fontFamily: 'Inter_400Regular',
  },
  sourceNote: {
    fontSize: 9.5,
    lineHeight: 14,
    marginTop: 6,
    fontFamily: 'Inter_400Regular',
  },
});
