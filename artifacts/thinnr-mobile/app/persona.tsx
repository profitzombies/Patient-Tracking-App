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
import { useAppMode, type AppMode } from '@/context/AppModeContext';

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
        },
        pressed && { opacity: 0.88 },
      ]}
    >
      <View style={styles.cardTop}>
        <View style={[styles.cardIcon, { backgroundColor: colors.navy }]}>
          <Feather name={icon} size={18} color={colors.brandMarkText} />
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

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;

  const choose = async (next: AppMode) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await setMode(next);
    router.replace(next === 'staff' ? '/' : '/today');
  };

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
          onPress={() => choose('staff')}
        />
        <PersonaCard
          testID="persona-patient"
          icon="user"
          title="Patient"
          person="Emma Smith · Maintenance stage"
          body="Daily companion — log meals and water, complete check-ins, browse recipes, and track progress."
          current={mode === 'patient'}
          onPress={() => choose('patient')}
        />
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
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  currentBadge: {
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
    fontSize: 17,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.3,
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
