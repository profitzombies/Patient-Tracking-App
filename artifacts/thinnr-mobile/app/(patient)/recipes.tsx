/**
 * Recipes — searchable, filterable recipe library. Cards open the full
 * recipe detail page; the star toggles favorites.
 */
import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { EmptyState, LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import { MEAL_LABELS, MEAL_SLOTS, RECIPES, type MealSlot } from '@/data/patient-data';
import { RECIPE_IMAGES } from '@/data/recipe-images';

type MealFilter = 'all' | MealSlot;

const FILTER_OPTIONS: { label: string; value: MealFilter }[] = [
  { label: 'All', value: 'all' },
  ...MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot as MealFilter })),
];

export default function RecipesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [query, setQuery] = useState('');
  const [mealFilter, setMealFilter] = useState<MealFilter>('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);

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

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Recipes" subtitle="BUILT FOR YOUR PLAN" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
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
});
