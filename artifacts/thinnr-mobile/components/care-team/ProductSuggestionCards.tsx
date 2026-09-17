import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, type Href } from 'expo-router';
import type { ProductSuggestion, ProductSuggestionItem } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { cadenceLabel, formatCents } from '@/lib/cart-math';

function purchaseLabel(item: ProductSuggestionItem): string {
  return item.purchase === 'subscription'
    ? cadenceLabel(item.cadenceWeeks)
    : 'One-time';
}

export function CareTeamProductCard({ item }: { item: ProductSuggestionItem }) {
  const colors = useColors();
  const open = () => {
    void Haptics.selectionAsync();
    router.push({
      pathname: `/product/${item.productId}`,
      params: {
        purchase: item.purchase,
        cadence: item.cadenceWeeks === null ? '' : String(item.cadenceWeeks),
        quantity: String(item.quantity),
        suggestedName: item.name,
        suggestedImage: item.imageUrl ?? '',
      },
    } as Href);
  };

  return (
    <Pressable
      testID={`care-team-product-card-${item.productId}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${item.name}`}
      onPress={open}
      style={({ pressed }) => [
        styles.card,
        {
          borderColor: colors.border,
          backgroundColor: pressed ? colors.accent : colors.background,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      {item.imageUrl ? (
        <Image
          source={{ uri: item.imageUrl }}
          style={[styles.thumb, { backgroundColor: colors.card, borderColor: colors.border }]}
          contentFit="contain"
          transition={100}
        />
      ) : (
        <View style={[styles.thumb, styles.fallback, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Feather name="package" size={20} color={colors.subtleText} />
        </View>
      )}
      <View style={styles.textCol}>
        <Text style={[styles.careKicker, { color: colors.orangeText }]}>FROM YOUR CARE TEAM</Text>
        <Text style={[styles.kicker, { color: colors.labelText }]}>THINNR PRODUCT</Text>
        <Text style={[styles.name, { color: colors.navy }]}>{item.name}</Text>
        <Text style={[styles.line, { color: colors.bodyText }]}>
          {formatCents(item.unitPriceCents)} · {purchaseLabel(item)}
          {item.quantity > 1 ? ` · ×${item.quantity}` : ''}
        </Text>
        <Text style={[styles.action, { color: colors.cobalt }]}>TAP TO OPEN</Text>
      </View>
      <Feather name="chevron-right" size={15} color={colors.cobalt} />
    </Pressable>
  );
}

export function CareTeamBundleCard({
  suggestion,
  clientId,
}: {
  suggestion: ProductSuggestion;
  clientId: string;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID="care-team-bundle-card"
      accessibilityRole="button"
      accessibilityLabel={`Open bundle, ${formatCents(suggestion.totalCents)}`}
      onPress={() => {
        void Haptics.selectionAsync();
        router.push({ pathname: '/care-team-bundle', params: { clientId } } as unknown as Href);
      }}
      style={({ pressed }) => [
        styles.bundle,
        {
          borderColor: colors.border,
          backgroundColor: pressed ? colors.accent : colors.background,
          borderRadius: colors.radiusSm,
        },
      ]}
    >
      <Text style={[styles.careKicker, { color: colors.orangeText }]}>FROM YOUR CARE TEAM</Text>
      <Text style={[styles.kicker, { color: colors.labelText }]}>BUNDLE</Text>
      <View style={styles.bundleRows}>
        {suggestion.items.map(item => (
          <View key={`${item.productId}:${item.purchase}`} style={styles.bundleRow}>
            <Text style={[styles.bundleName, { color: colors.navy }]}>{item.name}</Text>
            <Text style={[styles.bundleDetail, { color: colors.bodyText }]}>
              {purchaseLabel(item)} · ×{item.quantity} · {formatCents(item.unitPriceCents * item.quantity)}
            </Text>
          </View>
        ))}
      </View>
      <View style={[styles.bundleFooter, { borderTopColor: colors.border }]}>
        <Text style={[styles.total, { color: colors.navy }]}>Total {formatCents(suggestion.totalCents)}</Text>
        <Text style={[styles.action, { color: colors.cobalt }]}>TAP TO CHECK OUT</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    padding: 10,
    marginTop: 8,
  },
  thumb: { width: 52, height: 52, borderWidth: 1, borderRadius: 6 },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  textCol: { flex: 1, minWidth: 0 },
  careKicker: { fontSize: 8, letterSpacing: 1.1, fontFamily: 'Inter_700Bold' },
  kicker: { fontSize: 8, letterSpacing: 1.1, fontFamily: 'Inter_700Bold', marginTop: 2 },
  name: { fontSize: 16, lineHeight: 20, fontFamily: 'PlayfairDisplay_600SemiBold', marginTop: 2 },
  line: { fontSize: 11, lineHeight: 15, fontFamily: 'Inter_400Regular', marginTop: 2 },
  action: { fontSize: 9, letterSpacing: 0.8, fontFamily: 'Inter_700Bold', marginTop: 6 },
  bundle: { width: '100%', borderWidth: 1, padding: 12, marginTop: 8 },
  bundleRows: { gap: 9, marginTop: 10 },
  bundleRow: { gap: 2 },
  bundleName: { fontSize: 14, fontFamily: 'PlayfairDisplay_600SemiBold' },
  bundleDetail: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  bundleFooter: { borderTopWidth: 1, marginTop: 11, paddingTop: 9 },
  total: { fontSize: 17, fontFamily: 'PlayfairDisplay_700Bold' },
});