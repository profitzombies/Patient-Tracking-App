/**
 * PendingDot — the subtle "not synced yet" marker for a diary row, water
 * tracker, check-in card, or photo tile whose latest write is still in the
 * offline queue. Renders nothing while signed out (the queue is disabled)
 * and for entities with no unsent write, so existing layouts are untouched
 * unless something is actually pending.
 *
 * Usage: `<PendingDot entityKey={`entry:${entry.id}`} />` — keys follow
 * lib/patient-write-queue's pendingEntityKeys.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { usePatientSync } from '@/context/PatientContext';

export function PendingDot({
  entityKey,
  style,
  size = 12,
}: {
  entityKey: string;
  style?: StyleProp<ViewStyle>;
  size?: number;
}) {
  const sync = usePatientSync();
  const colors = useColors();
  if (!sync.enabled || !sync.isPending(entityKey)) return null;
  return (
    <View
      testID={`pending-dot-${entityKey}`}
      accessibilityLabel="Not synced yet"
      accessibilityRole="image"
      style={[styles.dot, { width: size + 6, height: size + 6, borderRadius: (size + 6) / 2, backgroundColor: colors.activeBg }, style]}
    >
      <Feather name="clock" size={size} color={colors.cobalt} />
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
