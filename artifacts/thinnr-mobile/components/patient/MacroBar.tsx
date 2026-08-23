/**
 * One macro row, Heritage style: sentence-case name, "consumed of target g"
 * with a bold percentage, and a slim square progress bar.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
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
        <Text style={[styles.label, { color: colors.foreground }]}>{label}</Text>
        <Text style={[styles.value, { color: colors.subtleText }]}>
          {Math.round(value)} of {target} g{' '}
          <Text style={[styles.pct, { color: colors.bodyText }]}>{Math.round(pct)}%</Text>
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
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  value: {
    fontSize: 11,
    fontFamily: fonts.sans,
  },
  pct: {
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
});
