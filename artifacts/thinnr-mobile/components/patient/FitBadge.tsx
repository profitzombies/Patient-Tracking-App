/**
 * FitBadge — the one "Fits your diet" treatment for foods. A green check
 * when the shared classifier says the food fits the plan in force (the
 * Approved Foods list during the protocol, the chosen diet plus the
 * patient's lists afterwards), a muted cross when it does not, and nothing
 * at all when the app cannot tell. `md` adds the words; `sm` is the square
 * mark that sits inline in list rows.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import type { FitVerdict } from '@/lib/diet-fit';

export const FIT_LABELS: Record<Exclude<FitVerdict, 'unknown'>, string> = {
  fits: 'Fits your diet',
  does_not_fit: "Doesn't fit your diet",
};

interface FitBadgeProps {
  verdict: FitVerdict;
  size?: 'sm' | 'md';
  style?: StyleProp<ViewStyle>;
}

export function FitBadge({ verdict, size = 'sm', style }: FitBadgeProps) {
  const colors = useColors();
  if (verdict === 'unknown') return null;
  const fits = verdict === 'fits';
  const tone = fits
    ? { bg: colors.activeBg, border: colors.activeBorder, fg: colors.activeGreen }
    : { bg: colors.riskBg, border: colors.riskBorder, fg: colors.riskText };
  const dim = size === 'sm' ? 14 : 20;
  const icon = <Feather name={fits ? 'check' : 'x'} size={size === 'sm' ? 10 : 13} color={tone.fg} />;
  if (size === 'sm') {
    return (
      <View
        testID={`fit-badge-${verdict}`}
        accessibilityLabel={FIT_LABELS[verdict]}
        style={[styles.mark, { width: dim, height: dim, backgroundColor: tone.bg, borderColor: tone.border }, style]}
      >
        {icon}
      </View>
    );
  }
  return (
    <View
      testID={`fit-badge-${verdict}`}
      accessibilityLabel={FIT_LABELS[verdict]}
      style={[styles.pill, { backgroundColor: tone.bg, borderColor: tone.border, borderRadius: colors.radiusSm }, style]}
    >
      {icon}
      <Text style={[styles.pillText, { color: tone.fg }]}>{FIT_LABELS[verdict]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' },
  pillText: { fontFamily: fonts.sansMedium, fontSize: 11 },
});
