/**
 * Patient entry chooser — restyled take on the real app's welcome screen.
 * Existing patient: one-tap prefilled sign-in as Emma Smith.
 * New patient: starts the simulated onboarding flow (mock data, repeatable).
 */
import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import {
  FieldLabel,
  LedgerInput,
  NoteText,
  PrimaryButton,
} from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { useOnboarding } from '@/context/OnboardingContext';

export default function PatientEntryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setMode } = useAppMode();
  const { reset } = useOnboarding();
  const [email, setEmail] = useState('emma.smith@example.com');
  const [password, setPassword] = useState('Demo123!');

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const signInAsEmma = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await setMode('patient');
    router.replace('/today');
  };

  const startOnboarding = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    reset();
    router.push('/onboarding/welcome');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad }]}>
      <View style={styles.headerRow}>
        <Pressable
          testID="entry-back"
          accessibilityRole="button"
          accessibilityLabel="Back to persona picker"
          onPress={() => {
            Haptics.selectionAsync();
            if (router.canGoBack()) router.back();
            else router.replace('/persona');
          }}
          style={({ pressed }) => [
            styles.backBtn,
            { borderColor: colors.border, backgroundColor: colors.card },
            pressed && { backgroundColor: colors.accent },
          ]}
        >
          <Feather name="chevron-left" size={18} color={colors.navy} />
        </Pressable>
        <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
          <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
        </View>
        <View style={styles.backBtnSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
        showsVerticalScrollIndicator={false}
        bottomOffset={96}
      >
        <Text style={[styles.kicker, { color: colors.labelText }]}>PATIENT ACCESS</Text>
        <Text style={[styles.title, { color: colors.navy }]}>Welcome back</Text>

        <LedgerCard style={styles.signInCard}>
          <FieldLabel text="Phone or email" />
          <LedgerInput
            testID="entry-email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
          />
          <View style={styles.fieldGap}>
            <FieldLabel text="Password" />
            <LedgerInput
              testID="entry-password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
            />
          </View>
          <PrimaryButton
            testID="entry-signin"
            label="Sign in as Emma Smith"
            onPress={signInAsEmma}
            style={styles.signInBtn}
          />
          <NoteText center text="Demo account — credentials are prefilled, just tap sign in." />
        </LedgerCard>

        <View style={styles.dividerRow}>
          <View style={[styles.dividerLine, { backgroundColor: colors.divider }]} />
          <Text style={[styles.dividerText, { color: colors.labelText }]}>NEW TO THINNR?</Text>
          <View style={[styles.dividerLine, { backgroundColor: colors.divider }]} />
        </View>

        <Pressable
          testID="entry-new"
          onPress={startOnboarding}
          style={({ pressed }) => [
            styles.newCard,
            { backgroundColor: colors.card, borderColor: colors.cobalt },
            pressed && { opacity: 0.88 },
          ]}
        >
          <View style={[styles.newIcon, { backgroundColor: colors.cobalt }]}>
            <Feather name="user-plus" size={16} color={colors.primaryForeground} />
          </View>
          <View style={styles.newBody}>
            <Text style={[styles.newTitle, { color: colors.navy }]}>Simulate new patient onboarding</Text>
            <Text style={[styles.newText, { color: colors.subtleText }]}>
              Walk the full signup flow — verification, provider code, profile, and reminders — with mock data. Repeatable, nothing is saved.
            </Text>
          </View>
          <Feather name="arrow-right" size={16} color={colors.cobalt} />
        </Pressable>

        <Text style={[styles.footerText, { color: colors.labelText }]}>
          SYNTHETIC DEMO DATA  •  NOT MEDICAL ADVICE
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  backBtn: {
    width: 44,
    height: 44,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnSpacer: {
    width: 44,
  },
  brandMark: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 16,
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    marginBottom: 6,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
    marginBottom: 16,
  },
  signInCard: {
    padding: 16,
  },
  fieldGap: {
    marginTop: 12,
  },
  signInBtn: {
    marginTop: 16,
    marginBottom: 10,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  newCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    padding: 16,
    gap: 12,
  },
  newIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newBody: {
    flex: 1,
  },
  newTitle: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.2,
  },
  newText: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
    marginTop: 3,
  },
  footerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginTop: 24,
  },
});
