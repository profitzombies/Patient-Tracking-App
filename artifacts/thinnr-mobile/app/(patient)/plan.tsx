/**
 * Plan — program status, editable daily targets, bloodwork, and the care
 * team connection. Heritage language: paper cards with soft
 * shadows, serif section titles, rounded pale-cobalt icon chips; all
 * colors and radii come from the shared theme tokens.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PageScrollView as ScrollView } from '@/components/ui/PageScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patientContentBottom } from '@/constants/layout';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import { phaseForDay } from '@/data/program-instructions';
import { PlanDietSection } from '@/components/diet/PlanDietSection';
import { TargetsEditor } from '@/components/diet/TargetsEditor';

const formatISO = (iso: string, includeYear = false) =>
  new Date(iso).toLocaleDateString('en-US', includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Serif section title sitting above a paper card (Heritage language). */
function SectionTitle({
  title,
  action,
}: {
  title: string;
  action?: { label: string; onPress: () => void };
}) {
  const colors = useColors();
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>{title}</Text>
      {action ? (
        <Pressable onPress={action.onPress} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
          <Text style={[styles.sectionAction, { color: colors.cobalt }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function PlanScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  // The patient's own program calendar, or nothing until it has loaded.
  const liveFacts = patient.entryFacts;
  const livePhase = liveFacts ? phaseForDay(liveFacts.programDay) : null;

  const bottomPad = patientContentBottom(insets.bottom);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader
        title="My Plan"
        subtitle="YOUR PROGRAM"
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Program status — featured card with cobalt accent strip ── */}
        <LedgerCard accentTop style={styles.programCard}>
          <View style={styles.cardPad}>
            <View style={styles.programTopRow}>
              <Text style={[styles.programName, { color: colors.navy }]}>THINNR Program</Text>
            </View>
            {liveFacts ? (
              <Text testID="plan-live-meta" style={[styles.programMeta, { color: colors.subtleText }]}>
                Week {Math.ceil(liveFacts.programDay / 7)} · Day {liveFacts.programDay} · Started{' '}
                {formatISO(liveFacts.programStartDate, true)}
              </Text>
            ) : null}
            <Divider style={{ marginTop: 12, marginBottom: 12 }} />
            <Pressable
              testID="plan-instructions-row"
              onPress={() => router.push('/instructions')}
              style={({ pressed }) => [styles.instructionsRow, pressed && { opacity: 0.7 }]}
            >
              <View
                style={[styles.iconChip, { backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}
              >
                <Feather name="book-open" size={15} color={colors.cobalt} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.instructionsKicker, { color: colors.labelText }]}>
                  PROGRAM INSTRUCTIONS
                </Text>
                <Text
                  style={[styles.instructionsValue, { color: colors.navyLight }]}
                  numberOfLines={1}
                >
                  {livePhase && liveFacts ? <>Day {liveFacts.programDay} · {livePhase.name}</> : 'Your program guide'}
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={colors.subtleText} />
            </Pressable>
          </View>
        </LedgerCard>

        {/* ── Eating plan: phase, diet rule sheet, restart history ── */}
        <SectionTitle title="Eating Plan" />
        <PlanDietSection onOpenPreferences={() => router.push('/food-preferences' as never)} />

        {/* ── Daily targets ── */}
        <SectionTitle title="Daily Targets" />
        {patient.dietTargets ? (
          <TargetsEditor targets={patient.dietTargets} />
        ) : (
          <LedgerCard style={styles.targetsCard} testID="targets-pending">
            <Text style={[styles.programMeta, { color: patient.dietStatus === 'error' ? colors.riskText : colors.subtleText }]}>
              {patient.dietStatus === 'error' ? 'Couldn’t load your targets right now.' : 'Calculating your targets…'}
            </Text>
          </LedgerCard>
        )}

        {/* ── Bloodwork ── */}
        <SectionTitle
          title="Bloodwork"
          action={{
            label: 'View history',
            onPress: () => router.push('/bloodwork'),
          }}
        />
        <LedgerCard style={[styles.sectionCard, { paddingVertical: 12 }]}>
          <Pressable
            onPress={() => router.push('/bloodwork/new')}
            style={({ pressed }) => [styles.instructionsRow, pressed && { opacity: 0.7 }]}
          >
            <View style={[styles.iconChip, { backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}>
              <Feather name="file-plus" size={15} color={colors.cobalt} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.instructionsKicker, { color: colors.labelText }]}>
                NEW REPORT
              </Text>
              <Text style={[styles.instructionsValue, { color: colors.navyLight }]} numberOfLines={1}>
                Add lab results
              </Text>
            </View>
            <Feather name="chevron-right" size={16} color={colors.subtleText} />
          </Pressable>
        </LedgerCard>

        {/* ── Care team ── */}
        <SectionTitle title="Your Care Team" />
        <LedgerCard style={{ padding: 16 }}>
          <View style={styles.careRow}>
            <View
              style={[styles.careAvatar, { backgroundColor: colors.navy, borderRadius: colors.radiusSm }]}
            >
              <Text style={[styles.careAvatarText, { color: colors.brandMarkText }]}>CT</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.careName, { color: colors.navyLight }]}>Care team</Text>
              <Text style={[styles.careRole, { color: colors.subtleText }]}>Your office</Text>
            </View>
          </View>
          <Divider style={{ marginVertical: 12 }} />
          <View style={styles.shipmentRow}>
            <Feather name="eye" size={13} color={colors.cobalt} />
            <Text style={[styles.shipmentText, { color: colors.bodyText }]}>
              Your daily logs and check-ins are reviewed by your care team each week.
            </Text>
          </View>
        </LedgerCard>

        <SyntheticDisclaimer />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
  },
  cardPad: {
    padding: 16,
  },
  programCard: {
    marginBottom: 18,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 8,
    marginLeft: 2,
  },
  sectionTitle: {
    fontSize: 19,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    lineHeight: 25,
  },
  sectionAction: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  programTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  programName: {
    fontSize: 20,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    lineHeight: 26,
    flex: 1,
  },
  programMeta: {
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  targetsCard: {
    paddingVertical: 4,
    marginBottom: 18,
  },
  sectionCard: {
    padding: 16,
    marginBottom: 18,
  },
  iconChip: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shipmentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 7,
  },
  shipmentText: {
    fontSize: 11.5,
    fontFamily: 'Inter_400Regular',
    flex: 1,
    lineHeight: 16,
  },
  careRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  careAvatar: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  careAvatarText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  careName: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  careRole: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  instructionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  instructionsKicker: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.3,
    fontFamily: 'Inter_700Bold',
  },
  instructionsValue: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 2,
  },
});
