/**
 * "product" coach card — a compact THINNR product suggestion rendered under
 * an assistant reply, with a View button that opens the shop-style product
 * page. Registered into the coach card slot as a module side effect; the
 * chat screen imports this file once.
 *
 * The server payload carries the catalog id (plus name/line as a fallback
 * contract); everything shown here is re-resolved from the bundled catalog so
 * the card can never drift from the curated product data.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { registerCoachCard } from '@/components/coach/CoachCardSlot';
import { useColors } from '@/hooks/useColors';
import { findCatalogProduct } from '@/data/product-catalog';
import { PRODUCT_IMAGES } from '@/data/product-images';

function payloadProductId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function ProductSuggestionCard({ payload }: { payload: unknown }) {
  const colors = useColors();
  const id = payloadProductId(payload);
  const product = id ? findCatalogProduct(id) : undefined;
  if (!product) return null;

  const openProduct = () => {
    Haptics.selectionAsync();
    router.push(`/product/${product.id}`);
  };

  return (
    <Pressable
      testID="coach-product-card"
      accessibilityRole="button"
      accessibilityLabel={`View ${product.name}`}
      onPress={openProduct}
      style={({ pressed }) => [
        styles.card,
        { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.background },
      ]}
    >
      <Image
        source={PRODUCT_IMAGES[product.id]}
        style={[styles.thumb, { backgroundColor: '#FFFFFF', borderColor: colors.border }]}
        contentFit="contain"
        transition={100}
      />
      <View style={styles.textCol}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>THINNR PRODUCT</Text>
        <Text style={[styles.name, { color: colors.navy }]} numberOfLines={1}>
          {product.name}
        </Text>
        <Text style={[styles.line, { color: colors.bodyText }]} numberOfLines={2}>
          {product.cardLine}
        </Text>
      </View>
      <View testID="coach-product-view" style={[styles.viewBtn, { backgroundColor: colors.cobalt }]}>
        <Text style={[styles.viewText, { color: colors.primaryForeground }]}>VIEW</Text>
        <Feather name="chevron-right" size={12} color={colors.primaryForeground} />
      </View>
    </Pressable>
  );
}

registerCoachCard('product', ProductSuggestionCard);

// Imported for its registration side effect; the named export keeps the
// module useful for tests and future direct rendering.
export { ProductSuggestionCard };

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    padding: 10,
    marginTop: 10,
  },
  thumb: {
    width: 46,
    height: 46,
    borderWidth: 1,
  },
  textCol: {
    flex: 1,
    minWidth: 0,
  },
  kicker: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
  },
  name: {
    fontSize: 13.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    marginTop: 2,
  },
  line: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  viewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: 7,
    paddingLeft: 10,
    paddingRight: 7,
  },
  viewText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
});
