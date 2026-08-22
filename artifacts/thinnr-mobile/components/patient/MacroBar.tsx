/**
 * One macro row: label, consumed vs target grams, and a square progress bar.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { ProgressBar } from '@/components/ui/LedgerPrimitives';

interface MacroBarProps {
  label: string;
  value: number;
  target: number;
  color: string;
}

export function MacroBar({ label, value, target, color }: MacroBarProps) {
  const colors = useColors();
  const pct = target > 0 ? (value / target) * 100 : 0;
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Text style={[styles.label, { color: colors.labelText }]}>{label.toUpperCase()}</Text>
        <Text style={[styles.value, { color: colors.navyLight }]}>
          {Math.round(value)}
          <Text style={{ color: colors.subtleText }}> / {target} g</Text>
        </Text>
      </View>
      <ProgressBar value={pct} color={color} style={{ height: 6 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 5,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  value: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
});
