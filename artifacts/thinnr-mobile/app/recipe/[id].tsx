/**
 * Recipe detail — hero image, per-serving nutrition, ingredients, steps,
 * and a "log it" panel that writes straight into the diary.
 */
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard, PillSelector, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import {
  findRecipe,
  MEAL_LABELS,
  MEAL_SLOTS,
  TODAY_KEY,
  type MealSlot,
} from '@/data/patient-data';
import { RECIPE_IMAGES } from '@/data/recipe-images';

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

function formatAmount(amount: number): string {
  if (amount % 1 === 0) return String(amount);
  if (amount === 0.5) return '½';
  if (amount === 0.25) return '¼';
  if (amount === 0.75) return '¾';
  return amount.toFixed(1);
}

export default function RecipeDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { id } = useLocalSearchParams<{ id: string }>();
  // Seeded recipes first; recipes saved from coach (AI) suggestions fall back.
  const staticRecipe = findRecipe(id ?? '');
  const savedRecipe = staticRecipe ? undefined : patient.savedRecipes.find(r => r.id === id);
  const recipe = staticRecipe ?? savedRecipe;

  const [meal, setMeal] = useState<MealSlot>(recipe?.meal ?? 'lunch');
  const [servings, setServings] = useState(1);
  const [logging, setLogging] = useState(false);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/recipes');
  };

  if (!recipe) {
    // Saved recipes hydrate async — don't flash "not found" before load.
    if (!patient.hydrated) return null;
    return (
      <View style={[styles.container, styles.missing, { backgroundColor: colors.background, paddingTop: topPad }]}>
        <Text style={[styles.missingText, { color: colors.bodyText }]}>Recipe not found.</Text>
        <Pressable onPress={goBack} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Text style={[styles.missingLink, { color: colors.cobalt }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const isFav = patient.favorites.includes(recipe.id);
  const totalCals = Math.round(recipe.calories * servings);

  const logRecipe = async () => {
    if (logging) return;
    setLogging(true);
    try {
      await patient.addEntry({
        dateKey: TODAY_KEY,
        meal,
        kind: 'recipe',
        refId: recipe.id,
        name: recipe.name,
        detail: `${servings} serving${servings === 1 ? '' : 's'} · ${savedRecipe ? 'AI estimate' : 'recipe'}`,
        quantity: servings,
        calories: totalCals,
        protein: Math.round(recipe.protein * servings),
        carbs: Math.round(recipe.carbs * servings),
        fat: Math.round(recipe.fat * servings),
      });
      goBack();
    } finally {
      setLogging(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.background }]}>
        <Pressable
          testID="recipe-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.labelText }]}>
          {savedRecipe ? 'COACH RECIPE · AI' : 'RECIPE'}
        </Text>
        <Pressable
          testID="recipe-detail-fav"
          onPress={() => patient.toggleFavorite(recipe.id)}
          style={({ pressed }) => [
            styles.topBtn,
            {
              borderColor: isFav ? colors.cobalt : colors.border,
              backgroundColor: isFav ? colors.cobalt : pressed ? colors.accent : colors.card,
            },
          ]}
        >
          <Feather name="star" size={15} color={isFav ? colors.primaryForeground : colors.bodyText} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        {savedRecipe?.photoUri ? (
          <Image source={{ uri: savedRecipe.photoUri }} style={styles.hero} contentFit="cover" transition={150} />
        ) : RECIPE_IMAGES[recipe.id] ? (
          <Image source={RECIPE_IMAGES[recipe.id]} style={styles.hero} contentFit="cover" transition={150} />
        ) : (
          <View style={[styles.hero, styles.heroEmpty, { backgroundColor: colors.sidebarBg }]}>
            <Feather name="image" size={20} color={colors.subtleText} />
          </View>
        )}

        <View style={styles.body}>
          <Text style={[styles.name, { color: colors.navy }]}>{recipe.name}</Text>
          <Text style={[styles.description, { color: colors.bodyText }]}>{recipe.description}</Text>

          <View style={styles.chipRow}>
            <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="clock" size={11} color={colors.cobalt} />
              <Text style={[styles.chipText, { color: colors.bodyText }]}>{recipe.minutes} MIN</Text>
            </View>
            <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="users" size={11} color={colors.cobalt} />
              <Text style={[styles.chipText, { color: colors.bodyText }]}>MAKES {recipe.servings}</Text>
            </View>
            <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Text style={[styles.chipText, { color: colors.bodyText }]}>{MEAL_LABELS[recipe.meal].toUpperCase()}</Text>
            </View>
          </View>

          {/* ── Nutrition per serving ── */}
          <LedgerCard style={{ padding: 16, marginTop: 16 }}>
            <Text style={[styles.cardLabel, { color: colors.labelText }]}>
              {savedRecipe ? 'ESTIMATED NUTRITION · PER SERVING' : 'NUTRITION · PER SERVING'}
            </Text>
            <View style={styles.nutritionRow}>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionBig, { color: colors.navy }]}>{recipe.calories}</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>CALORIES</Text>
              </View>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionValue, { color: colors.cobalt }]}>{recipe.protein}g</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>PROTEIN</Text>
              </View>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionValue, { color: colors.navyLight }]}>{recipe.carbs}g</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>CARBS</Text>
              </View>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionValue, { color: colors.navyLight }]}>{recipe.fat}g</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>FAT</Text>
              </View>
            </View>
            {savedRecipe && (
              <Text style={[styles.estimateNote, { color: colors.subtleText }]}>
                AI estimates — actual values depend on your exact ingredients.
              </Text>
            )}
          </LedgerCard>

          {/* ── Ingredients ── */}
          <SectionHeader label="Ingredients" value={`Makes ${recipe.servings} serving${recipe.servings === 1 ? '' : 's'}`} style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ paddingVertical: 4 }}>
            {recipe.ingredients.map((ingredient, index) => (
              <View key={`${ingredient.name}-${index}`}>
                {index > 0 && <Divider />}
                <View style={styles.ingredientRow}>
                  <View style={[styles.ingredientDot, { backgroundColor: colors.cobalt }]} />
                  <Text style={[styles.ingredientText, { color: colors.bodyText }]}>
                    {ingredient.amount > 0 ? (
                      <>
                        <Text style={{ fontFamily: 'Inter_600SemiBold', color: colors.navyLight }}>
                          {formatAmount(ingredient.amount)}{ingredient.unit ? ` ${ingredient.unit}` : ''}
                        </Text>
                        {` ${ingredient.name}`}
                      </>
                    ) : (
                      <>
                        {ingredient.name}
                        <Text style={{ color: colors.subtleText }}> — to taste</Text>
                      </>
                    )}
                  </Text>
                </View>
              </View>
            ))}
          </LedgerCard>

          {/* ── Steps ── */}
          <SectionHeader label="Directions" style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ paddingVertical: 4 }}>
            {recipe.steps.map((step, index) => (
              <View key={index}>
                {index > 0 && <Divider />}
                <View style={styles.stepRow}>
                  <View style={[styles.stepNum, { backgroundColor: colors.sidebarBg }]}>
                    <Text style={[styles.stepNumText, { color: colors.cobalt }]}>{index + 1}</Text>
                  </View>
                  <Text style={[styles.stepText, { color: colors.bodyText }]}>{step}</Text>
                </View>
              </View>
            ))}
          </LedgerCard>

          {/* ── Grocery list (saved cravings fixes) ── */}
          {savedRecipe?.groceryList && savedRecipe.groceryList.length > 0 && (
            <>
              <SectionHeader label="Grocery List" style={{ marginTop: 18, marginBottom: 8 }} />
              <LedgerCard style={{ paddingVertical: 4 }}>
                {savedRecipe.groceryList.map((item, index) => (
                  <View key={`${item}-${index}`}>
                    {index > 0 && <Divider />}
                    <View style={styles.ingredientRow}>
                      <Feather name="square" size={11} color={colors.cobalt} />
                      <Text style={[styles.ingredientText, { color: colors.bodyText }]}>{item}</Text>
                    </View>
                  </View>
                ))}
              </LedgerCard>
            </>
          )}

          {/* ── Log it ── */}
          <SectionHeader label="Add to Diary" style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ padding: 16 }}>
            <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} />
            <View style={styles.servingRow}>
              <Text style={[styles.servingLabel, { color: colors.labelText }]}>SERVINGS TO LOG</Text>
              <View style={styles.servingControls}>
                <Pressable
                  testID="recipe-servings-minus"
                  onPress={() => setServings(s => Math.max(1, s - 1))}
                  disabled={servings <= 1}
                  style={({ pressed }) => [
                    styles.stepBtn,
                    { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                    servings <= 1 && { opacity: 0.35 },
                  ]}
                >
                  <Feather name="minus" size={13} color={colors.bodyText} />
                </Pressable>
                <Text style={[styles.servingValue, { color: colors.navy }]}>{servings}</Text>
                <Pressable
                  testID="recipe-servings-plus"
                  onPress={() => setServings(s => Math.min(6, s + 1))}
                  disabled={servings >= 6}
                  style={({ pressed }) => [
                    styles.stepBtn,
                    { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                    servings >= 6 && { opacity: 0.35 },
                  ]}
                >
                  <Feather name="plus" size={13} color={colors.bodyText} />
                </Pressable>
              </View>
            </View>
            <Pressable
              testID="recipe-log-btn"
              onPress={logRecipe}
              disabled={logging}
              style={({ pressed }) => [
                styles.logBtn,
                { backgroundColor: colors.cobalt },
                (pressed || logging) && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.logBtnText, { color: colors.primaryForeground }]}>
                Add {totalCals.toLocaleString('en-US')} cal to {MEAL_LABELS[meal]}
              </Text>
            </Pressable>
            <Text style={[styles.logHint, { color: colors.subtleText }]}>Logs to today's diary</Text>
          </LedgerCard>

          <SyntheticDisclaimer />
        </View>
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
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
  },
  hero: {
    width: '100%',
    height: 210,
  },
  heroEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  estimateNote: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 12,
  },
  body: {
    padding: 16,
  },
  name: {
    fontSize: 21,
    fontWeight: '700',
    letterSpacing: -0.6,
    fontFamily: 'Inter_700Bold',
  },
  description: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 6,
    fontFamily: 'Inter_400Regular',
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  chipText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  nutritionRow: {
    flexDirection: 'row',
    marginTop: 12,
    alignItems: 'flex-end',
  },
  nutritionCol: {
    flex: 1,
  },
  nutritionBig: {
    fontSize: 26,
    fontWeight: '600',
    letterSpacing: -1,
    fontFamily: 'Inter_600SemiBold',
  },
  nutritionValue: {
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: -0.4,
    fontFamily: 'Inter_600SemiBold',
  },
  nutritionLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
  },
  ingredientRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  ingredientDot: {
    width: 5,
    height: 5,
  },
  ingredientText: {
    fontSize: 12.5,
    fontFamily: 'Inter_400Regular',
    flex: 1,
    lineHeight: 18,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  stepNum: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  stepText: {
    fontSize: 12.5,
    lineHeight: 18,
    flex: 1,
    fontFamily: 'Inter_400Regular',
  },
  servingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  servingLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  servingControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepBtn: {
    width: 28,
    height: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  servingValue: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    minWidth: 22,
    textAlign: 'center',
  },
  logBtn: {
    marginTop: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  logBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  logHint: {
    fontSize: 10,
    marginTop: 8,
    textAlign: 'center',
    fontFamily: 'Inter_400Regular',
  },
});
