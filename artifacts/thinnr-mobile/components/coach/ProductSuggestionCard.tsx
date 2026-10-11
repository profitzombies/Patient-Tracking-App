/**
 * "product" coach card — a compact THINNR product suggestion rendered under
 * an assistant reply, with a View button that opens the shop-style product
 * page. Registered into the coach card slot as a module side effect; the
 * chat screen imports this file once.
 *
 * The server payload is the card's source of truth: name, line, price, and
 * image all come from the office's HQ-edited storefront row for real
 * accounts (ids there are storefront uuids the bundled catalog has never
 * heard of), or from the bundled catalog copy for legacy bare-id payloads.
 * The bundled catalog only lends its artwork when the payload carries no
 * image and its slug is a bundled one, and fills name/line/price for legacy
 * bare-id payloads. Tapping opens the shop product page (`/product/<slug>`),
 * which prices from the live storefront; when the office cannot sell right
 * now the same page opens informationally.
 *
 * Heritage styling: soft-radius inset card on the paper bubble, serif
 * product title, cobalt VIEW action, Inter uppercase micro-labels.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { registerCoachCard } from '@/components/coach/CoachCardSlot';
import { useColors } from '@/hooks/useColors';
import { PRODUCT_CATALOG, findCatalogProduct } from '@/data/product-catalog';
import { PRODUCT_IMAGES } from '@/data/product-images';

interface CardPayload {
  id: string;
  slug: string | null;
  name: string | null;
  line: string | null;
  /** Dollars; the office price when the payload carries one, else the bundled price applies. */
  price: number | null;
  /** Storefront product id (live accounts only). */
  productId: string | null;
  imageUrl: string | null;
  available: boolean;
  cta: string;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function readProductCardPayload(payload: unknown): CardPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = payload as {
    id?: unknown; slug?: unknown; name?: unknown; line?: unknown; priceCents?: unknown; productId?: unknown; imageUrl?: unknown; available?: unknown; cta?: unknown;
  };
  if (typeof raw.id !== 'string') return null;
  return {
    id: raw.id,
    slug: str(raw.slug),
    name: str(raw.name),
    line: str(raw.line),
    // Only a live payload carries priceCents; a bare legacy payload keeps the bundled price.
    price: typeof raw.priceCents === 'number' && Number.isFinite(raw.priceCents) ? raw.priceCents / 100 : null,
    productId: str(raw.productId),
    imageUrl: str(raw.imageUrl),
    available: raw.available !== false,
    cta: str(raw.cta) ?? 'Tap to open',
  };
}

/** What the card shows, resolved from the payload first and the bundled catalog only as a fallback. */
export interface ResolvedProductCard {
  name: string;
  line: string;
  price: number;
  /** Route segment for /product/<slug>: the storefront slug, else the storefront id, else the bundled id. */
  slug: string;
  image: { uri: string } | number | undefined;
}

export function resolveProductCard(card: CardPayload): ResolvedProductCard | null {
  const bundled = findCatalogProduct(card.id) ?? (card.slug ? PRODUCT_CATALOG.find((product) => product.slug === card.slug) : undefined);
  const name = card.name ?? bundled?.name ?? null;
  const price = card.price ?? bundled?.price ?? null;
  // A card needs at least a name and a price to be honest; a payload the app
  // cannot resolve (unknown bundled id, no copy) renders nothing rather than
  // a blank tile.
  if (name === null || price === null) return null;
  const bundledImage = bundled ? PRODUCT_IMAGES[bundled.id] : undefined;
  return {
    name,
    line: card.line ?? bundled?.cardLine ?? '',
    price,
    slug: card.slug ?? bundled?.slug ?? card.productId ?? card.id,
    image: card.imageUrl ? { uri: card.imageUrl } : (bundledImage as number | undefined),
  };
}

export function formatCardPrice(dollars: number): string {
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function ProductSuggestionCard({ payload, readOnly = false }: { payload: unknown; readOnly?: boolean }) {
  const colors = useColors();
  const card = readProductCardPayload(payload);
  const product = card ? resolveProductCard(card) : null;
  if (!card || !product) return null;
  const { price, slug } = product;

  const openProduct = () => {
    Haptics.selectionAsync();
    router.push(`/product/${slug}`);
  };

  return (
    <Pressable
      testID="coach-product-card"
      accessibilityRole="button"
      accessibilityLabel={`${product.name}, ${formatCardPrice(price)}. ${card.cta}`}
      accessibilityState={{ disabled: readOnly }}
      disabled={readOnly}
      onPress={openProduct}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: colors.border,
          backgroundColor: pressed ? colors.accent : colors.background,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      {product.image !== undefined ? (
        <Image
          testID="coach-product-image"
          source={product.image}
          style={[styles.thumb, { backgroundColor: colors.card, borderColor: colors.border }]}
          contentFit="contain"
          transition={100}
        />
      ) : (
        <View
          testID="coach-product-image-placeholder"
          style={[styles.thumb, styles.thumbPlaceholder, { backgroundColor: colors.card, borderColor: colors.border }]}
        >
          <Feather name="package" size={18} color={colors.subtleText} />
        </View>
      )}
      <View style={styles.textCol}>
        <Text style={[styles.kicker, { color: colors.labelText }]}>THINNR PRODUCT</Text>
        <Text style={[styles.name, { color: colors.navy }]} numberOfLines={1}>
          {product.name}
        </Text>
        {product.line ? (
          <Text style={[styles.line, { color: colors.bodyText }]} numberOfLines={2}>
            {product.line}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          <Text testID="coach-product-price" style={[styles.price, { color: colors.navy }]}>
            {formatCardPrice(price)}
          </Text>
          {!card.available ? (
            <Text testID="coach-product-unavailable" style={[styles.kicker, { color: colors.subtleText }]}>
              ORDERING CLOSED
            </Text>
          ) : null}
        </View>
      </View>
      <View
        testID="coach-product-view"
        style={[styles.viewBtn, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }]}
      >
        <Text style={[styles.viewText, { color: colors.primaryForeground }]}>{card.cta.toUpperCase()}</Text>
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
    borderRadius: 6,
  },
  thumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: {
    flex: 1,
    minWidth: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
    marginTop: 4,
  },
  price: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  kicker: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1.1,
    fontFamily: 'Inter_700Bold',
  },
  name: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: 'PlayfairDisplay_600SemiBold',
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
