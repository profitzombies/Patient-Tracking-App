/**
 * AI recipe suggestion preview — full-screen detail for a coach chat card.
 *
 * The suggestion itself is session-only (read from the chat registry by id);
 * it becomes permanent only through the explicit actions here: log it to
 * today's diary, save it to the recipe library, or (cravings) save it as a
 * custom food. Opening the screen quietly starts AI generation of the dish
 * image in the background, cached on the session suggestion — but this
 * preview never shows the image or any generating/failed state. The picture
 * only ever surfaces in the Library after a save: attached at save time if
 * ready, or backfilled onto the saved record the moment it lands (see
 * lib/photo-backfill.ts). A save made after a failed generation quietly
 * retries once; if that fails too, the Library entry keeps its normal
 * placeholder. All nutrition numbers are labeled as estimates — this screen
 * never presents them as measured facts.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Redirect, router, useLocalSearchParams, usePathname } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard, PillSelector, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { useCoachChat } from '@/context/CoachChatContext';
import { usePatient } from '@/context/PatientContext';
import { fetchRecipeImage } from '@/lib/coach-api';
import type { AiRecipeSuggestion } from '@/lib/ai-recipe';
import { previewMealSlot } from '@/lib/meal-slot';
import { createPhotoBackfill, type PhotoBackfill } from '@/lib/photo-backfill';
import {
  MEAL_LABELS,
  MEAL_SLOTS,
  type IngredientAdjustment,
  type MealSlot,
} from '@/data/patient-data';
import {
  adjustedPerServing,
  roundNutrition,
  sanitizeAdjustments,
  totalsForQuantity,
} from '@/data/ingredient-nutrition';
import { withAdjustedTag } from '@/data/diary-entries';
import { IngredientBreakdown } from '@/components/patient/IngredientBreakdown';

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

export default function AiRecipePreviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const { getRecipeSuggestion, setSuggestionPhoto } = useCoachChat();
  const { id } = useLocalSearchParams<{ id: string }>();
  const suggestion = getRecipeSuggestion(id ?? '');

  // Preselected slot: the card's own meal — the server already resolved an
  // explicit pin, a meal the patient named, or their local time into it —
  // otherwise the device clock decides (replacing the old hardcoded Snacks
  // fallback). The patient can still switch it by hand below.
  const [meal, setMeal] = useState<MealSlot>(() => previewMealSlot(suggestion?.meal, new Date()));
  const [servings, setServings] = useState(1);
  const [logging, setLogging] = useState(false);
  const [savedRecipeId, setSavedRecipeId] = useState<string | null>(null);
  const [savedFoodId, setSavedFoodId] = useState<string | null>(null);
  const [savingRecipe, setSavingRecipe] = useState(false);
  const [savingFood, setSavingFood] = useState(false);
  // Session-local ingredient adjustments (halved salmon, oz→lb, …). They
  // shape what gets LOGGED; Library saves keep the coach's original amounts.
  const [adjustments, setAdjustments] = useState<IngredientAdjustment[]>([]);
  // Image generation is deliberately invisible on this screen: it starts
  // quietly on open and the picture only ever surfaces in the Library after
  // a save. Status lives in refs because nothing here renders it.
  const photoStatusRef = useRef<'loading' | 'ready' | 'failed'>(
    suggestion?.photoUri ? 'ready' : 'loading',
  );
  // One quiet regeneration attempt if the patient saves after a failure.
  const saveRetryUsedRef = useRef(false);
  // One generation per mount per suggestion — guards double-fired effects.
  const requestedForRef = useRef<string | null>(null);

  // Save-vs-photo race: saves stay enabled while the photo generates; the
  // tracker patches the photo onto anything saved photo-less once it lands
  // (works even if the patient leaves this screen before that).
  const { setSavedRecipePhoto, setCustomFoodPhoto } = patient;
  const backfillRef = useRef<PhotoBackfill | null>(null);
  if (!backfillRef.current) {
    backfillRef.current = createPhotoBackfill(
      { setRecipePhoto: setSavedRecipePhoto, setFoodPhoto: setCustomFoodPhoto },
      suggestion?.photoUri,
    );
  }
  const backfill = backfillRef.current;

  const generatePhoto = useCallback(
    async (target: AiRecipeSuggestion) => {
      photoStatusRef.current = 'loading';
      try {
        const uri = await fetchRecipeImage(target.name, target.description);
        setSuggestionPhoto(target.id, uri);
        photoStatusRef.current = 'ready';
        backfill.photoReady(uri);
      } catch (error) {
        console.error('Recipe photo generation failed', error);
        photoStatusRef.current = 'failed';
      }
    },
    [setSuggestionPhoto, backfill],
  );

  useEffect(() => {
    if (!suggestion || suggestion.photoUri) return;
    if (requestedForRef.current === suggestion.id) return;
    requestedForRef.current = suggestion.id;
    void generatePhoto(suggestion);
  }, [suggestion, generatePhoto]);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow. Gated on
  // pathname so an in-flight back navigation can't be hijacked mid-teardown.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    if (!pathname.startsWith('/ai-recipe')) return null;
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/coach-chat');
  };

  if (!suggestion) {
    return (
      <View style={[styles.container, styles.missing, { backgroundColor: colors.background, paddingTop: topPad }]}>
        <Text style={[styles.missingText, { color: colors.bodyText }]}>
          This suggestion is no longer available. Ask the coach for a fresh idea.
        </Text>
        <Pressable onPress={goBack} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Text style={[styles.missingLink, { color: colors.cobalt }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const isCravings = suggestion.mode === 'cravings';
  // Meal-from-photo suggestions reuse this whole screen with a few facts
  // changed: nothing to cook (no minutes, no directions), the photo is the
  // patient's own shot (generation is skipped — photoUri arrives set), and
  // saves are tagged as photo logs.
  const isMeal = suggestion.mode === 'meal';
  const sanitized = sanitizeAdjustments(suggestion.ingredients, adjustments);
  const isAdjusted = sanitized.length > 0;
  const perServing = adjustedPerServing(
    { calories: suggestion.calories, protein: suggestion.protein, carbs: suggestion.carbs, fat: suggestion.fat },
    suggestion.ingredients,
    sanitized,
  );
  const perServingDisplay = roundNutrition(perServing);
  const totalCals = Math.round(perServing.calories * servings);

  // Saving after a failed generation quietly retries once in the background
  // so the Library entry still gets its picture; a second failure leaves the
  // saved record on its normal placeholder. Nothing is surfaced in this UI.
  const retryPhotoOnSave = () => {
    if (photoStatusRef.current !== 'failed' || saveRetryUsedRef.current) return;
    saveRetryUsedRef.current = true;
    void generatePhoto(suggestion);
  };

  const logSuggestion = async () => {
    if (logging) return;
    setLogging(true);
    try {
      const baseDetail = `${servings} serving${servings === 1 ? '' : 's'} · AI estimate`;
      const totals = totalsForQuantity(perServing, servings);
      await patient.addEntry({
        dateKey: patient.todayKey,
        meal,
        // If the patient saved it first, link the diary row to the saved
        // recipe; otherwise log a stand-alone quick entry.
        kind: savedRecipeId ? 'recipe' : 'quick',
        ...(savedRecipeId ? { refId: savedRecipeId } : {}),
        name: suggestion.name,
        detail: isAdjusted ? withAdjustedTag(baseDetail) : baseDetail,
        quantity: servings,
        calories: totals.calories,
        protein: totals.protein,
        carbs: totals.carbs,
        fat: totals.fat,
        // Only recipe-linked rows can reopen the breakdown from the diary,
        // so only they carry the adjustment list (indices match the saved
        // recipe's ingredients, which keep the coach's original order).
        ...(savedRecipeId && isAdjusted ? { adjustments: sanitized } : {}),
      });
      goBack();
    } finally {
      setLogging(false);
    }
  };

  const saveRecipe = async () => {
    if (savingRecipe || savedRecipeId) return;
    setSavingRecipe(true);
    retryPhotoOnSave();
    try {
      const photoUriNow = backfill.photoUri();
      const saved = await patient.addSavedRecipe({
        name: suggestion.name,
        meal: suggestion.meal,
        tags: isMeal ? ['coach', 'meal photo'] : isCravings ? ['coach', 'cravings fix'] : ['coach'],
        minutes: Math.round(suggestion.minutes),
        servings: Math.round(suggestion.servings),
        calories: Math.round(suggestion.calories),
        protein: Math.round(suggestion.protein),
        carbs: Math.round(suggestion.carbs),
        fat: Math.round(suggestion.fat),
        description: suggestion.description,
        // Library saves keep the coach's ORIGINAL amounts and per-ingredient
        // nutrition; session adjustments only shape what gets logged.
        ingredients: suggestion.ingredients.map(i => ({
          amount: i.amount,
          unit: i.unit,
          name: i.name,
          ...(i.nutrition ? { nutrition: i.nutrition } : {}),
        })),
        steps: suggestion.steps,
        source: 'coach',
        mode: suggestion.mode,
        savedAt: new Date().toISOString(),
        ...(photoUriNow ? { photoUri: photoUriNow } : {}),
        ...(suggestion.groceryList ? { groceryList: suggestion.groceryList } : {}),
      });
      setSavedRecipeId(saved.id);
      backfill.recordRecipeSaved(saved.id);
    } finally {
      setSavingRecipe(false);
    }
  };

  const saveAsCustomFood = async () => {
    if (savingFood || savedFoodId) return;
    setSavingFood(true);
    retryPhotoOnSave();
    try {
      const photoUriNow = backfill.photoUri();
      const saved = await patient.addCustomFood({
        name: suggestion.name,
        serving: '1 serving (AI estimate)',
        calories: Math.round(suggestion.calories),
        protein: Math.round(suggestion.protein),
        carbs: Math.round(suggestion.carbs),
        fat: Math.round(suggestion.fat),
        ...(photoUriNow ? { photoUri: photoUriNow } : {}),
      });
      setSavedFoodId(saved.id);
      backfill.recordFoodSaved(saved.id);
    } finally {
      setSavingFood(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Top bar ── */}
      <View style={[styles.topBar, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable
          testID="ai-recipe-back"
          onPress={goBack}
          style={({ pressed }) => [
            styles.topBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
          ]}
        >
          <Feather name="chevron-left" size={17} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.topTitle, { color: colors.labelText }]}>
          {isMeal ? 'MEAL FROM YOUR PHOTO' : isCravings ? 'CRAVINGS FIX' : 'AI SUGGESTION'}
        </Text>
        <View style={[styles.aiBadge, { borderColor: colors.cobalt }]}>
          <Text style={[styles.aiBadgeText, { color: colors.cobalt }]}>AI</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        <View style={styles.body}>
          <Text style={[styles.name, { color: colors.navy }]}>{suggestion.name}</Text>
          <Text style={[styles.description, { color: colors.bodyText }]}>{suggestion.description}</Text>

          <View style={styles.chipRow}>
            {/* A photographed plate has no cook time or yield — those chips
                only describe generated recipes. */}
            {!isMeal && (
              <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="clock" size={11} color={colors.orange} />
                <Text style={[styles.chipText, { color: colors.bodyText }]}>{Math.round(suggestion.minutes)} MIN</Text>
              </View>
            )}
            {!isMeal && (
              <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="users" size={11} color={colors.orange} />
                <Text style={[styles.chipText, { color: colors.bodyText }]}>MAKES {Math.round(suggestion.servings)}</Text>
              </View>
            )}
            {isMeal && (
              <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Feather name="camera" size={11} color={colors.orange} />
                <Text style={[styles.chipText, { color: colors.bodyText }]}>FROM YOUR PHOTO</Text>
              </View>
            )}
            <View style={[styles.chip, { borderColor: colors.border, backgroundColor: colors.card }]}>
              <Text style={[styles.chipText, { color: colors.bodyText }]}>{MEAL_LABELS[suggestion.meal].toUpperCase()}</Text>
            </View>
            {isCravings && (
              <View style={[styles.chip, { borderColor: colors.cobalt, backgroundColor: colors.card }]}>
                <Feather name="check" size={11} color={colors.cobalt} />
                <Text style={[styles.chipText, { color: colors.cobalt }]}>APPROVED FOODS ONLY</Text>
              </View>
            )}
          </View>

          {/* ── Estimated nutrition ── */}
          <LedgerCard style={{ padding: 16, marginTop: 16 }}>
            <Text style={[styles.cardLabel, { color: colors.labelText }]}>ESTIMATED NUTRITION · PER SERVING</Text>
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
            <Text style={[styles.estimateNote, { color: colors.subtleText }]}>
              AI estimates — actual values depend on your exact ingredients.
            </Text>
          </LedgerCard>

          {/* ── Ingredients ── */}
          <SectionHeader
            label={isMeal ? 'On Your Plate' : 'Ingredients'}
            value={isCravings ? 'Approved Foods list' : undefined}
            action={isAdjusted ? { label: 'Reset amounts', onPress: () => setAdjustments([]) } : undefined}
            style={{ marginTop: 18, marginBottom: 8 }}
          />
          <LedgerCard style={{ paddingVertical: 4 }}>
            <IngredientBreakdown
              ingredients={suggestion.ingredients}
              adjustments={adjustments}
              onChange={setAdjustments}
              estimated
            />
          </LedgerCard>

          {/* ── Steps (meals from a photo have nothing to cook) ── */}
          {suggestion.steps.length > 0 && (
            <>
              <SectionHeader label="Directions" style={{ marginTop: 18, marginBottom: 8 }} />
              <LedgerCard style={{ paddingVertical: 4 }}>
                {suggestion.steps.map((step, index) => (
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

          {/* ── Grocery list (cravings) ── */}
          {isCravings && suggestion.groceryList && suggestion.groceryList.length > 0 && (
            <>
              <SectionHeader label="Grocery List" style={{ marginTop: 18, marginBottom: 8 }} />
              <LedgerCard style={{ paddingVertical: 4 }}>
                {suggestion.groceryList.map((item, index) => (
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

          {/* ── Keep it ── */}
          <SectionHeader label="Keep This Suggestion" style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ padding: 16 }}>
            <Pressable
              testID="ai-recipe-save"
              onPress={() => {
                Haptics.selectionAsync();
                void saveRecipe();
              }}
              disabled={savingRecipe || !!savedRecipeId}
              style={({ pressed }) => [
                styles.saveBtn,
                {
                  borderColor: savedRecipeId ? colors.border : colors.cobalt,
                  backgroundColor: savedRecipeId ? colors.card : pressed ? colors.accent : colors.background,
                  borderRadius: colors.radiusSm,
                },
              ]}
            >
              <Feather
                name={savedRecipeId ? 'check' : 'bookmark'}
                size={13}
                color={savedRecipeId ? colors.activeGreen : colors.cobalt}
              />
              <Text style={[styles.saveBtnText, { color: savedRecipeId ? colors.bodyText : colors.cobalt }]}>
                {savedRecipeId ? 'Saved to your recipes' : isMeal ? 'Save as recipe' : 'Save recipe'}
              </Text>
            </Pressable>
            {isCravings && (
              <Pressable
                testID="ai-recipe-save-food"
                onPress={() => {
                  Haptics.selectionAsync();
                  void saveAsCustomFood();
                }}
                disabled={savingFood || !!savedFoodId}
                style={({ pressed }) => [
                  styles.saveBtn,
                  { marginTop: 8 },
                  {
                    borderColor: savedFoodId ? colors.border : colors.cobalt,
                    backgroundColor: savedFoodId ? colors.card : pressed ? colors.accent : colors.background,
                    borderRadius: colors.radiusSm,
                  },
                ]}
              >
                <Feather
                  name={savedFoodId ? 'check' : 'plus-square'}
                  size={13}
                  color={savedFoodId ? colors.activeGreen : colors.cobalt}
                />
                <Text style={[styles.saveBtnText, { color: savedFoodId ? colors.bodyText : colors.cobalt }]}>
                  {savedFoodId ? 'Saved to My Foods' : 'Save as custom food'}
                </Text>
              </Pressable>
            )}
            <Text style={[styles.saveHint, { color: colors.subtleText }]}>
              {isAdjusted
                ? "Saves keep the coach's original amounts. Saved items appear in your Library."
                : 'Saved items appear in your Library.'}
            </Text>
          </LedgerCard>

          {/* ── Log it ── */}
          <SectionHeader label="Add to Diary" style={{ marginTop: 18, marginBottom: 8 }} />
          <LedgerCard style={{ padding: 16 }}>
            <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} />
            <View style={styles.servingRow}>
              <Text style={[styles.servingLabel, { color: colors.labelText }]}>SERVINGS TO LOG</Text>
              <View style={styles.servingControls}>
                <Pressable
                  testID="ai-recipe-servings-minus"
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
                  testID="ai-recipe-servings-plus"
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
            <Pressable
              testID="ai-recipe-log-btn"
              onPress={logSuggestion}
              disabled={logging}
              style={({ pressed }) => [
                styles.logBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                (pressed || logging) && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.logBtnText, { color: colors.primaryForeground }]}>
                Add {totalCals.toLocaleString('en-US')} est. cal to {MEAL_LABELS[meal]}
              </Text>
            </Pressable>
            <Text style={[styles.logHint, { color: colors.subtleText }]}>Logs to today's diary with estimated values</Text>
          </LedgerCard>

          <Text style={[styles.footerNote, { color: colors.subtleText }]}>
            AI-generated suggestion, for information only. Nutrition values are estimates, not
            measurements. Check with your care team when something matters.
          </Text>
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
    paddingHorizontal: 32,
  },
  missingText: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
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
  aiBadge: {
    borderWidth: 1,
    paddingHorizontal: 5,
    paddingVertical: 2,
    minWidth: 34,
    alignItems: 'center',
    borderRadius: 5,
  },
  aiBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.8,
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
  estimateNote: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 12,
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
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    paddingVertical: 11,
  },
  saveBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  saveHint: {
    fontSize: 10,
    marginTop: 10,
    textAlign: 'center',
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
  footerNote: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: 16,
    textAlign: 'center',
    fontFamily: 'Inter_400Regular',
  },
});
