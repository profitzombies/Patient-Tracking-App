/**
 * Shop — every product the patient's office sells, at the patient's price.
 * Backed by the storefront (GET /patient-data/billing/shop) shared through
 * CartContext; the guided demo renders the bundled demo storefront. When the
 * office has not connected payments the grid is replaced by a quiet
 * "not available yet" state rather than an error.
 */
import React, { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { ShopHeader, ShopUnavailable } from '@/components/shop/ShopChrome';
import { useColors } from '@/hooks/useColors';
import { useCart } from '@/context/CartContext';
import { formatCents } from '@/lib/cart-math';
import { productThumbnail } from '@/lib/shop-catalog';
import type { PublicLinkProduct } from '@/lib/patient-billing-types';

export default function ShopScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const cart = useCart();
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);

  useEffect(() => {
    if (cart.shopStatus === 'idle') void cart.loadShop();
  }, [cart.shopStatus, cart.loadShop, cart]);

  const shop = cart.shop;
  const products = shop?.available ? shop.products : [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <ShopHeader title="Shop" testIDPrefix="shop" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <ShopUnavailable
          shop={shop}
          status={cart.shopStatus}
          error={cart.shopError}
          onRetry={() => void cart.loadShop(true)}
          testIDPrefix="shop"
        />
        {shop?.available ? (
          <>
            <Text style={[styles.eyebrow, { color: colors.labelText }]}>
              {(shop.office?.office_name ?? 'Your office').toUpperCase()}
              {shop.subscribe_save_percent > 0 ? ` · SUBSCRIBE & SAVE ${shop.subscribe_save_percent}%` : ''}
            </Text>
            {cart.demo ? (
              <Text testID="shop-demo-note" style={[styles.demoNote, { color: colors.orangeText }]}>
                Demo shop — browse and build a cart; payment needs a patient account.
              </Text>
            ) : null}
            <View testID="shop-grid" style={styles.grid}>
              {products.map(product => (
                <ProductTile key={product.product_id} product={product} />
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ProductTile({ product }: { product: PublicLinkProduct }) {
  const colors = useColors();
  const image = productThumbnail(product);
  const price = formatCents(product.unit_price_cents);
  const subscription =
    product.subscription_available && product.subscription_unit_price_cents !== null
      ? formatCents(product.subscription_unit_price_cents)
      : null;
  return (
    <Pressable
      testID={`shop-product-${product.slug}`}
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${price}${subscription ? `, subscribe for ${subscription}` : ''}`}
      onPress={() => router.push(`/product/${product.slug}` as Href)}
      style={({ pressed }) => [
        styles.tile,
        { backgroundColor: colors.card, borderColor: colors.border, borderRadius: colors.radius },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={[styles.tileImageWrap, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border }]}>
        {image ? (
          <Image source={image} style={styles.tileImage} contentFit="contain" transition={120} accessibilityIgnoresInvertColors />
        ) : null}
      </View>
      <View style={styles.tileBody}>
        <Text style={[styles.tileName, { color: colors.navy }]} numberOfLines={1}>{product.name}</Text>
        <Text style={[styles.tileTagline, { color: colors.bodyText }]} numberOfLines={2}>{product.tagline}</Text>
        <Text testID={`shop-price-${product.slug}`} style={[styles.tilePrice, { color: colors.navy }]}>{price}</Text>
        {subscription ? (
          <Text style={[styles.tileSub, { color: colors.cobalt }]}>{subscription} subscribed</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  eyebrow: { fontSize: 9.5, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginBottom: 10 },
  demoNote: { fontSize: 11.5, lineHeight: 16, fontFamily: 'Inter_600SemiBold', marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: '47.5%', flexGrow: 1, borderWidth: 1, overflow: 'hidden' },
  tileImageWrap: { aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 1, padding: 12 },
  tileImage: { width: '100%', height: '100%' },
  tileBody: { padding: 10, gap: 3 },
  tileName: { fontSize: 14.5, fontFamily: 'PlayfairDisplay_600SemiBold' },
  tileTagline: { fontSize: 11, lineHeight: 15, fontFamily: 'Inter_400Regular', minHeight: 30 },
  tilePrice: { fontSize: 14, fontFamily: 'Inter_700Bold', marginTop: 2 },
  tileSub: { fontSize: 10.5, fontFamily: 'Inter_600SemiBold' },
});
