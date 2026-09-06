/**
 * FoodAddPanel — inline add-to-diary controls that expand under a food row.
 * Picks a meal, steps the quantity, and logs the food to today's diary.
 * Shared by the Library foods view and the Approved Foods list.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PillSelector } from '@/components/ui/LedgerPrimitives';
import { usePatient } from '@/context/PatientContext';
import { MEAL_LABELS, MEAL_SLOTS, type FoodItem, type MealSlot } from '@/data/patient-data';
import { GRAMS_PER_OUNCE } from '@/context/FoodLoggingContext';

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

function formatQty(qty: number): string {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
}

interface FoodAddPanelProps {
  food: FoodItem;
  /** Optional context line, e.g. "Logs as: Chicken Breast, grilled · 4 oz". */
  note?: string;
  /** Prefix for testIDs so multiple screens stay distinguishable. */
  testIDPrefix: string;
  onAdded: (message: string) => void;
  /** Optional server-owned selection/promotion step; may return a canonical row. */
  prepareFood?: () => Promise<FoodItem>;
}

export function FoodAddPanel({ food, note, testIDPrefix, onAdded, prepareFood }: FoodAddPanelProps) {
  const colors = useColors();
  const patient = usePatient();
  const [meal, setMeal] = useState<MealSlot>('breakfast');
  const [qty, setQty] = useState(1);
  const weightBased = !!food.catalogShared
    && !!food.catalogServingGrams
    && food.catalogMeasures?.some(measure => /\boz\b/i.test(measure.label));
  const [ounces, setOunces] = useState(weightBased ? 5 : undefined);
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Logging remains available during a catalog outage; if promotion
      // succeeds, use its stable canonical id and authoritative snapshot.
      const logFood = await prepareFood?.().catch(() => undefined) ?? food;
      const scale = ounces !== undefined && logFood.catalogServingGrams
        ? ounces * GRAMS_PER_OUNCE / logFood.catalogServingGrams
        : qty;
      await patient.addEntry({
        dateKey: patient.todayKey,
        meal,
        kind: 'food',
        refId: logFood.id,
        name: logFood.name,
        detail: ounces !== undefined
          ? `${formatQty(ounces)} oz · ${Math.round(ounces * GRAMS_PER_OUNCE)} g`
          : `${formatQty(qty)} × ${logFood.serving}`,
        quantity: scale,
        calories: Math.round(logFood.calories * scale),
        protein: Math.round(logFood.protein * scale),
        carbs: Math.round(logFood.carbs * scale),
        fat: Math.round(logFood.fat * scale),
      });
      onAdded(`Added ${logFood.name} to ${MEAL_LABELS[meal]}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.panel, { backgroundColor: colors.sidebarBg }]}>
      {note ? (
        <Text style={[styles.note, { color: colors.subtleText }]} numberOfLines={2}>
          {note}
        </Text>
      ) : null}
      <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} style={{ marginBottom: 10 }} />
      <View style={styles.controls}>
        <Pressable
          testID={`${testIDPrefix}-qty-minus`}
          accessibilityLabel={`Decrease ${weightBased ? 'weight by half an ounce' : 'quantity by half a serving'}`}
          onPress={() => ounces !== undefined
            ? setOunces(value => Math.max(0.5, (value ?? 5) - 0.5))
            : setQty(q => Math.max(0.5, Math.round((q - 0.5) * 2) / 2))}
          disabled={(ounces ?? qty) <= 0.5}
          style={({ pressed }) => [
            styles.stepBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
            (ounces ?? qty) <= 0.5 && { opacity: 0.35 },
          ]}
        >
          <Feather name="minus" size={13} color={colors.bodyText} />
        </Pressable>
        <Text testID={`${testIDPrefix}-qty`} style={[styles.qtyValue, { color: colors.navy }]}>
          {formatQty(ounces ?? qty)}{ounces !== undefined ? ' oz' : ''}
        </Text>
        <Pressable
          testID={`${testIDPrefix}-qty-plus`}
          accessibilityLabel={`Increase ${weightBased ? 'weight by half an ounce' : 'quantity by half a serving'}`}
          onPress={() => ounces !== undefined
            ? setOunces(value => Math.min(32, (value ?? 5) + 0.5))
            : setQty(q => Math.min(10, Math.round((q + 0.5) * 2) / 2))}
          disabled={ounces === undefined && qty >= 10}
          style={({ pressed }) => [
            styles.stepBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card, borderRadius: colors.radiusSm },
            ounces === undefined && qty >= 10 && { opacity: 0.35 },
          ]}
        >
          <Feather name="plus" size={13} color={colors.bodyText} />
        </Pressable>
        <Pressable
          testID={`${testIDPrefix}-add`}
          onPress={add}
          disabled={saving}
          style={({ pressed }) => [
            styles.addBtn,
            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
            (pressed || saving) && { opacity: 0.85 },
          ]}
        >
          <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
            Add to {MEAL_LABELS[meal]}
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colors.subtleText }]}>
        Logs to today's diary · {ounces !== undefined ? `${formatQty(ounces)} oz` : `${formatQty(qty)} × ${food.serving}`} ·{' '}
        {Math.round(food.calories * (ounces !== undefined && food.catalogServingGrams
          ? ounces * GRAMS_PER_OUNCE / food.catalogServingGrams
          : qty))} cal
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
  note: {
    fontSize: 10.5,
    fontFamily: 'Inter_400Regular',
    marginBottom: 8,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 32,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyValue: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    minWidth: 30,
    textAlign: 'center',
  },
  addBtn: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  hint: {
    fontSize: 10,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
});
