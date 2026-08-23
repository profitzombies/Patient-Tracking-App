/**
 * Restaurant detail — one THINNR-approved restaurant's order options, quoted
 * word-for-word from the official THINNR Restaurant Guide
 * (docs/thinnr-program/restaurant-guide.txt) via data/restaurant-directory.ts.
 * scripts/check-restaurant-guide-verbatim.mjs guards the wording.
 *
 * Follows the phase-detail pattern: Heritage card styling, pathname-gated
 * persona redirect, back-to-guide fallback, and a not-found state for bad ids.
 */
import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { RESTAURANT_GUIDE_SOURCE, restaurantById } from '@/data/restaurant-directory';

export default function RestaurantDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { id } = useLocalSearchParams<{ id: string }>();

  const restaurant = restaurantById(id);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it can't hijack in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (!pathname.startsWith('/restaurant-guide')) return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/restaurant-guide');
  };

  if (!restaurant) {
    return (
      <View
        style={[styles.container, styles.missing, { backgroundColor: colors.background, paddingTop: topPad }]}
      >
        <Text style={[styles.missingText, { color: colors.bodyText }]}>Restaurant not found.</Text>
        <Pressable
          testID="restaurant-missing-back"
          onPress={goBack}
          style={({ pressed }) => [pressed && { opacity: 0.7 }]}
        >
          <Text style={[styles.missingLink, { color: colors.cobalt }]}>Back to the Restaurant Guide</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View
        style={[
          styles.topBar,
          { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt },
        ]}
      >
        <Pressable
          testID="restaurant-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            {
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.navy }]} numberOfLines={1}>
          {restaurant.name}
        </Text>
        <View style={styles.topSpacer} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        <LedgerCard accentTop>
          <View style={styles.cardHeader}>
            <Text style={[styles.cardLabel, { color: colors.labelText }]}>THINNR-APPROVED ORDERS</Text>
            <Text style={[styles.cardTitle, { color: colors.navy }]}>{restaurant.name}</Text>
            <Text style={[styles.cardMeta, { color: colors.subtleText }]}>
              {restaurant.orders.length === 1
                ? '1 order option from the official guide'
                : `${restaurant.orders.length} order options from the official guide`}
            </Text>
          </View>
          {restaurant.orders.map((order, index) => (
            <View key={index}>
              <Divider />
              <View style={styles.orderRow}>
                <Text style={[styles.orderIndex, { color: colors.cobalt }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <Text style={[styles.orderText, { color: colors.bodyText }]}>{order}</Text>
              </View>
            </View>
          ))}
          <Divider />
          <Text style={[styles.source, { color: colors.labelText }]}>{RESTAURANT_GUIDE_SOURCE}</Text>
        </LedgerCard>
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
    flex: 1,
    textAlign: 'center',
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.2,
    marginHorizontal: 8,
  },
  topSpacer: {
    width: 34,
    height: 34,
  },
  content: {
    padding: 16,
  },
  cardHeader: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 14,
  },
  cardLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  cardTitle: {
    fontSize: 21,
    marginTop: 6,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
  },
  cardMeta: {
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  orderRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  orderIndex: {
    width: 22,
    fontSize: 10,
    lineHeight: 19.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.4,
  },
  orderText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19.5,
    fontFamily: 'Inter_400Regular',
  },
  source: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
});
