/**
 * Approved Foods — the official THINNR-approved selections, grouped by the
 * program's own categories, every item wording quoted verbatim from the
 * official manual. Items that match a food in the database can be added
 * straight to today's diary.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { FavoriteStar } from '@/components/patient/FavoriteStar';
import { FoodAddPanel } from '@/components/patient/FoodAddPanel';
import { Divider, EmptyState, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { useAppMode } from '@/context/AppModeContext';
import {
  APPROVED_BADGE_EXPLANATION,
  APPROVED_FOOD_CATEGORIES,
  APPROVED_GROUPS,
  FOOD_BY_APPROVED_ITEM,
  approvedPortion,
  type ApprovedGroupId,
} from '@/data/approved-foods';
import { findFood } from '@/data/patient-data';

const CHIP_OPTIONS: { label: string; value: string }[] = [
  { label: 'All', value: 'all' },
  ...APPROVED_FOOD_CATEGORIES.map(c => ({ label: c.shortLabel, value: c.id })),
];

export default function ApprovedFoodsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const pathname = usePathname();

  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return APPROVED_FOOD_CATEGORIES.filter(c => catFilter === 'all' || c.id === catFilter)
      .map(category => ({
        category,
        items: category.items.filter(item => !q || item.name.toLowerCase().includes(q)),
      }))
      .filter(entry => entry.items.length > 0);
  }, [query, catFilter]);

  const itemCount = useMemo(() => visible.reduce((acc, e) => acc + e.items.length, 0), [visible]);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  // Patient-only route: deep links must not bypass the persona flow. The
  // redirect is gated on pathname so it never hijacks in-flight navigation.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (pathname !== '/approved-foods') return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/recipes');
  };

  const showConfirmation = (message: string) => {
    setConfirmation(message);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmation(null), 3200);
  };

  const renderedGroups = new Set<ApprovedGroupId>();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable
          testID="approved-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.backBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
          ]}
        >
          <Feather name="chevron-left" size={16} color={colors.bodyText} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Approved Foods</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>OFFICIAL THINNR SELECTIONS</Text>
        </View>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── What the badge means ── */}
        <LedgerCard accentTop style={styles.introCard}>
          <View style={styles.introRow}>
            <ApprovedBadge size="md" style={{ marginTop: 1 }} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.introTitle, { color: colors.navy }]}>{APPROVED_BADGE_EXPLANATION}</Text>
              <Text style={[styles.introBody, { color: colors.bodyText }]}>
                Every food below is quoted word-for-word from the official THINNR manual, with its portion
                guidance. During the protocol this list decides the "Fits your diet" mark across the app — in
                the Library, Add Food search, and your diary. Once you choose a diet, that mark follows your
                diet and your food preferences instead.
              </Text>
            </View>
          </View>
        </LedgerCard>

        {confirmation && (
          <View
            testID="approved-add-confirmation"
            style={[styles.confirmBar, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder, borderRadius: colors.radiusSm }]}
          >
            <Feather name="check-circle" size={13} color={colors.activeGreen} />
            <Text style={[styles.confirmText, { color: colors.activeGreen }]} numberOfLines={1}>
              {confirmation}
            </Text>
          </View>
        )}

        {/* ── Search ── */}
        <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}>
          <Feather name="search" size={14} color={colors.subtleText} />
          <TextInput
            testID="approved-search"
            value={query}
            onChangeText={setQuery}
            placeholder="Search approved foods..."
            placeholderTextColor={colors.subtleText}
            style={[styles.searchInput, { color: colors.foreground }]}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Feather name="x" size={14} color={colors.subtleText} />
            </Pressable>
          )}
        </View>

        {/* ── Category chips ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroll}
          contentContainerStyle={styles.chipRow}
        >
          {CHIP_OPTIONS.map(chip => {
            const isActive = chip.value === catFilter;
            return (
              <Pressable
                key={chip.value}
                testID={`approved-cat-${chip.value}`}
                onPress={() => setCatFilter(chip.value)}
                style={({ pressed }) => [
                  styles.chip,
                  {
                    backgroundColor: isActive ? colors.cobalt : colors.card,
                    borderColor: isActive ? colors.cobalt : colors.border,
                    borderRadius: colors.radiusSm,
                  },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <Text style={[styles.chipText, { color: isActive ? colors.primaryForeground : colors.bodyText }]}>
                  {chip.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={[styles.countText, { color: colors.labelText }]}>
          {itemCount} APPROVED ITEM{itemCount === 1 ? '' : 'S'}
        </Text>

        {itemCount === 0 ? (
          <LedgerCard>
            <EmptyState
              icon={<Feather name="search" size={22} color={colors.subtleText} />}
              title="No approved foods match"
              body="Try a different search or category."
            />
          </LedgerCard>
        ) : (
          visible.map(({ category, items }) => {
            const group = category.group;
            const showGroupHeader = group !== undefined && !renderedGroups.has(group);
            if (showGroupHeader && group) renderedGroups.add(group);
            return (
              <View key={category.id}>
                {showGroupHeader && group && (
                  <View style={styles.groupHeader}>
                    <Text style={[styles.groupTitle, { color: colors.navy }]}>{APPROVED_GROUPS[group].title}</Text>
                    {APPROVED_GROUPS[group].note ? (
                      <Text style={[styles.groupNote, { color: colors.bodyText }]}>
                        {APPROVED_GROUPS[group].note}
                      </Text>
                    ) : null}
                  </View>
                )}
                <View style={{ marginBottom: 14 }}>
                  <View style={styles.catHeaderRow}>
                    <Text style={[styles.catTitle, { color: colors.navyLight }]}>{category.title}</Text>
                    {category.itemPortion ? (
                      <View style={[styles.portionChip, { borderColor: colors.orangeBorder, backgroundColor: colors.orangeBg }]}>
                        <Text style={[styles.portionChipText, { color: colors.orangeText }]}>
                          {category.itemPortion}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                  <LedgerCard>
                    {items.map((item, index) => {
                      const foodId = FOOD_BY_APPROVED_ITEM[item.id];
                      const food = foodId ? findFood(foodId) : undefined;
                      const isSelected = selectedItemId === item.id;
                      const portion = approvedPortion(item, category);
                      const inlinePortion = portion && portion.length <= 20 ? portion : undefined;
                      return (
                        <View key={item.id}>
                          {index > 0 && <Divider />}
                          <Pressable
                            testID={`approved-item-${item.id}`}
                            disabled={!food}
                            onPress={() => setSelectedItemId(current => (current === item.id ? null : item.id))}
                            style={({ pressed }) => [
                              styles.itemRow,
                              isSelected && { backgroundColor: colors.sidebarBg },
                              pressed && !isSelected && { backgroundColor: colors.accent },
                            ]}
                          >
                            <ApprovedBadge size="sm" style={{ marginTop: 2 }} />
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.itemName, { color: colors.navyLight }]}>{item.name}</Text>
                              {portion && !inlinePortion ? (
                                <Text style={[styles.itemPortionLong, { color: colors.orangeText }]}>{portion}</Text>
                              ) : null}
                              {item.benefit ? (
                                <Text style={[styles.itemBenefit, { color: colors.subtleText }]}>{item.benefit}</Text>
                              ) : null}
                            </View>
                            {inlinePortion ? (
                              <Text style={[styles.itemPortion, { color: colors.orangeText }]}>{inlinePortion}</Text>
                            ) : null}
                            {food && (
                              <>
                                <FavoriteStar
                                  id={food.id}
                                  name={item.name}
                                  testID={`approved-fav-${item.id}`}
                                />
                                <Feather
                                  name={isSelected ? 'chevron-up' : 'plus-square'}
                                  size={16}
                                  color={isSelected ? colors.cobalt : colors.subtleText}
                                />
                              </>
                            )}
                          </Pressable>
                          {isSelected && food && (
                            <>
                              <Divider />
                              <FoodAddPanel
                                food={food}
                                note={`Logs as: ${food.name} · ${food.serving}`}
                                testIDPrefix="approved"
                                onAdded={message => {
                                  setSelectedItemId(null);
                                  showConfirmation(message);
                                }}
                              />
                            </>
                          )}
                        </View>
                      );
                    })}
                  </LedgerCard>
                </View>
              </View>
            );
          })
        )}

        <Text style={[styles.sourceNote, { color: colors.subtleText }]}>
          Wording quoted verbatim from the official THINNR manual — Nutrition Strategy Approved Selections and
          the Metabolic Normalization additions.
        </Text>
        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    gap: 10,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderWidth: 1,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  headerSub: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginTop: 2,
    fontFamily: 'Inter_700Bold',
  },
  content: {
    padding: 16,
  },
  introCard: {
    marginBottom: 10,
  },
  introRow: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  introTitle: {
    fontSize: 15,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    lineHeight: 20,
  },
  introBody: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  confirmBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 10,
  },
  confirmText: {
    flex: 1,
    fontSize: 11.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 38,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  chipScroll: {
    marginTop: 10,
    marginBottom: 12,
    flexGrow: 0,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 6,
  },
  chip: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  chipText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  countText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 10,
  },
  groupHeader: {
    marginBottom: 8,
  },
  groupTitle: {
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    lineHeight: 23,
  },
  groupNote: {
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  catHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
  },
  catTitle: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    lineHeight: 19,
  },
  portionChip: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 5,
  },
  portionChipText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    fontFamily: 'Inter_700Bold',
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  itemName: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    lineHeight: 17,
  },
  itemPortion: {
    fontSize: 9.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
    maxWidth: 110,
    textAlign: 'right',
  },
  itemPortionLong: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
    lineHeight: 14,
  },
  itemBenefit: {
    fontSize: 10.5,
    lineHeight: 14,
    marginTop: 3,
    fontFamily: 'Inter_400Regular',
  },
  sourceNote: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
});
