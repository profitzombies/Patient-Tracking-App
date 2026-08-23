/**
 * Restaurant Guide — the patient's eating-out hub. A compact card at the top
 * opens the full quoted guidance (app/restaurant-guide/guidance.tsx); below
 * it, the THINNR-approved restaurant directory lists every restaurant from
 * the official THINNR Restaurant Guide, each opening its approved-orders
 * page (app/restaurant-guide/[id].tsx).
 *
 * Program wording on this screen (the guide tagline, restaurant names) is
 * quoted word-for-word from the official docs archive (docs/thinnr-program/)
 * via data/restaurant-directory.ts. Do not edit quote text by hand: edit
 * data/restaurant-guide.json and run
 * scripts/check-restaurant-guide-verbatim.mjs, which verifies each quoted
 * string against the archive. App-authored copy is limited to the screen
 * title, intro, section titles, card titles/metas, and source attributions.
 */
import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Redirect, router, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { APPROVED_FOODS_HREF } from '@/constants/links';
import { RESTAURANT_GUIDE_TAGLINE, RESTAURANTS } from '@/data/restaurant-directory';

export default function RestaurantGuideScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { mode, hydrated: modeHydrated } = useAppMode();

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. The
  // guard is gated on the active pathname so it can't hijack navigation
  // while this screen unmounts.
  if (!modeHydrated) return null;
  if (pathname === '/restaurant-guide' && mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/today');
  };

  const openGuidance = () => {
    Haptics.selectionAsync();
    router.push('/restaurant-guide/guidance');
  };

  const openRestaurant = (id: string) => {
    Haptics.selectionAsync();
    router.push(`/restaurant-guide/${id}`);
  };

  const openApprovedList = () => {
    Haptics.selectionAsync();
    router.push(APPROVED_FOODS_HREF);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingTop: topPad + 8, paddingBottom: bottomPad }}>
        <View style={styles.headerRow}>
          <Pressable
            testID="guide-back-btn"
            onPress={goBack}
            hitSlop={8}
            style={({ pressed }) => [
              styles.backBtn,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
            ]}
          >
            <Feather name="arrow-left" size={17} color={colors.navy} />
          </Pressable>
          <Text style={[styles.title, { color: colors.navy }]}>Restaurant Guide</Text>
        </View>

        <Text style={[styles.intro, { color: colors.bodyText }]}>
          Eating out on the THINNR program. Start with the general guidance, then tap a
          restaurant for its approved orders — quoted word-for-word from the official program
          materials.
        </Text>

        {/* ── General eating-out guidance ── */}
        <LedgerCard testID="guide-guidance-card" onPress={openGuidance} accentTop style={styles.guidanceCard}>
          <View style={styles.linkRow}>
            <View style={[styles.linkIcon, { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
              <Feather name="book-open" size={16} color={colors.cobalt} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.linkTitle, { color: colors.navyLight }]}>General guidance</Text>
              <Text style={[styles.linkMeta, { color: colors.subtleText }]}>{RESTAURANT_GUIDE_TAGLINE}</Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.subtleText} />
          </View>
        </LedgerCard>

        {/* ── Restaurant directory, in the document's order ── */}
        <SectionHeader label="Approved restaurant options" style={styles.sectionHeader} />
        <View style={styles.directory}>
          {RESTAURANTS.map((restaurant, index) => (
            <LedgerCard
              key={restaurant.id}
              testID={`restaurant-card-${restaurant.id}`}
              onPress={() => openRestaurant(restaurant.id)}
            >
              <View style={styles.linkRow}>
                <View style={[styles.linkIcon, { backgroundColor: colors.accent, borderColor: colors.border, borderRadius: colors.radiusSm }]}>
                  <Text style={[styles.indexText, { color: colors.cobalt }]}>
                    {String(index + 1).padStart(2, '0')}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.linkTitle, { color: colors.navyLight }]}>{restaurant.name}</Text>
                  <Text style={[styles.linkMeta, { color: colors.subtleText }]}>
                    {restaurant.orders.length === 1
                      ? '1 approved order'
                      : `${restaurant.orders.length} approved orders`}
                  </Text>
                </View>
                <Feather name="chevron-right" size={16} color={colors.subtleText} />
              </View>
            </LedgerCard>
          ))}
        </View>

        {/* Cross-link to the food library's approved list */}
        <SectionHeader label="Approved foods" style={styles.sectionHeader} />
        <LedgerCard testID="guide-approved-link" onPress={openApprovedList}>
          <View style={styles.linkRow}>
            <View style={[styles.linkIcon, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, borderRadius: colors.radiusSm }]}>
              <MaterialCommunityIcons name="check-circle" size={16} color={colors.activeGreen} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.linkTitle, { color: colors.navyLight }]}>Approved list</Text>
              <Text style={[styles.linkMeta, { color: colors.subtleText }]}>
                The official approved selections, with portion guidance
              </Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.subtleText} />
          </View>
        </LedgerCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
  },
  backBtn: {
    width: 32,
    height: 32,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 22,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
  },
  intro: {
    fontSize: 12.5,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  guidanceCard: {
    marginTop: 12,
  },
  sectionHeader: {
    marginTop: 18,
    marginBottom: 8,
    paddingHorizontal: 16,
  },
  directory: {
    gap: 8,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
  },
  linkIcon: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indexText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.4,
  },
  linkTitle: {
    fontSize: 14.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  linkMeta: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
});
