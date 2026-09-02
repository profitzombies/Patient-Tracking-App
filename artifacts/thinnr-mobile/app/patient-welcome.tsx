import React from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';

export default function PatientWelcomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { admitDemo } = useAppMode();
  return <View style={[styles.page, { backgroundColor: colors.background, paddingTop: Platform.OS === 'web' ? Math.max(insets.top, 44) : insets.top + 12 }]}>
    <KeyboardAwareScrollViewCompat contentContainerStyle={styles.content}>
      <Text style={[styles.brand, { color: colors.navy }]}>THINNR</Text>
      <View style={styles.spacerTop} />
      <Image source={require('@/assets/images/icon_2.png')} accessibilityLabel="THINNR wellness" style={styles.hero} resizeMode="contain" />
      <Text style={[styles.kicker, { color: colors.labelText }]}>YOUR PERSONAL HEALTH COMPANION</Text>
      <Text style={[styles.title, { color: colors.navy }]}>Progress, with your care team beside you.</Text>
      <Text style={[styles.body, { color: colors.subtleText }]}>Keep your daily plan, meals, check-ins, and coaching in one calm place.</Text>
      <View style={styles.spacerBottom} />
      <PrimaryButton testID="welcome-login" label="Log In" onPress={() => router.push('/patient-login')} style={styles.primary} />
      <Pressable testID="welcome-signup" accessibilityRole="button" accessibilityLabel="Create new account" onPress={() => router.push('/patient-signup')} style={({ pressed }) => [styles.secondary, { borderColor: colors.cobalt, backgroundColor: colors.card }, pressed && { opacity: 0.7 }]}><Text style={[styles.secondaryText, { color: colors.cobalt }]}>Create New Account</Text></Pressable>
      <View style={styles.links}>
        <Pressable testID="welcome-demo" accessibilityRole="button" onPress={async () => { await admitDemo(); router.push('/patient-entry'); }} style={styles.linkHit}><Text style={[styles.link, { color: colors.subtleText }]}>Explore demo</Text></Pressable>
        <Text style={[styles.linkDot, { color: colors.labelText }]}>·</Text>
        <Pressable testID="welcome-provider" accessibilityRole="button" onPress={() => router.push('/provider-login')} style={styles.linkHit}><Text style={[styles.link, { color: colors.subtleText }]}>Provider login</Text></Pressable>
      </View>
    </KeyboardAwareScrollViewCompat>
  </View>;
}
const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: 24, paddingBottom: 28, flexGrow: 1, alignItems: 'center', maxWidth: 520, width: '100%', alignSelf: 'center' },
  brand: { alignSelf: 'flex-start', fontSize: 22, fontFamily: 'PlayfairDisplay_700Bold', letterSpacing: 4 },
  spacerTop: { flexGrow: 1, minHeight: 16 },
  spacerBottom: { flexGrow: 1.2, minHeight: 28 },
  hero: { width: 150, height: 150 },
  kicker: { fontSize: 10.5, fontFamily: 'Inter_700Bold', letterSpacing: 1.4, textAlign: 'center', marginTop: 18 },
  title: { fontSize: 31, lineHeight: 39, fontFamily: 'PlayfairDisplay_700Bold', textAlign: 'center', marginTop: 12 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 12 },
  primary: { alignSelf: 'stretch' },
  secondary: { alignSelf: 'stretch', borderWidth: 1, borderRadius: 7, minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  secondaryText: { fontSize: 14, fontFamily: 'Inter_700Bold', letterSpacing: 0.3 },
  links: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  linkHit: { paddingVertical: 6, paddingHorizontal: 4 },
  link: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  linkDot: { fontSize: 13, fontFamily: 'Inter_700Bold' },
});
