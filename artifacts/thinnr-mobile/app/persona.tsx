/**
 * Account screen reached from the header avatar: who is signed in, a way
 * back into their app, and sign-out. A signed-out visitor is sent to the
 * patient front door, which also links to provider sign-in.
 */
import React from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Redirect, router, type Href } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { supabase, useSupabaseSession } from '@/lib/supabase';
import { useDeviceFeatures } from '@/context/DeviceFeaturesContext';
import { ADVICE_DISCLAIMER } from '@/lib/disclaimer';

const CARD_SHADOW = '0 8px 20px rgba(40, 55, 74, 0.07)';

export default function PersonaScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mode } = useAppMode();
  const { session, sessionLoading } = useSupabaseSession();
  const device = useDeviceFeatures();
  const signedIn = Boolean(session?.user);

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const signOutReal = async () => {
    if (!supabase) return;
    Haptics.selectionAsync();
    await device.unregisterBeforeSignOut('account_switch');
    await supabase.auth.signOut();
  };

  const continueToApp = () => {
    Haptics.selectionAsync();
    router.replace(mode === 'staff' ? '/' : '/today');
  };

  const sessionLabel = session?.user.email ?? (session?.user.phone ? `+${session.user.phone}` : null);

  if (sessionLoading) {
    return (
      <View style={[styles.container, styles.loading, { backgroundColor: colors.background }]}>
        <ActivityIndicator accessibilityLabel="Checking your sign-in" />
      </View>
    );
  }
  // Signed-out visitors start at the patient front door, which also links to
  // provider sign-in.
  if (!signedIn) return <Redirect href={'/patient-welcome' as Href} />;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad + 28 }]}>
      <View style={styles.inner}>
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
            <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
          </View>
          <View>
            <Text style={[styles.brandName, { color: colors.navy }]}>THINNR</Text>
            <Text style={[styles.brandSub, { color: colors.labelText }]}>YOUR ACCOUNT</Text>
          </View>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.labelText }]}>SIGNED IN</Text>
            <View
              testID="persona-account"
              style={[
                styles.card,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  borderWidth: 1,
                  borderRadius: colors.radius,
                  boxShadow: CARD_SHADOW,
                },
              ]}
            >
              <Text style={[styles.accountLabel, { color: colors.labelText }]}>Signed in as</Text>
              <Text style={[styles.accountValue, { color: colors.navy }]} numberOfLines={1}>
                {sessionLabel ?? 'your account'}
              </Text>
              <View style={[styles.accountActions, { borderTopColor: colors.divider }]}>
                {mode ? (
                  <Pressable
                    testID="persona-continue"
                    accessibilityRole="button"
                    onPress={continueToApp}
                    hitSlop={8}
                    style={({ pressed }) => [styles.accountContinue, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.cardCtaText, { color: colors.cobalt }]}>
                      {mode === 'staff' ? 'Continue to your office' : 'Continue to your day'}
                    </Text>
                    <Feather name="arrow-right" size={14} color={colors.cobalt} />
                  </Pressable>
                ) : (
                  <View />
                )}
                <Pressable testID="persona-signout" accessibilityRole="button" onPress={signOutReal} hitSlop={8}>
                  <Text style={[styles.sessionSignOut, { color: colors.cobalt }]}>Sign out</Text>
                </Pressable>
              </View>
            </View>
      </View>

      <View style={[styles.footer, { borderTopColor: colors.divider }]}>
        <Text style={[styles.footerText, { color: colors.labelText }]}>
          {ADVICE_DISCLAIMER}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  inner: {
    flex: 1,
    paddingHorizontal: 20,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 36,
  },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkText: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  brandName: {
    fontSize: 20,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 3,
  },
  brandSub: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1.4,
    marginTop: 2,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
    marginBottom: 12,
  },
  card: {
    padding: 18,
    marginBottom: 14,
  },
  cardCtaText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.4,
  },
  accountLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.4,
  },
  accountValue: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    fontWeight: '600',
    marginTop: 4,
  },
  accountActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 12,
  },
  accountContinue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sessionSignOut: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  footer: {
    borderTopWidth: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
    fontFamily: 'Inter_700Bold',
  },
});
