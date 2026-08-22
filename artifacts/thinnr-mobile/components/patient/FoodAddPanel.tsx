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
import { MEAL_LABELS, MEAL_SLOTS, TODAY_KEY, type FoodItem, type MealSlot } from '@/data/patient-data';

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
}

export function FoodAddPanel({ food, note, testIDPrefix, onAdded }: FoodAddPanelProps) {
  const colors = useColors();
  const patient = usePatient();
  const [meal, setMeal] = useState<MealSlot>('breakfast');
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await patient.addEntry({
        dateKey: TODAY_KEY,
        meal,
        kind: 'food',
        refId: food.id,
        name: food.name,
        detail: `${formatQty(qty)} × ${food.serving}`,
        quantity: qty,
        calories: Math.round(food.calories * qty),
        protein: Math.round(food.protein * qty),
        carbs: Math.round(food.carbs * qty),
        fat: Math.round(food.fat * qty),
      });
      onAdded(`Added ${food.name} to ${MEAL_LABELS[meal]}`);
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
          onPress={() => setQty(q => Math.max(0.5, Math.round((q - 0.5) * 2) / 2))}
          disabled={qty <= 0.5}
          style={({ pressed }) => [
            styles.stepBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            qty <= 0.5 && { opacity: 0.35 },
          ]}
        >
          <Feather name="minus" size={13} color={colors.bodyText} />
        </Pressable>
        <Text testID={`${testIDPrefix}-qty`} style={[styles.qtyValue, { color: colors.navy }]}>
          {formatQty(qty)}
        </Text>
        <Pressable
          testID={`${testIDPrefix}-qty-plus`}
          onPress={() => setQty(q => Math.min(10, Math.round((q + 0.5) * 2) / 2))}
          disabled={qty >= 10}
          style={({ pressed }) => [
            styles.stepBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
            qty >= 10 && { opacity: 0.35 },
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
            { backgroundColor: colors.cobalt },
            (pressed || saving) && { opacity: 0.85 },
          ]}
        >
          <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
            Add to {MEAL_LABELS[meal]}
          </Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colors.subtleText }]}>
        Logs to today's diary · {formatQty(qty)} × {food.serving} · {Math.round(food.calories * qty)} cal
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
