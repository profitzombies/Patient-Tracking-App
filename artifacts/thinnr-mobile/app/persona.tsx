/**
 * Persona picker — choose between the care-team (staff) experience and the
 * patient companion experience. Shown on first launch and reachable any time
 * from the header avatar in either mode.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { useAppMode } from '@/context/AppModeContext';
import { supabase, useSupabaseSession } from '@/lib/supabase';

const CARD_SHADOW = '0 8px 20px rgba(40, 55, 74, 0.07)';

interface PersonaCardProps {
  icon: React.ComponentProps<typeof Feather>['name'];
  title: string;
  person: string;
  body: string;
  current: boolean;
  testID: string;
  onPress: () => void;
}

function PersonaCard({ icon, title, person, body, current, testID, onPress }: PersonaCardProps) {
  const colors = useColors();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: current ? colors.cobalt : colors.border,
          borderWidth: current ? 2 : 1,
          borderRadius: colors.radius,
          boxShadow: CARD_SHADOW,
        },
        pressed && { opacity: 0.88 },
      ]}
    >
      <View style={styles.cardTop}>
        <View style={[styles.cardIcon, { backgroundColor: colors.accent }]}>
          <Feather name={icon} size={18} color={colors.cobalt} />
        </View>
        {current ? (
          <View style={[styles.currentBadge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
            <Text style={[styles.currentBadgeText, { color: colors.activeGreen }]}>CURRENT</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.cardTitle, { color: colors.navy }]}>{title}</Text>
      <Text style={[styles.cardPerson, { color: colors.cobalt }]}>{person}</Text>
      <Text style={[styles.cardBody, { color: colors.bodyText }]}>{body}</Text>
      <View style={styles.cardCta}>
        <Text style={[styles.cardCtaText, { color: colors.cobalt }]}>
          {current ? 'Continue' : 'Enter'}
        </Text>
        <Feather name="arrow-right" size={14} color={colors.cobalt} />
      </View>
    </Pressable>
  );
}

export default function PersonaScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { mode, setMode } = useAppMode();
  const { session } = useSupabaseSession();

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const chooseStaff = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await setMode('staff');
    router.replace('/');
  };

  // Patient taps go to the real sign-in screen; the guided demo (Emma or the
  // simulated onboarding) stays one tap away from there.
  const openPatientLogin = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push('/patient-login');
  };

  const signOutReal = async () => {
    if (!supabase) return;
    Haptics.selectionAsync();
    await supabase.auth.signOut();
  };

  const sessionLabel = session?.user.email ?? (session?.user.phone ? `+${session.user.phone}` : null);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: topPad + 28 }]}>
      <View style={styles.inner}>
        <View style={styles.brandRow}>
          <View style={[styles.brandMark, { backgroundColor: colors.navy }]}>
            <Text style={[styles.brandMarkText, { color: colors.brandMarkText }]}>TH</Text>
          </View>
          <View>
            <Text style={[styles.brandName, { color: colors.navy }]}>THINNR</Text>
            <Text style={[styles.brandSub, { color: colors.labelText }]}>MED SPA OPERATIONS DEMO</Text>
          </View>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.labelText }]}>CHOOSE YOUR EXPERIENCE</Text>

        <PersonaCard
          testID="persona-staff"
          icon="briefcase"
          title="Care Team"
          person="Dr. Sarah Jenkins · Medical Director"
          body="Operations dashboard — patient roster, outcomes, leaderboard, and subscription health."
          current={mode === 'staff'}
          onPress={chooseStaff}
        />
        <PersonaCard
          testID="persona-patient"
          icon="user"
          title="Patient"
          person="Your daily companion"
          body="Sign in with your account, or explore the demo as Emma Smith — diary, check-ins, and coach chat."
          current={mode === 'patient'}
          onPress={openPatientLogin}
        />

        {session ? (
          <View
            style={[
              styles.sessionRow,
              { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm },
            ]}
          >
            <Text style={[styles.sessionText, { color: colors.bodyText }]} numberOfLines={1}>
              Signed in as {sessionLabel ?? 'your account'}
            </Text>
            <Pressable testID="persona-signout" accessibilityRole="button" onPress={signOutReal} hitSlop={8}>
              <Text style={[styles.sessionSignOut, { color: colors.cobalt }]}>Sign out</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={[styles.footer, { borderTopColor: colors.divider }]}>
        <Text style={[styles.footerText, { color: colors.labelText }]}>
          SYNTHETIC DEMO DATA  •  NOT MEDICAL ADVICE
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
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
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  currentBadge: {
    borderRadius: 5,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  currentBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
  cardTitle: {
    fontSize: 20,
    fontFamily: 'PlayfairDisplay_700Bold',
  },
  cardPerson: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 3,
  },
  cardBody: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    marginTop: 8,
  },
  cardCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
  },
  cardCtaText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.4,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 4,
  },
  sessionText: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
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
