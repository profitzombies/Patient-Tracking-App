import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { FoodNutritionSnapshot } from '@/data/food-nutrition';
import { scaledSnapshotNutrients } from '@/data/food-nutrition';
import { useColors } from '@/hooks/useColors';

type Nutrient = FoodNutritionSnapshot['nutrients'][number];

// FDA Daily Values for adults and children age 4+, current FDA reference
// reviewed 2026-09-08. A value is used only for the exact nutrient form/unit.
const DAILY_VALUES: Record<string, { amount: number; unit: string }> = {
  '1004': { amount: 78, unit: 'g' },
  '1258': { amount: 20, unit: 'g' },
  '1253': { amount: 300, unit: 'mg' },
  '1093': { amount: 2300, unit: 'mg' },
  '1005': { amount: 275, unit: 'g' },
  '1079': { amount: 28, unit: 'g' },
  '1235': { amount: 50, unit: 'g' },
  '1114': { amount: 20, unit: 'mcg' },
  '1087': { amount: 1300, unit: 'mg' },
  '1089': { amount: 18, unit: 'mg' },
  '1092': { amount: 4700, unit: 'mg' },
  '1162': { amount: 90, unit: 'mg' },
  '1165': { amount: 1.2, unit: 'mg' },
  '1166': { amount: 1.3, unit: 'mg' },
  '1175': { amount: 1.7, unit: 'mg' },
  '1178': { amount: 2.4, unit: 'mcg' },
  '1091': { amount: 1250, unit: 'mg' },
  '1090': { amount: 420, unit: 'mg' },
  '1095': { amount: 11, unit: 'mg' },
  '1098': { amount: 0.9, unit: 'mg' },
  '1101': { amount: 2.3, unit: 'mg' },
  '1103': { amount: 55, unit: 'mcg' },
};

const ORDER = [
  '1004', '1258', '1257', '1292', '1293', '1253', '1093', '1005',
  '1079', '2000', '1235', '1003',
];

function normalizedUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/μg|µg/g, 'mcg');
}

function permitsFormDV(nutrient: Nutrient): boolean {
  const name = nutrient.name.toLowerCase();
  if (nutrient.id === '1003' || nutrient.id === '2000' || nutrient.id === '1257'
    || nutrient.id === '1292' || nutrient.id === '1293') return false;
  if (/vitamin a/.test(name)) return /\brae\b/.test(name);
  if (/folate/.test(name)) return /\bdfe\b/.test(name);
  if (/niacin/.test(name)) return /\bne\b/.test(name);
  if (/vitamin e/.test(name)) return /alpha[- ]tocopherol/.test(name);
  return true;
}

export function nutrientDailyValuePercent(nutrient: Nutrient): number | null {
  let reference = DAILY_VALUES[nutrient.id];
  const name = nutrient.name.toLowerCase();
  if (!reference && /vitamin a/.test(name) && /\brae\b/.test(name)) {
    reference = { amount: 900, unit: 'mcg' };
  } else if (!reference && /folate/.test(name) && /\bdfe\b/.test(name)) {
    reference = { amount: 400, unit: 'mcg' };
  } else if (!reference && /vitamin e/.test(name) && /alpha[- ]tocopherol/.test(name)) {
    reference = { amount: 15, unit: 'mg' };
  }
  if (!reference || !permitsFormDV(nutrient) || normalizedUnit(nutrient.unit) !== reference.unit) {
    return null;
  }
  return nutrient.amount / reference.amount * 100;
}

function formatted(value: number): string {
  return Number(value.toFixed(value < 1 && value !== 0 ? 2 : 1)).toString();
}

export function orderedNutritionFacts(snapshot: FoodNutritionSnapshot): Nutrient[] {
  const nutrients = scaledSnapshotNutrients(snapshot);
  const rank = new Map(ORDER.map((id, index) => [id, index]));
  return nutrients
    .filter(nutrient => nutrient.id !== '1008' && !/^energy$/i.test(nutrient.name))
    .sort((a, b) => (rank.get(a.id) ?? 100) - (rank.get(b.id) ?? 100));
}

export function NutritionFacts({ snapshot }: { snapshot: FoodNutritionSnapshot | null }) {
  const colors = useColors();
  if (!snapshot) {
    return (
      <Text style={[styles.note, { color: colors.bodyText }]}>
        Additional nutrients not provided for this food.
      </Text>
    );
  }
  const nutrients = orderedNutritionFacts(snapshot);
  return (
    <View style={styles.body}>
      {nutrients.map(nutrient => {
        const dv = nutrientDailyValuePercent(nutrient);
        return (
          <View key={nutrient.id} style={styles.row}>
            <Text style={[styles.name, { color: colors.bodyText }]}>{nutrient.name}</Text>
            <Text style={[styles.value, { color: colors.navy }]}>
              {formatted(nutrient.amount)} {nutrient.unit}{dv === null ? '' : ` · ${Math.round(dv)}% DV`}
            </Text>
          </View>
        );
      })}
      {nutrients.length === 0 ? (
        <Text style={[styles.note, { color: colors.bodyText }]}>Additional nutrients not provided.</Text>
      ) : (
        <Text style={[styles.note, { color: colors.subtleText }]}>
          Unlisted nutrients were not provided. % Daily Value uses the FDA general reference for adults
          and children age 4+, not your personal THINNR target.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 11 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  name: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular' },
  value: { fontSize: 13, fontFamily: 'Inter_600SemiBold', textAlign: 'right' },
  note: { fontSize: 11, lineHeight: 16, fontFamily: 'Inter_400Regular' },
});