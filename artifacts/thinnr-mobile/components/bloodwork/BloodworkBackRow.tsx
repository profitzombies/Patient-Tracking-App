import React from 'react';
import { Feather } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

interface BloodworkBackRowProps {
  onPress: () => void;
  label?: string;
  testID?: string;
}

/** Bloodwork-local navigation belongs below, rather than inside, PatientHeader. */
export function BloodworkBackRow({
  onPress,
  label = 'Back to bloodwork',
  testID = 'bloodwork-back',
}: BloodworkBackRowProps) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={({ pressed }) => [styles.button, pressed && { opacity: 0.7 }]}
      >
        <Feather name="arrow-left" size={18} color={colors.navy} />
        <Text style={[styles.label, { color: colors.navy }]}>{label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 2,
  },
  button: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    paddingHorizontal: 2,
  },
  label: {
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});