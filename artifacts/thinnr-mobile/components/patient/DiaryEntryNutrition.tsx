import React from 'react';
import { StyleSheet, Text } from 'react-native';
import type { MealLogEntry } from '@/data/patient-data';
import { parseNutritionSnapshot, snapshotPortion } from '@/data/food-nutrition';
import { useColors } from '@/hooks/useColors';

export function formatDiaryMacro(value: number): string {
  return Number(value.toFixed(1)).toString();
}

export function formatDiaryCalories(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

export function diaryEntryAmountLabel(entry: MealLogEntry): string {
  const snapshot = parseNutritionSnapshot(entry.nutritionSnapshot);
  if (!snapshot) return entry.detail;
  const portion = snapshotPortion(snapshot);
  const amount = Number(snapshot.selected.amount.toFixed(2));
  const variant = snapshot.variant?.summary?.trim();
  return `${amount} ${portion?.label ?? snapshot.selected.unitId}${variant ? ` · ${variant}` : ''}`;
}

export function DiaryEntryNutritionLine({ entry }: { entry: MealLogEntry }) {
  const colors = useColors();
  return (
    <Text style={[styles.detail, { color: colors.subtleText }]}>
      {diaryEntryAmountLabel(entry)} · P {formatDiaryMacro(entry.protein)}g · C {formatDiaryMacro(entry.carbs)}g · F {formatDiaryMacro(entry.fat)}g
    </Text>
  );
}

export function DiaryEntryCalories({ entry }: { entry: MealLogEntry }) {
  const colors = useColors();
  return <Text style={[styles.calories, { color: colors.navyLight }]}>{formatDiaryCalories(entry.calories)}</Text>;
}

const styles = StyleSheet.create({
  detail: { fontSize: 11, fontFamily: 'Inter_400Regular', marginTop: 3 },
  calories: { width: 36, textAlign: 'right', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
});