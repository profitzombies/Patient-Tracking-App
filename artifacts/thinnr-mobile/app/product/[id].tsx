/**
 * Product page — the full storefront listing for one THINNR product at the
 * patient's office price: gallery, tagline, description, benefits, how to
 * take it, supplement facts, FAQs, then the purchase panel (one-time or
 * subscribe at a chosen cadence with the subscribe-and-save price, quantity,
 * Add to cart).
 *
 * The route accepts a storefront product_id, a catalog slug, or the bundled
 * catalog id the coach's product card still uses (prod1..prod9), and reads
 * everything from the storefront shared through CartContext.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  ScrollView as RNScrollView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { PrimaryButton, GhostButton } from '@/components/onboarding/OnboardingFields';
import {
  CadencePicker,
  PurchaseToggle,
  QuantityStepper,
  ShopHeader,
  ShopUnavailable,
} from '@/components/shop/ShopChrome';
import { useColors } from '@/hooks/useColors';
import { useCart } from '@/context/CartContext';
import { useAppWindowDimensions } from '@/hooks/useAppWindowDimensions';
import { cadenceLabel, formatCents } from '@/lib/cart-math';
import { findShopProduct, productImageSources } from '@/lib/shop-catalog';
import type { CartPurchase, PublicLinkProduct } from '@/lib/patient-billing-types';

export default function ProductDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    id: string | string[];
    purchase?: string | string[];
    cadence?: string | string[];
    quantity?: string | string[];
    suggestedName?: string | string[];
    suggestedImage?: string | string[];
  }>();
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const id = first(params.id);
  const requestedPurchase = first(params.purchase);
  const requestedCadence = Number(first(params.cadence));
  const requestedQuantity = Number(first(params.quantity));
  const suggestedName = first(params.suggestedName);
  const suggestedImage = first(params.suggestedImage);
  const cart = useCart();
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);

  useEffect(() => {
    if (cart.shopStatus === 'idle') void cart.loadShop();
  }, [cart.shopStatus, cart.loadShop, cart]);

  const shop = cart.shop;
  const storefrontProduct = useMemo(
    () => findShopProduct(shop?.products ?? [], id),
    [shop, id],
  );
  // A storefront row resolves even when ordering is closed: the page then
  // opens informationally (no price, no buy panel) instead of a dead end.
  const product = storefrontProduct;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <ShopHeader title={storefrontProduct?.name ?? suggestedName ?? 'Product'} testIDPrefix="pdp" backFallback={'/shop' as Href} />
      {product && shop ? (
        <ProductBody
          product={product}
          savePercent={shop.subscribe_save_percent}
          bottomPad={insets.bottom + 32}
          requestedPurchase={requestedPurchase}
          requestedCadence={requestedCadence}
          requestedQuantity={requestedQuantity}
          purchasable={shop.available}
          officeName={shop.office?.office_name ?? 'your office'}
        />
      ) : shop?.available ? (
        <UnavailableProduct
          product={storefrontProduct}
          suggestedName={suggestedName}
          suggestedImage={suggestedImage}
        />
      ) : (
        <View style={styles.stateHost}>
          <ShopUnavailable
            shop={shop}
            status={cart.shopStatus}
            error={cart.shopError}
            onRetry={() => void cart.loadShop(true)}
            testIDPrefix="pdp"
          />
        </View>
      )}
    </View>
  );
}

function UnavailableProduct({
  product,
  suggestedName,
  suggestedImage,
}: {
  product?: PublicLinkProduct;
  suggestedName?: string;
  suggestedImage?: string;
}) {
  const colors = useColors();
  const image = product ? productImageSources(product)[0] : suggestedImage ? { uri: suggestedImage } : null;
  return (
    <ScrollView contentContainerStyle={styles.unavailableBody}>
      {image ? <Image source={image} style={styles.unavailableImage} contentFit="contain" /> : null}
      <Text testID="pdp-name" style={[styles.name, { color: colors.navy }]}>
        {product?.name ?? suggestedName ?? 'Suggested product'}
      </Text>
      {product?.description ? (
        <Text style={[styles.description, { color: colors.bodyText }]}>{product.description}</Text>
      ) : null}
      <Text testID="pdp-missing" style={[styles.unavailableNote, { color: colors.bodyText }]}>
        This product isn't available right now — ask your care team about it.
      </Text>
      <GhostButton testID="pdp-missing-shop" label="Browse the shop" onPress={() => router.replace('/shop' as Href)} />
    </ScrollView>
  );
}

function ProductBody({
  product,
  savePercent,
  bottomPad,
  requestedPurchase,
  requestedCadence,
  requestedQuantity,
  purchasable,
  officeName,
}: {
  product: PublicLinkProduct;
  savePercent: number;
  bottomPad: number;
  requestedPurchase?: string;
  requestedCadence: number;
  requestedQuantity: number;
  /** False when the office cannot take orders: informational page, no price or buy panel. */
  purchasable: boolean;
  officeName: string;
}) {
  const colors = useColors();
  const cart = useCart();
  const canSubscribe = product.subscription_available && product.subscription_unit_price_cents !== null;
  const cadences = product.subscription_cadences_weeks as number[];
  const [purchase, setPurchase] = useState<CartPurchase>('one_time');
  const [cadence, setCadence] = useState<number>(product.default_cadence_weeks);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [locked, setLocked] = useState(false);

  // Fresh product → fresh panel (the same screen instance can host another product).
  useEffect(() => {
    setPurchase(requestedPurchase === 'subscription' && canSubscribe ? 'subscription' : 'one_time');
    setCadence(cadences.includes(requestedCadence) ? requestedCadence : product.default_cadence_weeks);
    setQuantity(Number.isFinite(requestedQuantity)
      ? Math.min(20, Math.max(1, Math.round(requestedQuantity)))
      : 1);
    setAdded(null);
    setFull(false);
    setLocked(false);
  }, [
    canSubscribe,
    product.product_id,
    product.default_cadence_weeks,
    requestedCadence,
    requestedPurchase,
    requestedQuantity,
  ]);

  const unit = purchase === 'subscription' && canSubscribe ? product.subscription_unit_price_cents! : product.unit_price_cents;
  const total = unit * quantity;
  const saving = purchase === 'subscription' ? (product.unit_price_cents - unit) * quantity : 0;

  const addToCart = () => {
    const result = cart.add({
      product_id: product.product_id,
      quantity,
      purchase,
      cadence_weeks: purchase === 'subscription' ? cadence : null,
    });
    if (!result.ok) {
      // 'locked': a pay attempt is unsettled, so the cart cannot change until it is confirmed.
      if (result.reason === 'locked') setLocked(true);
      else setFull(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const summary = `${quantity} × ${product.name}${purchase === 'subscription' ? `, ${cadenceLabel(cadence).toLowerCase()}` : ''} added to your cart`;
    setAdded(summary);
    AccessibilityInfo.announceForAccessibility(summary);
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
      <Gallery product={product} />
      <View style={styles.body}>
        {product.format ? (
          <View style={styles.chipRow}>
            {product.format.split('·').map(part => part.trim()).filter(Boolean).map(chip => (
              <View key={chip} style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Text style={[styles.chipText, { color: colors.bodyText }]}>{chip.toUpperCase()}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <Text testID="pdp-name" style={[styles.name, { color: colors.navy }]}>{product.name}</Text>
        {product.tagline ? <Text style={[styles.tagline, { color: colors.cobalt }]}>{product.tagline}</Text> : null}
        {purchasable ? (
        <View style={styles.priceRow}>
          <Text testID="pdp-price" style={[styles.price, { color: colors.navy }]}>{formatCents(product.unit_price_cents)}</Text>
          {canSubscribe && savePercent > 0 ? (
            <Text testID="pdp-subscribe-price" style={[styles.priceHint, { color: colors.activeGreen }]}>
              {formatCents(product.subscription_unit_price_cents!)} SUBSCRIBED · SAVE {product.subscribe_save_percent || savePercent}%
            </Text>
          ) : null}
        </View>
        ) : null}
        {product.description ? (
          <Text style={[styles.description, { color: colors.bodyText }]}>{product.description}</Text>
        ) : null}

        {/* ── Purchase panel (informational pages show a notice instead) ── */}
        {!purchasable ? (
          <LedgerCard testID="pdp-informational" style={[styles.sectionGap, { padding: 14 }]}>
            <Text style={[styles.paragraph, { color: colors.bodyText }]}>
              Ordering isn’t open at {officeName} yet. Ask about this product at your next visit.
            </Text>
          </LedgerCard>
        ) : (
        <>
        <SectionHeader label="Order" style={styles.sectionGap} />
        <LedgerCard testID="pdp-order" style={{ padding: 14, gap: 12 }}>
          <PurchaseToggle
            value={purchase}
            onChange={setPurchase}
            subscriptionAvailable={canSubscribe}
            savePercent={product.subscribe_save_percent || savePercent}
            testIDPrefix="pdp"
          />
          {purchase === 'subscription' && canSubscribe ? (
            <View style={styles.block}>
              <Text style={[styles.blockLabel, { color: colors.labelText }]}>DELIVER EVERY</Text>
              <CadencePicker cadences={cadences} value={cadence} onChange={setCadence} testIDPrefix="pdp" />
              <Text style={[styles.blockHint, { color: colors.subtleText }]}>
                {cadenceLabel(cadence)} at {formatCents(unit)} each. Change, pause, or cancel anytime from Payments & orders.
              </Text>
            </View>
          ) : null}
          <View style={styles.qtyRow}>
            <Text style={[styles.blockLabel, { color: colors.labelText }]}>QUANTITY</Text>
            <QuantityStepper value={quantity} onChange={setQuantity} testIDPrefix="pdp-qty" />
          </View>
          <Divider />
          <View style={styles.totalRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.blockLabel, { color: colors.labelText }]}>
                {purchase === 'subscription' ? 'PER DELIVERY' : 'ITEM TOTAL'}
              </Text>
              {saving > 0 ? (
                <Text testID="pdp-saving" style={[styles.saving, { color: colors.activeGreen }]}>You save {formatCents(saving)}</Text>
              ) : null}
            </View>
            <Text testID="pdp-total" style={[styles.total, { color: colors.navy }]}>{formatCents(total)}</Text>
          </View>
          <PrimaryButton
            testID="pdp-add-cart"
            label={purchase === 'subscription' ? 'Add subscription to cart' : 'Add to cart'}
            onPress={addToCart}
          />
          {added ? (
            <View testID="pdp-added" style={[styles.addedBox, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, borderRadius: colors.radiusSm }]}>
              <Text style={[styles.addedText, { color: colors.cobalt }]}>{added}.</Text>
              <Pressable
                testID="pdp-view-cart"
                accessibilityRole="button"
                accessibilityLabel="View cart"
                onPress={() => router.push('/cart' as Href)}
                hitSlop={8}
              >
                <Text style={[styles.addedLink, { color: colors.cobalt }]}>View cart</Text>
              </Pressable>
            </View>
          ) : null}
          {full ? (
            <Text accessibilityRole="alert" style={[styles.fullText, { color: colors.riskText }]}>
              Your cart is full. Remove a line before adding another product.
            </Text>
          ) : null}
          {locked ? (
            <View testID="pdp-locked" style={[styles.addedBox, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, borderRadius: colors.radiusSm }]}>
              <Text accessibilityRole="alert" style={[styles.addedText, { color: colors.navy }]}>
                Your last payment is awaiting confirmation, so your cart can’t change yet.
              </Text>
              <Pressable
                testID="pdp-confirm-payment"
                accessibilityRole="button"
                accessibilityLabel="Confirm payment"
                onPress={() => router.push('/checkout' as Href)}
                hitSlop={8}
              >
                <Text style={[styles.addedLink, { color: colors.cobalt }]}>Confirm payment</Text>
              </Pressable>
            </View>
          ) : null}
        </LedgerCard>
        </>
        )}

        {product.benefits.length ? (
          <>
            <SectionHeader label="Benefits" style={styles.sectionGap} />
            <LedgerCard style={{ paddingVertical: 4 }}>
              {product.benefits.map((benefit, index) => (
                <View key={`${index}-${benefit}`}>
                  {index > 0 && <Divider />}
                  <View style={styles.benefitRow}>
                    <View style={[styles.benefitDot, { backgroundColor: colors.cobalt }]} />
                    <Text style={[styles.benefitText, { color: colors.bodyText }]}>{benefit}</Text>
                  </View>
                </View>
              ))}
            </LedgerCard>
          </>
        ) : null}

        {product.how_to_take ? (
          <>
            <SectionHeader label="How to take" style={styles.sectionGap} />
            <LedgerCard style={{ padding: 14 }}>
              <Text style={[styles.paragraph, { color: colors.bodyText }]}>{product.how_to_take}</Text>
            </LedgerCard>
          </>
        ) : null}

        {product.facts.length ? (
          <>
            <SectionHeader label={product.facts_title || 'Supplement facts'} style={styles.sectionGap} />
            <LedgerCard style={{ paddingVertical: 4 }}>
              {product.facts.map((fact, index) => (
                <View key={`${index}-${fact.name}`}>
                  {index > 0 && <Divider />}
                  <View style={styles.factRow}>
                    <Text style={[styles.factName, { color: colors.navy }]}>{fact.name}</Text>
                    {fact.detail ? <Text style={[styles.factDetail, { color: colors.bodyText }]}>{fact.detail}</Text> : null}
                  </View>
                </View>
              ))}
            </LedgerCard>
          </>
        ) : null}

        {product.faqs.length ? (
          <>
            <SectionHeader label="FAQs" style={styles.sectionGap} />
            <LedgerCard style={{ paddingVertical: 4 }}>
              {product.faqs.map((faq, index) => (
                <View key={`${index}-${faq.question}`}>
                  {index > 0 && <Divider />}
                  <View style={styles.factRow}>
                    <Text style={[styles.factName, { color: colors.navy }]}>{faq.question}</Text>
                    <Text style={[styles.factDetail, { color: colors.bodyText }]}>{faq.answer}</Text>
                  </View>
                </View>
              ))}
            </LedgerCard>
          </>
        ) : null}

        {product.disclaimer ? (
          <Text style={[styles.disclaimer, { color: colors.subtleText }]}>{product.disclaimer}</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

function Gallery({ product }: { product: PublicLinkProduct }) {
  const colors = useColors();
  const { width } = useAppWindowDimensions();
  const sources = productImageSources(product);
  const [index, setIndex] = useState(0);
  const scroller = useRef<RNScrollView>(null);

  useEffect(() => {
    setIndex(0);
    scroller.current?.scrollTo({ x: 0, animated: false });
  }, [product.product_id]);

  if (!sources.length) {
    return <View style={[styles.heroWrap, { borderBottomColor: colors.border, backgroundColor: colors.card, height: width * 0.7 }]} />;
  }
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / Math.max(1, width));
    if (next !== index) setIndex(Math.min(sources.length - 1, Math.max(0, next)));
  };
  return (
    <View style={[styles.heroWrap, { borderBottomColor: colors.border, backgroundColor: colors.card }]}>
      <RNScrollView
        ref={scroller}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={32}
        testID="pdp-gallery"
        accessibilityLabel={`${product.name} photos, ${index + 1} of ${sources.length}`}
      >
        {sources.map((source, i) => (
          <View key={i} style={{ width, alignItems: 'center', paddingVertical: 18 }}>
            <Image
              source={source}
              style={{ width: width * 0.72, maxWidth: 320, aspectRatio: 1 }}
              contentFit="contain"
              transition={150}
              accessibilityLabel={`${product.name} photo ${i + 1}`}
            />
          </View>
        ))}
      </RNScrollView>
      {sources.length > 1 ? (
        <View style={styles.dots} accessibilityElementsHidden>
          {sources.map((_, i) => (
            <View key={i} style={[styles.dot, { backgroundColor: i === index ? colors.cobalt : colors.border }]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  stateHost: { flex: 1 },
  missing: { alignItems: 'center', gap: 12, paddingHorizontal: 28, paddingTop: 40 },
  missingText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  unavailableBody: { padding: 24, gap: 14, alignItems: 'center' },
  unavailableImage: { width: 220, height: 220 },
  unavailableNote: { fontSize: 14, lineHeight: 20, fontFamily: 'Inter_600SemiBold', textAlign: 'center' },
  heroWrap: { borderBottomWidth: 1 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingBottom: 12 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  body: { padding: 16 },
  chipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  chip: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 5 },
  chipText: { fontSize: 9, letterSpacing: 0.8, fontFamily: 'Inter_700Bold' },
  name: { fontSize: 23, letterSpacing: -0.3, fontFamily: 'PlayfairDisplay_600SemiBold' },
  tagline: { fontSize: 13, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 10, flexWrap: 'wrap' },
  price: { fontSize: 25, letterSpacing: -0.5, fontFamily: 'PlayfairDisplay_600SemiBold' },
  priceHint: { fontSize: 9, letterSpacing: 0.8, fontFamily: 'Inter_700Bold' },
  description: { fontSize: 13, lineHeight: 19, marginTop: 10, fontFamily: 'Inter_400Regular' },
  sectionGap: { marginTop: 18, marginBottom: 8 },
  block: { gap: 8 },
  blockLabel: { fontSize: 9, letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  blockHint: { fontSize: 11.5, lineHeight: 16, fontFamily: 'Inter_400Regular' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  totalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  saving: { fontSize: 11.5, fontFamily: 'Inter_600SemiBold', marginTop: 2 },
  total: { fontSize: 20, fontFamily: 'PlayfairDisplay_700Bold' },
  addedBox: { borderWidth: 1, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  addedText: { flex: 1, fontSize: 12.5, lineHeight: 17, fontFamily: 'Inter_600SemiBold' },
  addedLink: { fontSize: 12.5, fontFamily: 'Inter_700Bold', textDecorationLine: 'underline' },
  fullText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  benefitRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 16, paddingVertical: 10 },
  benefitDot: { width: 5, height: 5, marginTop: 6, borderRadius: 2.5 },
  benefitText: { fontSize: 12.5, lineHeight: 18, flex: 1, fontFamily: 'Inter_400Regular' },
  paragraph: { fontSize: 12.5, lineHeight: 18, fontFamily: 'Inter_400Regular' },
  factRow: { paddingHorizontal: 16, paddingVertical: 10 },
  factName: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  factDetail: { fontSize: 12, lineHeight: 17, marginTop: 3, fontFamily: 'Inter_400Regular' },
  disclaimer: { fontSize: 9.5, lineHeight: 14, marginTop: 16, fontFamily: 'Inter_400Regular' },
});
