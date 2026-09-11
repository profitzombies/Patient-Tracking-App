import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

/** Static result-shaped placeholders also respect reduced-motion preferences. */
export function FoodSearchSkeleton({
  count = 6,
  testID = 'logfood-search-loading',
}: {
  count?: number;
  testID?: string;
}) {
  const colors = useColors();
  const widths = ['64%', '78%', '55%', '70%', '60%', '74%'] as const;

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading food results"
      aria-busy={true}
      aria-live="polite"
    >
      <View aria-hidden={true} importantForAccessibility="no-hide-descendants" style={styles.shapes}>
        {Array.from({ length: count }, (_, index) => (
          <View
            key={index}
            testID="food-search-skeleton-row"
            style={[styles.row, { borderTopWidth: index ? 1 : 0, borderColor: colors.border }]}
          >
            <View style={styles.main}>
              <View style={[styles.title, { width: widths[index % widths.length], backgroundColor: colors.border }]} />
              <View style={[styles.detail, { backgroundColor: colors.border }]} />
            </View>
            <View style={[styles.action, { backgroundColor: colors.border }]} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shapes: { pointerEvents: 'none' },
  row: {
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  main: { flex: 1, gap: 8 },
  title: { height: 13, borderRadius: 4 },
  detail: { width: '44%', height: 9, borderRadius: 3, opacity: 0.65 },
  action: { width: 18, height: 18, borderRadius: 4 },
});