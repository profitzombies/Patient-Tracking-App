/**
 * Recipe detail — hero image, per-serving nutrition, an ingredient breakdown
 * with editable amounts (per-ingredient facts, live-rescaled totals), steps,
 * and a "log it" panel that writes straight into the diary. Opened with
 * `?entry=<id>` from the diary, it instead edits that logged entry's
 * ingredient amounts through the normal entry-edit state (undo keeps working).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
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
  type IngredientAdjustment,
  type MealSlot,
} from '@/data/patient-data';
import {
  adjustedPerServing,
  roundNutrition,
  sameAdjustments,
  sanitizeAdjustments,
  totalsForQuantity,
} from '@/data/ingredient-nutrition';
import { withAdjustedTag } from '@/data/diary-entries';
import { IngredientBreakdown } from '@/components/patient/IngredientBreakdown';
import { RECIPE_IMAGES } from '@/data/recipe-images';

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

export default function RecipeDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { id, entry: entryParam, date: dateParam, meal: mealParam } = useLocalSearchParams<{
    id: string;
    entry?: string;
    date?: string;
    meal?: string;
  }>();

  // When opened from Add Food, the caller passes the target date and meal.
  const paramDateKey =
    typeof dateParam === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)
      ? dateParam
      : patient.todayKey;
  const validMealParam = MEAL_SLOTS.includes(mealParam as MealSlot)
    ? (mealParam as MealSlot)
    : undefined;
  // Seeded recipes first; recipes saved from coach (AI) suggestions fall back.
  const staticRecipe = findRecipe(id ?? '');
  const savedRecipe = staticRecipe ? undefined : patient.savedRecipes.find(r => r.id === id);
  const recipe = staticRecipe ?? savedRecipe;
  // Entry mode: opened from a logged diary row to adjust THAT entry. The
  // entry must reference THIS recipe (refId === route id) — otherwise a
  // crafted/mismatched link could apply one recipe's ingredient indices to a
  // different logged recipe; such links fall back to plain recipe view.
  const diaryEntry = entryParam
    ? patient.allEntries.find(
        e => e.id === entryParam && e.kind === 'recipe' && e.refId === id,
      )
    : undefined;

  const [meal, setMeal] = useState<MealSlot>(validMealParam ?? recipe?.meal ?? 'lunch');
  const [servings, setServings] = useState(1);
  const [logging, setLogging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adjustments, setAdjustments] = useState<IngredientAdjustment[]>([]);

  // Seed the editor from the entry's stored adjustments once it hydrates.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!entryParam || seededFor.current === entryParam) return;
    if (!diaryEntry || !recipe) return;
    seededFor.current = entryParam;
    setAdjustments(sanitizeAdjustments(recipe.ingredients, diaryEntry.adjustments));
  }, [entryParam, diaryEntry, recipe]);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;
  // Extra scroll room so content clears the sticky log footer.
  const stickyFooterHeight = 64;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }
  // Entry links need the diary state; don't flash the log panel before load.
  if (entryParam && !patient.hydrated) return null;

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
  const sanitized = sanitizeAdjustments(recipe.ingredients, adjustments);
  const isAdjusted = sanitized.length > 0;
  const perServing = adjustedPerServing(
    { calories: recipe.calories, protein: recipe.protein, carbs: recipe.carbs, fat: recipe.fat },
    recipe.ingredients,
    sanitized,
  );
  const perServingDisplay = roundNutrition(perServing);
  const totalCals = Math.round(perServing.calories * servings);

  const entryMode = !!diaryEntry;
  const storedAdjustments = diaryEntry
    ? sanitizeAdjustments(recipe.ingredients, diaryEntry.adjustments)
    : [];
  const dirty = entryMode && !sameAdjustments(sanitized, storedAdjustments);
  const entryTotals = diaryEntry ? totalsForQuantity(perServing, diaryEntry.quantity) : null;

  const logRecipe = async () => {
    if (logging) return;
    setLogging(true);
    try {
      const baseDetail = `${servings} serving${servings === 1 ? '' : 's'} · ${savedRecipe ? 'AI estimate' : 'recipe'}`;
      const totals = totalsForQuantity(perServing, servings);
      await patient.addEntry({
        dateKey: paramDateKey,
        meal,
        kind: 'recipe',
        refId: recipe.id,
        name: recipe.name,
        detail: isAdjusted ? withAdjustedTag(baseDetail) : baseDetail,
        quantity: servings,
        calories: totals.calories,
        protein: totals.protein,
        carbs: totals.carbs,
        fat: totals.fat,
        ...(isAdjusted ? { adjustments: sanitized } : {}),
      });
      // If opened from Add Food (date param present), dismiss the whole modal
      // stack so the patient lands back on the diary, not the search screen.
      if (dateParam && router.canDismiss()) {
        router.dismiss();
      } else {
        goBack();
      }
    } finally {
      setLogging(false);
    }
  };

  // Entry mode: write the adjusted totals back through the normal entry-edit
  // state, so the diary's Edit/Undo flows treat this like any other edit.
  const saveAdjustments = async () => {
    if (!diaryEntry || saving) return;
    setSaving(true);
    try {
      await patient.updateEntry(diaryEntry.id, {
        meal: diaryEntry.meal,
        quantity: diaryEntry.quantity,
        nutrition: totalsForQuantity(perServing, diaryEntry.quantity),
        adjustments: sanitized.length > 0 ? sanitized : null,
      });
      goBack();
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable
          testID="recipe-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.labelText }]}>
          {savedRecipe ? 'COACH RECIPE · AI' : 'RECIPE'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            testID="recipe-detail-fav"
            onPress={() => patient.toggleFavorite(recipe.id)}
            style={({ pressed }) => [
              styles.topBtn,
              {
                borderColor: isFav ? colors.cobalt : colors.border,
                backgroundColor: isFav ? colors.cobalt : pressed ? colors.accent : colors.card,
                borderRadius: colors.radiusSm,
              },
            ]}
          >
            <Feather name="star" size={15} color={isFav ? colors.primaryForeground : colors.bodyText} />
          </Pressable>
          {!entryMode && (
            <Pressable
              testID="recipe-header-log"
              onPress={logRecipe}
              disabled={logging}
              accessibilityLabel={`Log ${recipe.name} to ${MEAL_LABELS[meal]}`}
              style={({ pressed }) => [
                styles.topBtn,
                {
                  borderColor: colors.cobalt,
                  backgroundColor: pressed || logging ? colors.cobalt : colors.card,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Feather name="plus-circle" size={15} color={logging ? colors.primaryForeground : colors.cobalt} />
            </Pressable>
          )}
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: entryMode ? bottomPad : bottomPad + stickyFooterHeight }}>
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
            {/* Meals saved from a photo have no cook time (minutes 0) — the
                chip only makes sense for actual recipes. */}
            {recipe.minutes > 0 && (
              <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="clock" size={11} color={colors.orange} />
                <Text style={[styles.chipText, { color: colors.bodyText }]}>{recipe.minutes} MIN</Text>
              </View>
            )}
            <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Feather name="users" size={11} color={colors.orange} />
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
                <Text style={[styles.nutritionBig, { color: colors.navy }]}>{perServingDisplay.calories}</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>CALORIES</Text>
              </View>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionValue, { color: colors.cobalt }]}>{perServingDisplay.protein}g</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>PROTEIN</Text>
              </View>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionValue, { color: colors.navyLight }]}>{perServingDisplay.carbs}g</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>CARBS</Text>
              </View>
              <View style={styles.nutritionCol}>
                <Text style={[styles.nutritionValue, { color: colors.navyLight }]}>{perServingDisplay.fat}g</Text>
                <Text style={[styles.nutritionLabel, { color: colors.labelText }]}>FAT</Text>
              </View>
            </View>
            {isAdjusted && (
              <Text style={[styles.estimateNote, { color: colors.cobalt }]}>
                Includes your ingredient adjustments.
              </Text>
            )}
            {savedRecipe && (
              <Text style={[styles.estimateNote, { color: colors.subtleText }]}>
                AI estimates — actual values depend on your exact ingredients.
              </Text>
            )}
          </LedgerCard>

          {/* ── Ingredients ── */}
          <SectionHeader
            label="Ingredients"
            value={`Makes ${recipe.servings} serving${recipe.servings === 1 ? '' : 's'}`}
            action={isAdjusted ? { label: 'Reset amounts', onPress: () => setAdjustments([]) } : undefined}
            style={{ marginTop: 18, marginBottom: 8 }}
          />
          <LedgerCard style={{ paddingVertical: 4 }}>
            <IngredientBreakdown
              ingredients={recipe.ingredients}
              adjustments={adjustments}
              onChange={setAdjustments}
              estimated={!!savedRecipe}
            />
          </LedgerCard>

          {/* ── Steps (meals saved from a photo have nothing to cook) ── */}
          {recipe.steps.length > 0 && (
            <>
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
            </>
          )}

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

          {/* ── Update the logged entry (entry mode) or log it fresh ── */}
          {entryMode && diaryEntry && entryTotals ? (
            <>
              <SectionHeader label="Update This Entry" style={{ marginTop: 18, marginBottom: 8 }} />
              <LedgerCard style={{ padding: 16 }}>
                <Text style={[styles.servingLabel, { color: colors.labelText }]}>
                  LOGGED · {diaryEntry.quantity} SERVING{diaryEntry.quantity === 1 ? '' : 'S'} · {MEAL_LABELS[diaryEntry.meal].toUpperCase()}
                </Text>
                <Text style={[styles.entryTotals, { color: colors.bodyText }]}>
                  New totals:{' '}
                  <Text style={{ fontFamily: 'Inter_600SemiBold', color: colors.navy }}>
                    {entryTotals.calories.toLocaleString('en-US')} cal
                  </Text>
                  {` · P ${entryTotals.protein}g · C ${entryTotals.carbs}g · F ${entryTotals.fat}g`}
                </Text>
                <Pressable
                  testID="entry-save-adjust"
                  onPress={saveAdjustments}
                  disabled={!dirty || saving}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !dirty || saving }}
                  style={({ pressed }) => [
                    styles.logBtn,
                    { backgroundColor: dirty ? colors.cobalt : colors.border, borderRadius: colors.radiusSm },
                    (pressed || saving) && { opacity: 0.85 },
                  ]}
                >
                  <Text style={[styles.logBtnText, { color: dirty ? colors.primaryForeground : colors.subtleText }]}>
                    {dirty ? 'Save adjusted amounts' : 'No changes to save'}
                  </Text>
                </Pressable>
                <Text style={[styles.logHint, { color: colors.subtleText }]}>
                  Updates this diary entry — Edit and Undo keep working.
                </Text>
              </LedgerCard>
            </>
          ) : (
            <>
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
                    { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
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
                    { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
                    servings >= 6 && { opacity: 0.35 },
                  ]}
                >
                  <Feather name="plus" size={13} color={colors.bodyText} />
                </Pressable>
              </View>
            </View>
          </LedgerCard>
            </>
          )}

          <SyntheticDisclaimer />
        </View>
      </ScrollView>

      {/* ── Sticky log footer (log-fresh mode only) ── */}
      {!entryMode && (
        <View
          style={[
            styles.stickyFooter,
            {
              backgroundColor: colors.card,
              borderTopColor: colors.border,
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          <Pressable
            testID="recipe-sticky-log"
            onPress={logRecipe}
            disabled={logging}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.stickyLogBtn,
              { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
              (pressed || logging) && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.stickyLogBtnText, { color: colors.primaryForeground }]}>
              {logging ? 'Adding…' : `Add ${totalCals.toLocaleString('en-US')} cal to ${MEAL_LABELS[meal]}`}
            </Text>
          </Pressable>
        </View>
      )}
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
    fontSize: 23,
    letterSpacing: -0.3,
    fontFamily: 'PlayfairDisplay_600SemiBold',
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
    borderRadius: 5,
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
    fontSize: 27,
    letterSpacing: -0.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
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
    borderRadius: 6,
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
  entryTotals: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 10,
  },
  stickyFooter: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  stickyLogBtn: {
    paddingVertical: 13,
    alignItems: 'center',
  },
  stickyLogBtnText: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
});
