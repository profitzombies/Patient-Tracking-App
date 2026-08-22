/**
 * Library — MyFitnessPal-style food & recipe library. The Recipes view keeps
 * the searchable recipe grid with starred recipes pinned first under a
 * Favorites header; the Foods view browses every food (seeded + My Foods)
 * with star-to-favorite and inline add-to-diary; the Approved Foods button
 * opens the official program list. Approved foods carry the checkmark badge.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { FavoriteStar } from '@/components/patient/FavoriteStar';
import { FoodAddPanel } from '@/components/patient/FoodAddPanel';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { Divider, EmptyState, LedgerCard, PillSelector, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import { APPROVED_BADGE_EXPLANATION, isApprovedFood } from '@/data/approved-foods';
import { MEAL_LABELS, MEAL_SLOTS, RECIPES, type FoodItem, type MealSlot, type Recipe } from '@/data/patient-data';
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
  const [foodFavoritesOnly, setFoodFavoritesOnly] = useState(false);
  // Selection tracks a row key (section + food id) instead of a bare food id:
  // a favorited food appears both in the pinned Favorites section and in its
  // category, and only the tapped copy should expand.
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
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
    // Recipes saved from coach (AI) suggestions lead; seeded staples follow.
    return [...patient.savedRecipes, ...RECIPES].filter(r => {
      if (mealFilter !== 'all' && r.meal !== mealFilter) return false;
      if (favoritesOnly && !patient.favorites.includes(r.id)) return false;
      if (!q) return true;
      const haystack = `${r.name} ${r.tags.join(' ')}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [query, mealFilter, favoritesOnly, patient.favorites, patient.savedRecipes]);

  const savedById = useMemo(
    () => new Map(patient.savedRecipes.map(r => [r.id, r])),
    [patient.savedRecipes],
  );

  const favoriteIds = useMemo(() => new Set(patient.favorites), [patient.favorites]);

  // Starred recipes lead the grid in browse mode, mirroring the Foods view's
  // pinned Favorites section. With the star filter on, everything shown is a
  // favorite, so the split would be redundant.
  const { favoriteRecipes, restRecipes } = useMemo(() => {
    if (favoritesOnly) return { favoriteRecipes: [] as Recipe[], restRecipes: filtered };
    const favs: Recipe[] = [];
    const rest: Recipe[] = [];
    for (const recipe of filtered) (favoriteIds.has(recipe.id) ? favs : rest).push(recipe);
    return { favoriteRecipes: favs, restRecipes: rest };
  }, [filtered, favoritesOnly, favoriteIds]);

  const { foodSections, foodCount } = useMemo(() => {
    const q = foodQuery.trim().toLowerCase();
    // patient.allFoods lists custom foods first, so "My Foods" leads the list.
    const matches = patient.allFoods.filter(food => {
      if (q && !`${food.name} ${food.brand ?? ''} ${food.category}`.toLowerCase().includes(q)) return false;
      if (foodFavoritesOnly && !favoriteIds.has(food.id)) return false;
      return true;
    });
    const sections: { key: string; title: string; pinned?: boolean; data: FoodItem[] }[] = [];
    // Pinned Favorites section leads in browse mode; with the star filter on,
    // everything shown is a favorite, so the pin would be redundant.
    if (!foodFavoritesOnly) {
      const favs = matches.filter(food => favoriteIds.has(food.id));
      if (favs.length > 0) sections.push({ key: 'pinned-favorites', title: 'Favorites', pinned: true, data: favs });
    }
    const indexByCategory = new Map<string, number>();
    for (const food of matches) {
      let at = indexByCategory.get(food.category);
      if (at === undefined) {
        at = sections.length;
        indexByCategory.set(food.category, at);
        sections.push({ key: `category-${food.category}`, title: food.category, data: [] });
      }
      sections[at].data.push(food);
    }
    // The count line reports distinct foods; the pinned section repeats rows.
    return { foodSections: sections, foodCount: matches.length };
  }, [patient.allFoods, foodQuery, foodFavoritesOnly, favoriteIds]);

  // Only foods the patient created can be edited or deleted — membership in
  // customFoods, not the category label, is what makes a row "My Foods".
  const customFoodIds = useMemo(() => new Set(patient.customFoods.map(f => f.id)), [patient.customFoods]);

  const confirmDeleteFood = async (food: FoodItem) => {
    await patient.removeCustomFood(food.id);
    setPendingDeleteId(null);
    setSelectedRowKey(null);
    showConfirmation(`Deleted ${food.name} from My Foods`);
  };

  const renderRecipeCard = (recipe: Recipe) => {
    const isFav = favoriteIds.has(recipe.id);
    const saved = savedById.get(recipe.id);
    const coachPhoto = saved?.photoUri;
    const isCoach = Boolean(saved);
    const staticImage = RECIPE_IMAGES[recipe.id];
    return (
      <LedgerCard
        key={recipe.id}
        testID={`recipe-card-${recipe.id}`}
        onPress={() => router.push(`/recipe/${recipe.id}`)}
        style={styles.gridCard}
      >
        <View>
          {coachPhoto || staticImage ? (
            <Image
              source={coachPhoto ? { uri: coachPhoto } : staticImage}
              style={styles.cardImage}
              contentFit="cover"
              transition={120}
            />
          ) : (
            <View style={[styles.cardImage, styles.cardImageEmpty, { backgroundColor: colors.sidebarBg }]}>
              <Feather name="image" size={18} color={colors.subtleText} />
            </View>
          )}
          {isCoach && (
            <View style={[styles.coachTag, { backgroundColor: colors.cobalt }]}>
              <Text style={[styles.coachTagText, { color: colors.primaryForeground }]}>COACH · AI</Text>
            </View>
          )}
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
  };

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
              <>
                {favoriteRecipes.length > 0 && (
                  <>
                    <SectionHeader label="Favorites" style={{ marginBottom: 8 }} />
                    <View testID="recipes-favorites-strip" style={styles.grid}>
                      {favoriteRecipes.map(recipe => renderRecipeCard(recipe))}
                    </View>
                    {restRecipes.length > 0 && (
                      <SectionHeader label="All Recipes" style={{ marginBottom: 8 }} />
                    )}
                  </>
                )}
                {restRecipes.length > 0 && (
                  <View style={styles.grid}>
                    {restRecipes.map(recipe => renderRecipeCard(recipe))}
                  </View>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {/* ── Foods: search + favorites filter ── */}
            <View style={styles.searchRow}>
              <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card }]}>
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
              <Pressable
                testID="foods-favorites-toggle"
                accessibilityRole="button"
                accessibilityState={{ selected: foodFavoritesOnly }}
                accessibilityLabel={foodFavoritesOnly ? 'Show all foods' : 'Show only favorite foods'}
                onPress={() => {
                  setFoodFavoritesOnly(v => !v);
                  setSelectedRowKey(null);
                  setPendingDeleteId(null);
                }}
                style={({ pressed }) => [
                  styles.favBtn,
                  {
                    borderColor: foodFavoritesOnly ? colors.cobalt : colors.border,
                    backgroundColor: foodFavoritesOnly ? colors.cobalt : pressed ? colors.accent : colors.card,
                  },
                ]}
              >
                <Feather
                  name="star"
                  size={15}
                  color={foodFavoritesOnly ? colors.primaryForeground : colors.bodyText}
                />
              </Pressable>
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
              {foodFavoritesOnly ? ' · FAVORITES' : ''}
            </Text>

            {foodCount === 0 ? (
              <LedgerCard>
                <EmptyState
                  icon={
                    <Feather
                      name={foodFavoritesOnly ? 'star' : 'search'}
                      size={22}
                      color={colors.subtleText}
                    />
                  }
                  title="No foods match"
                  body={
                    foodFavoritesOnly
                      ? 'Star a few foods to build your list.'
                      : 'Try a different search, or create your own food above.'
                  }
                />
              </LedgerCard>
            ) : (
              foodSections.map(section => (
                <View key={section.key} style={{ marginBottom: 14 }}>
                  <SectionHeader label={section.title} style={{ marginBottom: 8 }} />
                  <LedgerCard>
                    {section.data.map((food, index) => {
                      const rowKey = `${section.key}:${food.id}`;
                      // Pinned rows repeat foods from their category section, so
                      // their testIDs get a distinct prefix to stay unique.
                      const rowTestId = section.pinned ? `fav-${food.id}` : food.id;
                      const isSelected = selectedRowKey === rowKey;
                      const approved = isApprovedFood(food.id);
                      return (
                        <View key={food.id}>
                          {index > 0 && <Divider />}
                          <Pressable
                            testID={`food-row-${rowTestId}`}
                            onPress={() => {
                              setPendingDeleteId(null);
                              setSelectedRowKey(current => (current === rowKey ? null : rowKey));
                            }}
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
                            <FavoriteStar id={food.id} name={food.name} testID={`food-fav-${rowTestId}`} />
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
                              {customFoodIds.has(food.id) &&
                                (pendingDeleteId === food.id ? (
                                  <View
                                    testID={`food-delete-confirm-${food.id}`}
                                    style={[styles.manageBar, { backgroundColor: colors.riskBg }]}
                                  >
                                    <Text style={[styles.deletePrompt, { color: colors.riskText }]}>
                                      Delete "{food.name}" from My Foods? Diary entries you already logged keep
                                      their values.
                                    </Text>
                                    <View style={styles.manageRow}>
                                      <Pressable
                                        testID={`food-delete-cancel-${food.id}`}
                                        onPress={() => setPendingDeleteId(null)}
                                        style={({ pressed }) => [
                                          styles.manageBtn,
                                          { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                                        ]}
                                      >
                                        <Text style={[styles.manageBtnText, { color: colors.bodyText }]}>Cancel</Text>
                                      </Pressable>
                                      <Pressable
                                        testID={`food-delete-confirm-btn-${food.id}`}
                                        onPress={() => confirmDeleteFood(food)}
                                        style={({ pressed }) => [
                                          styles.manageBtn,
                                          { borderColor: colors.riskBorder, backgroundColor: colors.riskText },
                                          pressed && { opacity: 0.85 },
                                        ]}
                                      >
                                        <Feather name="trash-2" size={12} color={colors.primaryForeground} />
                                        <Text style={[styles.manageBtnText, { color: colors.primaryForeground }]}>
                                          Delete Food
                                        </Text>
                                      </Pressable>
                                    </View>
                                  </View>
                                ) : (
                                  <View style={[styles.manageBar, { backgroundColor: colors.sidebarBg }]}>
                                    <View style={styles.manageRow}>
                                      <Pressable
                                        testID={`food-edit-${food.id}`}
                                        onPress={() =>
                                          router.push({ pathname: '/create-food', params: { id: food.id } })
                                        }
                                        style={({ pressed }) => [
                                          styles.manageBtn,
                                          { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                                        ]}
                                      >
                                        <Feather name="edit-2" size={12} color={colors.bodyText} />
                                        <Text style={[styles.manageBtnText, { color: colors.bodyText }]}>Edit</Text>
                                      </Pressable>
                                      <Pressable
                                        testID={`food-delete-${food.id}`}
                                        onPress={() => setPendingDeleteId(food.id)}
                                        style={({ pressed }) => [
                                          styles.manageBtn,
                                          { borderColor: colors.riskBorder, backgroundColor: pressed ? colors.riskBg : colors.card },
                                        ]}
                                      >
                                        <Feather name="trash-2" size={12} color={colors.riskText} />
                                        <Text style={[styles.manageBtnText, { color: colors.riskText }]}>Delete</Text>
                                      </Pressable>
                                    </View>
                                  </View>
                                ))}
                              {pendingDeleteId !== food.id && (
                                <FoodAddPanel
                                  food={food}
                                  testIDPrefix="library"
                                  onAdded={message => {
                                    setSelectedRowKey(null);
                                    showConfirmation(message);
                                  }}
                                />
                              )}
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
  cardImageEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  coachTag: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  coachTagText: {
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
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
  manageBar: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  manageRow: {
    flexDirection: 'row',
    gap: 8,
  },
  manageBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 34,
    borderWidth: 1,
  },
  manageBtnText: {
    fontSize: 11.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  deletePrompt: {
    fontSize: 11,
    lineHeight: 15,
    fontFamily: 'Inter_400Regular',
    marginBottom: 8,
  },
});
