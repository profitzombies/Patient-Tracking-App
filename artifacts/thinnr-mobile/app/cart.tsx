/**
 * Cart — the patient's lines grouped the way they will be charged: the
 * one-time order (one shipping charge) and each subscription on its own
 * (each ships on its own schedule, so each carries shipping). Quantities,
 * cadences, and removal edit the persisted cart; totals come from the
 * server's quote (POST /cart/quote) for real accounts so the cart never
 * promises a price checkout will not honor. The demo persona totals from
 * the same arithmetic locally.
 *
 * While a pay attempt is unsettled the cart is locked: the lines shown are
 * exactly the ones that attempt sent, every control is frozen, and the only
 * way forward is to confirm the payment on the checkout screen.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { ErrorBox, GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { CadencePicker, PriceRow, QuantityStepper, ShopHeader, ShopUnavailable } from '@/components/shop/ShopChrome';
import { useColors } from '@/hooks/useColors';
import { useCart } from '@/context/CartContext';
import { cadenceLabel, cartLineKey, formatCents, localQuote, toQuoteRequest, type CartLine } from '@/lib/cart-math';
import { quoteCart } from '@/lib/patient-billing-api';
import { productThumbnail } from '@/lib/shop-catalog';
import type { CartQuote, PublicLinkProduct } from '@/lib/patient-billing-types';

const QUOTE_DEBOUNCE_MS = 350;

export default function CartScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const cart = useCart();
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);

  useEffect(() => {
    if (cart.shopStatus === 'idle') void cart.loadShop();
  }, [cart.shopStatus, cart.loadShop, cart]);

  const shop = cart.shop;
  const products = useMemo(() => shop?.available ? shop.products : [], [shop]);
  const byId = useMemo(() => new Map(products.map(product => [product.product_id, product])), [products]);
  const lines = cart.lines;

  const estimate = useMemo(
    () => (shop ? localQuote(lines, products, shop.shipping_charge_cents, !!shop.tax_enabled) : null),
    [shop, lines, products],
  );
  const [serverQuote, setServerQuote] = useState<{ signature: string; quote: CartQuote } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const signature = JSON.stringify(toQuoteRequest(lines));
  const generation = useRef(0);

  // Live quote for real accounts, debounced behind quantity taps.
  useEffect(() => {
    if (cart.demo || !shop?.available || lines.length === 0) {
      setQuoting(false);
      setQuoteError(null);
      return;
    }
    const attempt = ++generation.current;
    setQuoting(true);
    const timer = setTimeout(() => {
      void quoteCart(toQuoteRequest(lines))
        .then(quote => {
          if (generation.current !== attempt) return;
          setServerQuote({ signature, quote });
          setQuoteError(null);
        })
        .catch((caught: unknown) => {
          if (generation.current !== attempt) return;
          setQuoteError(caught instanceof Error && caught.message ? caught.message : 'Couldn’t price your cart. Please try again.');
        })
        .finally(() => {
          if (generation.current === attempt) setQuoting(false);
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [cart.demo, shop?.available, lines, signature]);

  const quote = cart.demo ? estimate : serverQuote?.signature === signature ? serverQuote.quote : null;
  const shown = quote ?? estimate;
  const oneTime = lines.filter(line => line.purchase === 'one_time');
  const subscriptions = lines.filter(line => line.purchase === 'subscription');
  const shipping = shop?.shipping_charge_cents ?? 0;
  const canCheckout = lines.length > 0 && !!shop?.available && (cart.demo || (!!quote && !quoteError));
  const locked = cart.locked;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <ShopHeader title="Cart" testIDPrefix="cart" backFallback={'/shop' as Href} cartButton={false} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <ShopUnavailable
          shop={shop}
          status={cart.shopStatus}
          error={cart.shopError}
          onRetry={() => void cart.loadShop(true)}
          testIDPrefix="cart"
        />
        {locked ? (
          <LedgerCard testID="cart-locked" style={{ padding: 14, marginTop: 4 }}>
            <Text accessibilityRole="alert" style={[styles.lockedTitle, { color: colors.navy }]}>Payment awaiting confirmation</Text>
            <Text style={[styles.lockedBody, { color: colors.bodyText }]}>
              Your last payment attempt hasn’t been confirmed yet. Your cart can’t change until it settles; nothing new is charged when you confirm.
            </Text>
            <PrimaryButton testID="cart-confirm-payment" label="Confirm payment" onPress={() => router.push('/checkout' as Href)} style={{ marginTop: 12 }} />
          </LedgerCard>
        ) : null}
        {shop?.available && cart.hydrated && lines.length === 0 ? (
          <View testID="cart-empty" style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: colors.navy }]}>Your cart is empty</Text>
            <Text style={[styles.emptyBody, { color: colors.bodyText }]}>Add a product from the shop to get started.</Text>
            <PrimaryButton testID="cart-browse" label="Browse the shop" onPress={() => router.replace('/shop' as Href)} style={{ marginTop: 14, alignSelf: 'stretch' }} />
          </View>
        ) : null}
        {shop?.available && lines.length > 0 ? (
          <>
            {oneTime.length ? (
              <>
                <SectionHeader label="One-time order" style={styles.sectionGap} />
                <LedgerCard testID="cart-group-one-time" style={{ paddingVertical: 4 }}>
                  {oneTime.map((line, index) => (
                    <View key={cartLineKey(line)}>
                      {index > 0 && <Divider />}
                      <CartRow line={line} product={byId.get(line.product_id)} />
                    </View>
                  ))}
                  <Divider />
                  <View style={styles.groupFoot}>
                    <PriceRow label="Shipping" cents={shipping} />
                  </View>
                </LedgerCard>
              </>
            ) : null}
            {subscriptions.map(line => {
              const product = byId.get(line.product_id);
              return (
                <View key={cartLineKey(line)}>
                  <SectionHeader label={`Subscription · ${cadenceLabel(line.cadence_weeks)}`} style={styles.sectionGap} />
                  <LedgerCard testID={`cart-group-subscription-${product?.slug ?? line.product_id}`} style={{ paddingVertical: 4 }}>
                    <CartRow line={line} product={product} />
                    {product ? (
                      <View style={styles.cadenceWrap}>
                        <Text style={[styles.smallLabel, { color: colors.labelText }]}>DELIVER EVERY</Text>
                        <CadencePicker
                          cadences={locked ? [line.cadence_weeks ?? product.default_cadence_weeks] : (product.subscription_cadences_weeks as number[])}
                          value={line.cadence_weeks ?? product.default_cadence_weeks}
                          onChange={weeks => cart.setCadence(cartLineKey(line), weeks)}
                          testIDPrefix={`cart-${product.slug}`}
                        />
                      </View>
                    ) : null}
                    <Divider />
                    <View style={styles.groupFoot}>
                      <PriceRow label="Shipping each delivery" cents={shipping} />
                    </View>
                  </LedgerCard>
                </View>
              );
            })}

            <SectionHeader label="Summary" style={styles.sectionGap} />
            <LedgerCard testID="cart-summary" style={{ padding: 14 }}>
              {quoteError ? <ErrorBox testID="cart-quote-error" message={quoteError} /> : null}
              {shown ? (
                <>
                  <PriceRow label="Items" cents={shown.subtotal_cents + shown.discount_cents} testID="cart-items-total" />
                  {shown.discount_cents > 0 ? (
                    <PriceRow label="Subscribe & save" cents={shown.discount_cents} discount testID="cart-discount" />
                  ) : null}
                  <PriceRow label="Shipping" cents={shown.shipping_charge_cents} testID="cart-shipping" />
                  <Divider style={{ marginVertical: 6 }} />
                  {/* A tax-collecting office adds sales tax at checkout once the address is known; the cart never claims a final total. */}
                  <PriceRow
                    label={quoting ? 'Total (updating…)' : shown.tax_enabled ? 'Total before tax' : 'Total today'}
                    cents={shown.total_cents}
                    strong
                    testID="cart-total"
                  />
                  {shown.tax_enabled ? (
                    <Text testID="cart-tax-note" style={[styles.note, { color: colors.subtleText }]}>
                      Sales tax is calculated at checkout for your shipping address.
                    </Text>
                  ) : null}
                  {subscriptions.length ? (
                    <Text style={[styles.note, { color: colors.subtleText }]}>
                      Subscriptions renew at the same price plus shipping on each delivery. Change or cancel anytime.
                    </Text>
                  ) : null}
                </>
              ) : null}
              <PrimaryButton
                testID="cart-checkout"
                label={locked ? 'Confirm payment' : 'Check out'}
                disabled={!canCheckout && !locked}
                onPress={() => router.push('/checkout' as Href)}
                style={{ marginTop: 12 }}
              />
              {locked ? null : (
                <GhostButton testID="cart-continue" label="Keep shopping" onPress={() => router.replace('/shop' as Href)} style={{ marginTop: 8 }} />
              )}
            </LedgerCard>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function CartRow({ line, product }: { line: CartLine; product: PublicLinkProduct | undefined }) {
  const colors = useColors();
  const cart = useCart();
  const key = cartLineKey(line);
  const image = product ? productThumbnail(product) : null;
  const unit =
    line.purchase === 'subscription' && product?.subscription_unit_price_cents != null
      ? product.subscription_unit_price_cents
      : product?.unit_price_cents ?? 0;
  const slug = product?.slug ?? line.product_id;
  return (
    <View testID={`cart-line-${slug}-${line.purchase === 'one_time' ? 'one-time' : 'subscription'}`} style={styles.row}>
      <View style={[styles.thumbWrap, { backgroundColor: colors.paperCardAlt, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
        {image ? <Image source={image} style={styles.thumb} contentFit="contain" /> : null}
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: colors.navy }]} numberOfLines={1}>{product?.name ?? 'Unavailable product'}</Text>
        <Text style={[styles.rowMeta, { color: colors.bodyText }]}>
          {formatCents(unit)} each
          {line.purchase === 'subscription' && product && product.unit_price_cents > unit
            ? ` · was ${formatCents(product.unit_price_cents)}`
            : ''}
        </Text>
        <View style={styles.rowControls}>
          <QuantityStepper
            value={line.quantity}
            onChange={next => cart.setQuantity(key, next)}
            disabled={cart.locked}
            allowRemove
            testIDPrefix={`cart-${slug}-${line.purchase === 'one_time' ? 'one-time' : 'subscription'}`}
            label={product?.name ?? 'item'}
          />
          <Text testID={`cart-line-total-${slug}-${line.purchase === 'one_time' ? 'one-time' : 'subscription'}`} style={[styles.rowTotal, { color: colors.navy }]}>
            {formatCents(unit * line.quantity)}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  sectionGap: { marginTop: 14, marginBottom: 8 },
  empty: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 18, fontFamily: 'PlayfairDisplay_600SemiBold' },
  emptyBody: { fontSize: 13, fontFamily: 'Inter_400Regular', marginTop: 6, textAlign: 'center' },
  lockedTitle: { fontSize: 15, fontFamily: 'PlayfairDisplay_600SemiBold' },
  lockedBody: { fontSize: 12.5, lineHeight: 17, fontFamily: 'Inter_400Regular', marginTop: 4 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  thumbWrap: { width: 60, height: 60, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  thumb: { width: 52, height: 52 },
  rowBody: { flex: 1, gap: 3 },
  rowName: { fontSize: 14.5, fontFamily: 'PlayfairDisplay_600SemiBold' },
  rowMeta: { fontSize: 11.5, fontFamily: 'Inter_400Regular' },
  rowControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  rowTotal: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  cadenceWrap: { paddingHorizontal: 14, paddingBottom: 12, gap: 8 },
  smallLabel: { fontSize: 9, letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  groupFoot: { paddingHorizontal: 14, paddingVertical: 6 },
  note: { fontSize: 11, lineHeight: 15, fontFamily: 'Inter_400Regular', marginTop: 8 },
});
