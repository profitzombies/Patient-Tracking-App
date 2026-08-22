/**
 * Library — MyFitnessPal-style food & recipe library. The Recipes view keeps
 * the searchable recipe grid; the Foods view browses every food (seeded +
 * My Foods) with inline add-to-diary; the Approved Foods button opens the
 * official program list. Approved foods carry the checkmark badge.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { FoodAddPanel } from '@/components/patient/FoodAddPanel';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { Divider, EmptyState, LedgerCard, PillSelector, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import { APPROVED_BADGE_EXPLANATION, isApprovedFood } from '@/data/approved-foods';
import { MEAL_LABELS, MEAL_SLOTS, RECIPES, type FoodItem, type MealSlot } from '@/data/patient-data';
import { RECIPE_IMAGES } from '@/data/recipe-images';

type MealFilter = 'all' | MealSlot;
type LibraryView = 'recipes' | 'foods';

const FILTER_OPTIONS: { label: string; value: MealFilter }[] = [
  { label: 'All', value: 'all' },
  ...MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot as MealFilter })),
];

const VIEW_OPTIONS: { label: string; value: LibraryView }[] = [
  { label: 'Recipes', value: 'recipes' },
  { label: 'Foods', value: 'foods' },
];

export default function LibraryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [view, setView] = useState<LibraryView>('recipes');

  // Recipes view state
  const [query, setQuery] = useState('');
  const [mealFilter, setMealFilter] = useState<MealFilter>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // Foods view state
  const [foodQuery, setFoodQuery] = useState('');
  const [selectedFoodId, setSelectedFoodId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );
  const showConfirmation = (message: string) => {
    setConfirmation(message);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmation(null), 3200);
  };

  const bottomPad = Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return RECIPES.filter(r => {
      if (mealFilter !== 'all' && r.meal !== mealFilter) return false;
      if (favoritesOnly && !patient.favorites.includes(r.id)) return false;
      if (!q) return true;
      const haystack = `${r.name} ${r.tags.join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, mealFilter, favoritesOnly, patient.favorites]);

  const foodSections = useMemo(() => {
    const q = foodQuery.trim().toLowerCase();
    const sections: { title: string; data: FoodItem[] }[] = [];
    const indexByCategory = new Map<string, number>();
    // patient.allFoods lists custom foods first, so "My Foods" leads the list.
    for (const food of patient.allFoods) {
      if (q && !`${food.name} ${food.brand ?? ''} ${food.category}`.toLowerCase().includes(q)) continue;
      let at = indexByCategory.get(food.category);
      if (at === undefined) {
        at = sections.length;
        indexByCategory.set(food.category, at);
        sections.push({ title: food.category, data: [] });
      }
      sections[at].data.push(food);
    }
    return sections;
  }, [patient.allFoods, foodQuery]);

  const foodCount = useMemo(() => foodSections.reduce((acc, s) => acc + s.data.length, 0), [foodSections]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Library" subtitle="FOODS & RECIPES FOR YOUR PLAN" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Approved Foods entry point ── */}
        <LedgerCard
          testID="library-approved-foods-btn"
          onPress={() => router.push('/approved-foods')}
          style={styles.approvedCard}
        >
          <View style={styles.approvedRow}>
            <View style={[styles.approvedIcon, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
              <Feather name="check" size={16} color={colors.activeGreen} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.approvedTitle, { color: colors.navy }]}>Approved Foods</Text>
              <Text style={[styles.approvedSub, { color: colors.subtleText }]}>
                Official THINNR selections with portion guidance
              </Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.subtleText} />
          </View>
        </LedgerCard>

        <PillSelector options={VIEW_OPTIONS} selected={view} onSelect={setView} style={{ marginBottom: 12 }} />

        {view === 'recipes' ? (
          <>
            {/* ── Search + favorites filter ── */}
            <View style={styles.searchRow}>
              <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="search" size={14} color={colors.subtleText} />
                <TextInput
                  testID="recipes-search"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search recipes..."
                  placeholderTextColor={colors.subtleText}
                  style={[styles.searchInput, { color: colors.foreground }]}
                />
                {query.length > 0 && (
                  <Pressable onPress={() => setQuery('')} hitSlop={8}>
                    <Feather name="x" size={14} color={colors.subtleText} />
                  </Pressable>
                )}
              </View>
              <Pressable
                testID="recipes-favorites-toggle"
                onPress={() => setFavoritesOnly(v => !v)}
                style={({ pressed }) => [
                  styles.favBtn,
                  {
                    borderColor: favoritesOnly ? colors.cobalt : colors.border,
                    backgroundColor: favoritesOnly ? colors.cobalt : pressed ? colors.accent : colors.card,
                  },
                ]}
              >
                <Feather
                  name="star"
                  size={15}
                  color={favoritesOnly ? colors.primaryForeground : colors.bodyText}
                />
              </Pressable>
            </View>

            <PillSelector
              options={FILTER_OPTIONS}
              selected={mealFilter}
              onSelect={setMealFilter}
              style={{ marginBottom: 14 }}
            />

            <Text style={[styles.countText, { color: colors.labelText }]}>
              {filtered.length} RECIPE{filtered.length === 1 ? '' : 'S'}
              {favoritesOnly ? ' · FAVORITES' : ''}
            </Text>

            {filtered.length === 0 ? (
              <LedgerCard>
                <EmptyState
                  icon={<Feather name="book-open" size={22} color={colors.subtleText} />}
                  title="No recipes match"
                  body={favoritesOnly ? 'Star a few recipes to build your favorites list.' : 'Try a different search or meal filter.'}
                />
              </LedgerCard>
            ) : (
              <View style={styles.grid}>
                {filtered.map(recipe => {
                  const isFav = patient.favorites.includes(recipe.id);
                  return (
                    <LedgerCard
                      key={recipe.id}
                      testID={`recipe-card-${recipe.id}`}
                      onPress={() => router.push(`/recipe/${recipe.id}`)}
                      style={styles.gridCard}
                    >
                      <View>
                        <Image
                          source={RECIPE_IMAGES[recipe.id]}
                          style={styles.cardImage}
                          contentFit="cover"
                          transition={120}
                        />
                        <Pressable
                          testID={`recipe-fav-${recipe.id}`}
                          onPress={() => patient.toggleFavorite(recipe.id)}
                          hitSlop={6}
                          style={[
                            styles.starBtn,
                            {
                              backgroundColor: isFav ? colors.cobalt : colors.card,
                              borderColor: isFav ? colors.cobalt : colors.border,
                            },
                          ]}
                        >
                          <Feather
                            name="star"
                            size={13}
                            color={isFav ? colors.primaryForeground : colors.bodyText}
                          />
                        </Pressable>
                      </View>
                      <View style={styles.cardBody}>
                        <Text style={[styles.cardName, { color: colors.navyLight }]} numberOfLines={2}>
                          {recipe.name}
                        </Text>
                        <Text style={[styles.cardMeta, { color: colors.subtleText }]}>
                          {recipe.calories} cal · {recipe.minutes} min
                        </Text>
                        <View style={styles.cardTagRow}>
                          <View style={[styles.proteinTag, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                            <Text style={[styles.proteinTagText, { color: colors.activeGreen }]}>P {recipe.protein}g</Text>
                          </View>
                          <Text style={[styles.mealTag, { color: colors.labelText }]}>
                            {MEAL_LABELS[recipe.meal].toUpperCase()}
                          </Text>
                        </View>
                      </View>
                    </LedgerCard>
                  );
                })}
              </View>
            )}
          </>
        ) : (
          <>
            {/* ── Foods: search ── */}
            <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card, marginBottom: 10 }]}>
              <Feather name="search" size={14} color={colors.subtleText} />
              <TextInput
                testID="foods-search"
                value={foodQuery}
                onChangeText={setFoodQuery}
                placeholder="Search all foods..."
                placeholderTextColor={colors.subtleText}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {foodQuery.length > 0 && (
                <Pressable onPress={() => setFoodQuery('')} hitSlop={8}>
                  <Feather name="x" size={14} color={colors.subtleText} />
                </Pressable>
              )}
            </View>

            {/* ── Create food entry point ── */}
            <LedgerCard testID="library-create-food" onPress={() => router.push('/create-food')} style={{ marginBottom: 10 }}>
              <View style={styles.createRow}>
                <View style={[styles.createIcon, { backgroundColor: colors.cobalt }]}>
                  <Feather name="plus" size={14} color={colors.primaryForeground} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.createTitle, { color: colors.navy }]}>Create a Food</Text>
                  <Text style={[styles.createSub, { color: colors.subtleText }]}>
                    Name, serving, and nutrition — saved to My Foods
                  </Text>
                </View>
                <Feather name="chevron-right" size={16} color={colors.subtleText} />
              </View>
            </LedgerCard>

            <View style={styles.legendRow}>
              <ApprovedBadge size="sm" />
              <Text style={[styles.legendText, { color: colors.subtleText }]}>= {APPROVED_BADGE_EXPLANATION}</Text>
            </View>

            {confirmation && (
              <View
                testID="library-add-confirmation"
                style={[styles.confirmBar, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}
              >
                <Feather name="check-circle" size={13} color={colors.activeGreen} />
                <Text style={[styles.confirmText, { color: colors.activeGreen }]} numberOfLines={1}>
                  {confirmation}
                </Text>
              </View>
            )}

            <Text style={[styles.countText, { color: colors.labelText }]}>
              {foodCount} FOOD{foodCount === 1 ? '' : 'S'}
            </Text>

            {foodCount === 0 ? (
              <LedgerCard>
                <EmptyState
                  icon={<Feather name="search" size={22} color={colors.subtleText} />}
                  title="No foods match"
                  body="Try a different search, or create your own food above."
                />
              </LedgerCard>
            ) : (
              foodSections.map(section => (
                <View key={section.title} style={{ marginBottom: 14 }}>
                  <SectionHeader label={section.title} style={{ marginBottom: 8 }} />
                  <LedgerCard>
                    {section.data.map((food, index) => {
                      const isSelected = selectedFoodId === food.id;
                      const approved = isApprovedFood(food.id);
                      return (
                        <View key={food.id}>
                          {index > 0 && <Divider />}
                          <Pressable
                            testID={`food-row-${food.id}`}
                            onPress={() => setSelectedFoodId(current => (current === food.id ? null : food.id))}
                            style={({ pressed }) => [
                              styles.foodRow,
                              isSelected && { backgroundColor: colors.sidebarBg },
                              pressed && !isSelected && { backgroundColor: colors.accent },
                            ]}
                          >
                            <View style={{ flex: 1 }}>
                              <View style={styles.foodNameRow}>
                                <Text
                                  style={[styles.foodName, { color: colors.navyLight }]}
                                  numberOfLines={1}
                                >
                                  {food.name}
                                </Text>
                                {approved && <ApprovedBadge size="sm" />}
                              </View>
                              <Text style={[styles.foodSub, { color: colors.subtleText }]} numberOfLines={1}>
                                {food.brand ?? food.category} · {food.serving} · P {food.protein}g
                              </Text>
                            </View>
                            <Text style={[styles.foodCals, { color: colors.navyLight }]}>{food.calories}</Text>
                            <Feather
                              name={isSelected ? 'chevron-up' : 'plus-square'}
                              size={16}
                              color={isSelected ? colors.cobalt : colors.subtleText}
                            />
                          </Pressable>
                          {isSelected && (
                            <>
                              <Divider />
                              <FoodAddPanel
                                food={food}
                                testIDPrefix="library"
                                onAdded={message => {
                                  setSelectedFoodId(null);
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
              ))
            )}
          </>
        )}

        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  approvedCard: {
    marginBottom: 12,
  },
  approvedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  approvedIcon: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approvedTitle: {
    fontSize: 13.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.2,
  },
  approvedSub: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  searchBox: {
    flex: 1,
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
  favBtn: {
    width: 38,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 10,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  gridCard: {
    width: '48.4%',
    marginBottom: 12,
  },
  cardImage: {
    width: '100%',
    height: 108,
  },
  starBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    padding: 10,
  },
  cardName: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    lineHeight: 16,
    minHeight: 32,
  },
  cardMeta: {
    fontSize: 10.5,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  cardTagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  proteinTag: {
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  proteinTagText: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  mealTag: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  createIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createTitle: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  createSub: {
    fontSize: 10.5,
    marginTop: 1,
    fontFamily: 'Inter_400Regular',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  legendText: {
    fontSize: 10.5,
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
  foodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  foodNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  foodName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  foodSub: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  foodCals: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
});
