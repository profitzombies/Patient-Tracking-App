/**
 * IngredientBreakdown — the recipe screens' ingredient list, upgraded: rows
 * with per-ingredient nutrition expand (one at a time) into a small editor
 * showing that ingredient's contribution per serving plus an amount stepper
 * and, for weight/volume units, a unit switch. All math lives in
 * data/ingredient-nutrition (scaling is always from the ORIGINAL baseline);
 * this component only renders views and reports a new adjustment list up.
 *
 * Rows without nutrition data (older saves) or "to taste" rows render exactly
 * like the pre-breakdown list — totals-only recipes stay fully usable.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { Divider } from '@/components/ui/LedgerPrimitives';
import {
  amountBounds,
  applyAdjustments,
  conversionFactor,
  formatIngredientAmount,
  roundNutrition,
  sanitizeAdjustments,
  stepForUnit,
  unitOptions,
  type IngredientView,
} from '@/data/ingredient-nutrition';
import type { IngredientAdjustment, RecipeIngredient } from '@/data/patient-data';

interface IngredientBreakdownProps {
  ingredients: RecipeIngredient[];
  /** Sanitized or raw; views degrade gracefully either way. */
  adjustments: IngredientAdjustment[];
  /** Receives the full SANITIZED next adjustment list. */
  onChange: (next: IngredientAdjustment[]) => void;
  /** AI recipes: mark the per-ingredient facts as estimates. */
  estimated?: boolean;
  testIDPrefix?: string;
}

export function IngredientBreakdown({
  ingredients,
  adjustments,
  onChange,
  estimated,
  testIDPrefix = 'ingredient',
}: IngredientBreakdownProps) {
  const colors = useColors();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const views = applyAdjustments(ingredients, adjustments);
  const anyEditable = views.some(v => v.editable);

  const commit = (index: number, amount: number, unit: string) => {
    const next = adjustments.filter(a => a.index !== index);
    next.push({ index, amount, unit });
    onChange(sanitizeAdjustments(ingredients, next));
  };

  /**
   * Step to the next multiple of the unit's step size. After a unit switch
   * the amount can sit off-grid (0.375 lb); stepping snaps back onto it.
   */
  const stepAmount = (view: IngredientView, direction: 1 | -1) => {
    const step = stepForUnit(view.unit);
    const { min, max } = amountBounds(
      { amount: view.originalAmount, unit: view.originalUnit },
      view.unit,
    );
    const raw =
      direction > 0
        ? Math.floor((view.amount + 1e-9) / step) * step + step
        : Math.ceil((view.amount - 1e-9) / step) * step - step;
    const amount = Math.min(max, Math.max(min, Math.round(raw * 1000) / 1000));
    commit(view.index, amount, view.unit);
  };

  const switchUnit = (view: IngredientView, unit: string) => {
    const factor = conversionFactor(view.unit, unit);
    if (factor === null || factor === 1) return;
    commit(view.index, Math.round(view.amount * factor * 10000) / 10000, unit);
  };

  const resetRow = (view: IngredientView) => {
    onChange(sanitizeAdjustments(ingredients, adjustments.filter(a => a.index !== view.index)));
  };

  const amountText = (view: IngredientView) =>
    `${formatIngredientAmount(view.amount)}${view.unit ? ` ${view.unit}` : ''}`;

  return (
    <View>
      {views.map(view => {
        const expanded = expandedIndex === view.index;
        const facts = view.nutrition ? roundNutrition(view.nutrition) : undefined;
        const options = unitOptions(view.originalUnit);
        const bounds = view.editable
          ? amountBounds({ amount: view.originalAmount, unit: view.originalUnit }, view.unit)
          : null;
        const canMinus = bounds ? view.amount > bounds.min + 1e-9 : false;
        const canPlus = bounds ? view.amount < bounds.max - 1e-9 : false;

        const rowBody = (
          <>
            <View style={[styles.dot, { backgroundColor: colors.cobalt }]} />
            <Text style={[styles.rowText, { color: colors.bodyText }]}>
              {view.originalAmount > 0 ? (
                <>
                  <Text
                    style={{
                      fontFamily: 'Inter_600SemiBold',
                      color: view.adjusted ? colors.cobalt : colors.navyLight,
                    }}
                  >
                    {amountText(view)}
                  </Text>
                  {` ${view.name}`}
                </>
              ) : (
                <>
                  {view.name}
                  <Text style={{ color: colors.subtleText }}> — to taste</Text>
                </>
              )}
            </Text>
            {view.editable && facts && (
              <Text style={[styles.rowCals, { color: view.adjusted ? colors.cobalt : colors.subtleText }]}>
                {facts.calories} cal
              </Text>
            )}
            {view.editable && (
              <Feather
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={colors.subtleText}
              />
            )}
          </>
        );

        return (
          <View key={`${view.name}-${view.index}`}>
            {view.index > 0 && <Divider />}
            {view.editable ? (
              <Pressable
                testID={`${testIDPrefix}-row-${view.index}`}
                onPress={() => setExpandedIndex(expanded ? null : view.index)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${view.name}, ${amountText(view)}${view.adjusted ? ', adjusted' : ''}`}
                accessibilityHint={
                  expanded ? 'Collapses the nutrition editor' : 'Shows nutrition facts and amount controls'
                }
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
              >
                {rowBody}
              </Pressable>
            ) : (
              <View style={styles.row}>{rowBody}</View>
            )}

            {view.editable && expanded && facts && (
              <View
                style={[
                  styles.editor,
                  { backgroundColor: colors.sidebarBg, borderRadius: colors.radiusSm },
                ]}
              >
                <View style={styles.editorHeader}>
                  <Text style={[styles.editorLabel, { color: colors.labelText }]}>
                    {estimated ? 'PER SERVING · THIS INGREDIENT · EST.' : 'PER SERVING · THIS INGREDIENT'}
                  </Text>
                  {view.adjusted && (
                    <Pressable
                      testID={`${testIDPrefix}-reset-${view.index}`}
                      onPress={() => resetRow(view)}
                      accessibilityRole="button"
                      accessibilityLabel={`Reset ${view.name} to its original amount`}
                      style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                    >
                      <Text style={[styles.resetText, { color: colors.cobalt }]}>Reset</Text>
                    </Pressable>
                  )}
                </View>

                <View style={styles.factsRow}>
                  <View style={styles.factCol}>
                    <Text style={[styles.factBig, { color: colors.navy }]}>{facts.calories}</Text>
                    <Text style={[styles.factLabel, { color: colors.labelText }]}>CAL</Text>
                  </View>
                  <View style={styles.factCol}>
                    <Text style={[styles.factValue, { color: colors.cobalt }]}>{facts.protein}g</Text>
                    <Text style={[styles.factLabel, { color: colors.labelText }]}>PROTEIN</Text>
                  </View>
                  <View style={styles.factCol}>
                    <Text style={[styles.factValue, { color: colors.navyLight }]}>{facts.carbs}g</Text>
                    <Text style={[styles.factLabel, { color: colors.labelText }]}>CARBS</Text>
                  </View>
                  <View style={styles.factCol}>
                    <Text style={[styles.factValue, { color: colors.navyLight }]}>{facts.fat}g</Text>
                    <Text style={[styles.factLabel, { color: colors.labelText }]}>FAT</Text>
                  </View>
                </View>

                <View style={styles.amountRow}>
                  <Text style={[styles.editorLabel, { color: colors.labelText }]}>AMOUNT</Text>
                  <View style={styles.amountControls}>
                    <Pressable
                      testID={`${testIDPrefix}-minus-${view.index}`}
                      onPress={() => stepAmount(view, -1)}
                      disabled={!canMinus}
                      accessibilityRole="button"
                      accessibilityLabel={`Decrease amount of ${view.name}`}
                      style={({ pressed }) => [
                        styles.stepBtn,
                        { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
                        !canMinus && { opacity: 0.35 },
                      ]}
                    >
                      <Feather name="minus" size={13} color={colors.bodyText} />
                    </Pressable>
                    <Text style={[styles.amountValue, { color: view.adjusted ? colors.cobalt : colors.navy }]}>
                      {amountText(view)}
                    </Text>
                    <Pressable
                      testID={`${testIDPrefix}-plus-${view.index}`}
                      onPress={() => stepAmount(view, 1)}
                      disabled={!canPlus}
                      accessibilityRole="button"
                      accessibilityLabel={`Increase amount of ${view.name}`}
                      style={({ pressed }) => [
                        styles.stepBtn,
                        { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
                        !canPlus && { opacity: 0.35 },
                      ]}
                    >
                      <Feather name="plus" size={13} color={colors.bodyText} />
                    </Pressable>
                  </View>
                </View>

                {options.length > 1 && (
                  <View style={styles.unitRow}>
                    {options.map(option => {
                      const selected = conversionFactor(option, view.unit) === 1;
                      return (
                        <Pressable
                          key={option}
                          testID={`${testIDPrefix}-unit-${view.index}-${option}`}
                          onPress={() => switchUnit(view, option)}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`Measure ${view.name} in ${option}`}
                          style={({ pressed }) => [
                            styles.unitPill,
                            {
                              borderColor: selected ? colors.cobalt : colors.border,
                              backgroundColor: selected ? colors.cobalt : pressed ? colors.accent : colors.card,
                              borderRadius: colors.radiusSm,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.unitPillText,
                              { color: selected ? colors.primaryForeground : colors.bodyText },
                            ]}
                          >
                            {option}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </View>
            )}
          </View>
        );
      })}

      {!anyEditable && (
        <Text style={[styles.noDataNote, { color: colors.subtleText }]}>
          Per-ingredient nutrition isn't available for this recipe, so amounts can't be adjusted here.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dot: {
    width: 5,
    height: 5,
  },
  rowText: {
    fontSize: 12.5,
    fontFamily: 'Inter_400Regular',
    flex: 1,
    lineHeight: 18,
  },
  rowCals: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  editor: {
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 12,
  },
  editorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  editorLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  resetText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  factsRow: {
    flexDirection: 'row',
    marginTop: 10,
    alignItems: 'flex-end',
  },
  factCol: {
    flex: 1,
  },
  factBig: {
    fontSize: 17,
    letterSpacing: -0.3,
    fontFamily: 'PlayfairDisplay_600SemiBold',
  },
  factValue: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -0.2,
    fontFamily: 'Inter_600SemiBold',
  },
  factLabel: {
    fontSize: 7.5,
    fontWeight: '700',
    letterSpacing: 0.9,
    fontFamily: 'Inter_700Bold',
    marginTop: 2,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  amountControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 26,
    height: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountValue: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    minWidth: 56,
    textAlign: 'center',
  },
  unitRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
  },
  unitPill: {
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  unitPillText: {
    fontSize: 10.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  noDataNote: {
    fontSize: 10.5,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
});
