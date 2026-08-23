/**
 * Snackbar — transient notice floating above the patient tab bar, with one
 * uppercase action button (e.g. "UNDO", "VIEW"). Purely presentational: the
 * caller owns visibility, content, and any auto-dismiss timer. Screens should
 * keep a single snackbar slot so a newer notice replaces the current one.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

interface SnackbarProps {
  message: string;
  actionLabel: string;
  onAction: () => void;
  testID?: string;
  actionTestID?: string;
}

export function Snackbar({ message, actionLabel, onAction, testID, actionTestID }: SnackbarProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      style={[
        styles.bar,
        {
          backgroundColor: colors.navy,
          borderColor: colors.navyLight,
          bottom: (Platform.OS === 'web' ? 84 : insets.bottom + 84) + 12,
        },
      ]}
    >
      <Text style={[styles.text, { color: colors.paperCard }]} numberOfLines={1}>
        {message}
      </Text>
      <Pressable
        testID={actionTestID}
        onPress={onAction}
        hitSlop={8}
        style={({ pressed }) => [
          styles.actionBtn,
          { borderColor: colors.cobaltMuted },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.actionText, { color: colors.paperCard }]}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderWidth: 1,
    borderRadius: 8,
    boxShadow: '0 10px 22px rgba(32, 59, 100, 0.28)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  text: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  actionBtn: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  actionText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
});
