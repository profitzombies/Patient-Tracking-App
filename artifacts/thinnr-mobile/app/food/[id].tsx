import React, { useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppMode } from '@/context/AppModeContext';
import { selectionScale, supportsOunces, useFoodLogging } from '@/context/FoodLoggingContext';
import { usePatient } from '@/context/PatientContext';
import { useColors } from '@/hooks/useColors';
import { useLoggableItems } from '@/hooks/useLoggableItems';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';

function display(value: number): string {
  return Number(value.toFixed(1)).toString();
}

export default function FoodDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated } = useAppMode();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { byId } = useLoggableItems();
  const basket = useFoodLogging();
  const selected = basket.selected.find(entry => entry.item.refId === id);
  const item = selected?.item ?? basket.recalled(id ?? '') ?? byId.get(id ?? '');
  const weightBased = item ? supportsOunces(item) : false;
  const [ounces, setOunces] = useState(selected?.ounces ?? (weightBased ? 5 : undefined));
  const [quantity, setQuantity] = useState(selected?.quantity ?? 1);
  const configured = useMemo(
    () => item ? { item, quantity, ...(ounces !== undefined ? { ounces } : {}) } : null,
    [item, ounces, quantity],
  );
  const scale = configured ? selectionScale(configured) : 1;
  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 24 : Math.max(insets.bottom, 16);

  if (!hydrated) return null;
  if (mode !== 'patient') return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  if (!patient.hydrated) return null;
  if (!item || item.kind !== 'food') {
    return <View style={[styles.center, { backgroundColor: colors.background }]}><Text>Food not found.</Text></View>;
  }

  const amount = ounces !== undefined ? `${display(ounces)} oz` : `${display(quantity)} × ${item.serving}`;
  const adjust = (direction: -1 | 1) => {
    if (ounces !== undefined) setOunces(Math.min(32, Math.max(0.5, ounces + direction * 0.5)));
    else setQuantity(Math.min(10, Math.max(0.5, quantity + direction * 0.5)));
  };
  const save = () => {
    basket.configure(item, { quantity, ...(ounces !== undefined ? { ounces } : {}) });
    router.back();
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable testID="food-detail-back" accessibilityLabel="Back to food search" onPress={() => router.back()} style={styles.iconButton}>
          <Feather name="chevron-left" size={18} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.headerLabel, { color: colors.labelText }]}>FOOD DETAILS</Text>
        <View style={styles.iconButton} />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: bottomPad + 80 }}>
        <Text testID="food-detail-name" style={[styles.name, { color: colors.navy }]}>{item.name}</Text>
        <Text style={[styles.source, { color: colors.bodyText }]}>
          {item.catalog?.canonicalName && item.catalog.canonicalName !== item.name ? `${item.catalog.canonicalName}\n` : ''}
          {item.catalog?.sourceLabel ?? item.sub}
        </Text>
        <LedgerCard style={{ padding: 16, marginTop: 16 }}>
          <Text style={[styles.label, { color: colors.labelText }]}>{weightBased ? 'WEIGHT' : 'SERVING QUANTITY'}</Text>
          <View style={styles.amountRow}>
            <Pressable testID="food-detail-minus" accessibilityLabel={`Decrease ${weightBased ? 'weight by half an ounce' : 'quantity by half a serving'}`} onPress={() => adjust(-1)} style={[styles.step, { borderColor: colors.border }]}>
              <Feather name="minus" size={16} color={colors.bodyText} />
            </Pressable>
            <Text testID="food-detail-amount" accessibilityLabel={`Current amount ${amount}`} style={[styles.amount, { color: colors.navy }]}>{amount}</Text>
            <Pressable testID="food-detail-plus" accessibilityLabel={`Increase ${weightBased ? 'weight by half an ounce' : 'quantity by half a serving'}`} onPress={() => adjust(1)} style={[styles.step, { borderColor: colors.border }]}>
              <Feather name="plus" size={16} color={colors.bodyText} />
            </Pressable>
          </View>
        </LedgerCard>
        <LedgerCard style={{ padding: 16, marginTop: 12 }}>
          <View accessibilityLabel={`${Math.round(item.calories * scale)} calories, ${display(item.protein * scale)} grams protein, ${display(item.carbs * scale)} grams carbs, ${display(item.fat * scale)} grams fat`}>
            <Text style={[styles.label, { color: colors.labelText }]}>NUTRITION · {amount.toUpperCase()}</Text>
            <View style={styles.nutrition}>
              {[['CALORIES', Math.round(item.calories * scale)], ['PROTEIN', `${display(item.protein * scale)}g`], ['CARBS', `${display(item.carbs * scale)}g`], ['FAT', `${display(item.fat * scale)}g`]].map(([label, value]) => (
                <View key={label} style={styles.nutritionCell}><Text style={[styles.nutritionValue, { color: colors.navy }]}>{value}</Text><Text style={[styles.label, { color: colors.labelText }]}>{label}</Text></View>
              ))}
            </View>
          </View>
        </LedgerCard>
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: bottomPad, backgroundColor: colors.card, borderTopColor: colors.border }]}>
        <Pressable testID="food-detail-select" accessibilityLabel={`Select ${item.name} at ${amount} and continue logging more foods`} onPress={save} style={[styles.primary, { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm }]}>
          <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>Select & continue logging more foods</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1 },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerLabel: { fontSize: 10, letterSpacing: 1.3, fontFamily: 'Inter_700Bold' },
  name: { fontSize: 27, lineHeight: 32, fontFamily: 'PlayfairDisplay_600SemiBold' },
  source: { marginTop: 8, fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  label: { fontSize: 9, letterSpacing: 1, fontFamily: 'Inter_700Bold' },
  amountRow: { marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22 },
  step: { width: 42, height: 42, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  amount: { minWidth: 90, textAlign: 'center', fontSize: 22, fontFamily: 'Inter_600SemiBold' },
  nutrition: { flexDirection: 'row', marginTop: 16 },
  nutritionCell: { flex: 1, alignItems: 'center', gap: 4 },
  nutritionValue: { fontSize: 17, fontFamily: 'Inter_600SemiBold' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, borderTopWidth: 1 },
  primary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  primaryText: { fontSize: 12.5, fontFamily: 'Inter_700Bold', textAlign: 'center' },
});