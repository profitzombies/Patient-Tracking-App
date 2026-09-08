import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { FramedPlateHeader } from '@/components/auth/FramedPlateHeader';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';

export default function PatientWelcomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { admitDemo } = useAppMode();
  return <View style={[styles.page, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + 12 }]}>
    <KeyboardAwareScrollViewCompat contentContainerStyle={styles.content}>
      <View style={styles.topBar}>
        <Text style={[styles.brand, { color: colors.navy }]}>THINNR</Text>
        <Text style={[styles.topNote, { color: colors.subtleText }]}>Patient app</Text>
      </View>
      <View style={styles.spacerTop} />
      <LedgerCard style={styles.card}>
        <FramedPlateHeader
          audience="YOUR PERSONAL HEALTH COMPANION"
          title="Progress, with your care team beside you."
          imageHeight={236}
        />
        <View style={styles.cardBody}>
          <Text style={[styles.body, { color: colors.subtleText }]}>Keep your daily plan, meals, check-ins, and coaching in one calm place.</Text>
          <View style={[styles.rule, { backgroundColor: colors.border }]} />
          <PrimaryButton testID="welcome-login" label="Log In" onPress={() => router.push('/patient-login')} style={styles.primary} />
          <Pressable testID="welcome-signup" accessibilityRole="button" accessibilityLabel="Create new account" onPress={() => router.push('/patient-signup')} style={({ pressed }) => [styles.secondary, { borderColor: colors.cobalt, backgroundColor: colors.card }, pressed && { opacity: 0.7 }]}><Text style={[styles.secondaryText, { color: colors.cobalt }]}>Create New Account</Text></Pressable>
        </View>
      </LedgerCard>
      <View style={styles.links}>
        <Pressable testID="welcome-demo" accessibilityRole="button" onPress={async () => { await admitDemo(); router.push('/patient-entry'); }} style={styles.linkHit}><Text style={[styles.link, { color: colors.subtleText }]}>Explore demo</Text></Pressable>
        <Text style={[styles.linkDot, { color: colors.labelText }]}>·</Text>
        <Pressable testID="welcome-provider" accessibilityRole="button" onPress={() => router.push('/provider-login')} style={styles.linkHit}><Text style={[styles.link, { color: colors.subtleText }]}>Provider login</Text></Pressable>
      </View>
      <Text style={[styles.footnote, { color: colors.subtleText }]}>Your health journey, supported by your care team.</Text>
      <View style={styles.spacerBottom} />
    </KeyboardAwareScrollViewCompat>
  </View>;
}
const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 28, flexGrow: 1, alignItems: 'center', maxWidth: 520, width: '100%', alignSelf: 'center' },
  topBar: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 2 },
  brand: { fontSize: 23, fontFamily: 'PlayfairDisplay_600SemiBold', letterSpacing: -0.5 },
  topNote: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  spacerTop: { flexGrow: 1, minHeight: 18 },
  spacerBottom: { flexGrow: 1.4, minHeight: 12 },
  card: { alignSelf: 'stretch' },
  cardBody: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 18 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Inter_400Regular' },
  rule: { height: 1, marginTop: 16, marginBottom: 16 },
  primary: { alignSelf: 'stretch' },
  secondary: { alignSelf: 'stretch', borderWidth: 1, borderRadius: 7, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 10 },
  secondaryText: { fontSize: 14, fontFamily: 'Inter_700Bold', letterSpacing: 0.3 },
  links: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  linkHit: { paddingVertical: 6, paddingHorizontal: 4 },
  link: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  linkDot: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  footnote: { fontSize: 12, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 10 },
});
