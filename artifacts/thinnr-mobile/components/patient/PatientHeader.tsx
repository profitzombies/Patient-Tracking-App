/**
 * Safe-area-aware header for patient-mode screens. Mirrors the staff
 * ScreenHeader visually; the ES avatar opens the persona switcher.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';

interface PatientHeaderProps {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function PatientHeader({ title, subtitle, right }: PatientHeaderProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.paperCardAlt,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
          paddingTop: topPad,
        },
      ]}
    >
      <View style={styles.inner}>
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
            <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
          </View>
          <View>
            <Text style={[styles.title, { color: colors.navy }]}>{title}</Text>
            {subtitle ? (
              <Text style={[styles.subtitle, { color: colors.labelText }]}>{subtitle}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.actions}>
          {right}
          <Pressable
            testID="patient-avatar-btn"
            onPress={() => {
              Haptics.selectionAsync();
              router.push('/persona');
            }}
            style={({ pressed }) => [
              styles.avatar,
              { backgroundColor: colors.cobalt },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={[styles.avatarText, { color: colors.primaryForeground }]}>ES</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    zIndex: 10,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    paddingTop: 10,
    minHeight: 44,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  brandMark: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.4,
    marginTop: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  avatar: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
});
