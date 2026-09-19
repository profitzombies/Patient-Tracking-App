import React from 'react';
import { router } from 'expo-router';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { supabase } from '@/lib/supabase';

export default function ProgramEndedScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + 12;

  const backToSignIn = async () => {
    try {
      await supabase?.auth.signOut({ scope: 'local' });
    } finally {
      router.replace('/patient-login');
    }
  };

  return (
    <View
      testID="program-ended-screen"
      style={[
        styles.page,
        {
          backgroundColor: colors.background,
          paddingTop: topPad,
          paddingBottom: Math.max(insets.bottom, 24),
        },
      ]}
    >
      <View style={styles.content}>
        <Text style={[styles.brand, { color: colors.navy }]}>THINNR</Text>
        <View style={styles.notice}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.navy }]}>
            This program has ended
          </Text>
          <Text style={[styles.body, { color: colors.subtleText }]}>
            Your provider's THINNR program has ended, so this account can no longer be used.
            Contact your provider's office with any questions about your records.
          </Text>
        </View>
        <PrimaryButton
          testID="program-ended-sign-in"
          label="Back to sign in"
          onPress={() => void backToSignIn()}
          style={styles.button}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
  },
  content: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  brand: {
    fontSize: 22,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 4,
  },
  notice: {
    marginTop: 32,
  },
  title: {
    fontSize: 28,
    lineHeight: 35,
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  body: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: 'Inter_400Regular',
    marginTop: 12,
  },
  button: {
    marginTop: 32,
  },
});