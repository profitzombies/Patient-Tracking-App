/**
 * Plan — program status, editable daily targets, product deliveries, and
 * the care team connection. Heritage language: paper cards with soft
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
import { Divider, LedgerCard, StatusBadge } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import { useLivePatient } from '@/hooks/useLivePatient';
import {
  DEFAULT_TARGETS,
  ENROLLMENT_DAYS,
  PATIENT_PRODUCTS,
  PATIENT_PROFILE,
  PATIENT_PROVIDER,
  PATIENT_SUBSCRIPTION,
  type DailyTargets,
} from '@/data/patient-data';
import { phaseForDay } from '@/data/program-instructions';

const formatISO = (iso: string, includeYear = false) =>
  new Date(iso).toLocaleDateString('en-US', includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }
    : { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Where the patient is in the THINNR protocol — drives the instructions row.
const CURRENT_PHASE = phaseForDay(ENROLLMENT_DAYS);

interface TargetRowProps {
  label: string;
  unit: string;
  value: number;
  step: number;
  min: number;
  max: number;
  testID: string;
  onChange: (next: number) => void;
}

function TargetRow({ label, unit, value, step, min, max, testID, onChange }: TargetRowProps) {
  const colors = useColors();
  const dec = () => onChange(Math.max(min, value - step));
  const inc = () => onChange(Math.min(max, value + step));
  return (
    <View style={styles.targetRow}>
      <Text style={[styles.targetLabel, { color: colors.labelText }]}>{label.toUpperCase()}</Text>
      <View style={styles.targetControls}>
        <Pressable
          testID={`${testID}-minus`}
          onPress={dec}
          disabled={value <= min}
          style={({ pressed }) => [
            styles.stepBtn,
            {
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
            value <= min && { opacity: 0.35 },
          ]}
        >
          <Feather name="minus" size={13} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.targetValue, { color: colors.navy }]}>
          {value.toLocaleString('en-US')}
          <Text style={[styles.targetUnit, { color: colors.subtleText }]}> {unit}</Text>
        </Text>
        <Pressable
          testID={`${testID}-plus`}
          onPress={inc}
          disabled={value >= max}
          style={({ pressed }) => [
            styles.stepBtn,
            {
              borderColor: colors.border,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
            value >= max && { opacity: 0.35 },
          ]}
        >
          <Feather name="plus" size={13} color={colors.bodyText} />
        </Pressable>
      </View>
    </View>
  );
}

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
  // A signed-in patient sees their own program calendar (or nothing yet),
  // never the demo persona's care plan, deliveries or check-in date.
  const live = useLivePatient();
  const liveFacts = live ? patient.entryFacts : null;
  const livePhase = liveFacts ? phaseForDay(liveFacts.programDay) : null;

  const bottomPad = patientContentBottom(insets.bottom);
  const week = Math.ceil(ENROLLMENT_DAYS / 7);

  const setTarget = (key: keyof DailyTargets) => (next: number) => {
    patient.setTargets({ [key]: next });
  };

  const isDefaultTargets = (Object.keys(DEFAULT_TARGETS) as (keyof DailyTargets)[])
    .every(key => patient.targets[key] === DEFAULT_TARGETS[key]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader
        title="My Plan"
        subtitle={live ? 'YOUR PROGRAM' : PATIENT_PROFILE.carePlan.name.toUpperCase()}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Program status — featured card with cobalt accent strip ── */}
        <LedgerCard accentTop style={styles.programCard}>
          <View style={styles.cardPad}>
            {live ? (
              <>
                <View style={styles.programTopRow}>
                  <Text style={[styles.programName, { color: colors.navy }]}>THINNR Program</Text>
                </View>
                {liveFacts ? (
                  <Text testID="plan-live-meta" style={[styles.programMeta, { color: colors.subtleText }]}>
                    Week {Math.ceil(liveFacts.programDay / 7)} · Day {liveFacts.programDay} · Started{' '}
                    {formatISO(liveFacts.programStartDate, true)}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <View style={styles.programTopRow}>
                  <Text style={[styles.programName, { color: colors.navy }]}>{PATIENT_PROFILE.carePlan.name}</Text>
                  <StatusBadge status={PATIENT_PROFILE.stage} />
                </View>
                <Text style={[styles.programMeta, { color: colors.subtleText }]}>
                  Week {week} · Day {ENROLLMENT_DAYS} · Started {formatISO(PATIENT_PROFILE.startDate, true)}
                </Text>
                <Divider style={{ marginVertical: 12 }} />
                <View style={styles.programDetailRow}>
                  <Feather name="check-square" size={14} color={colors.activeGreen} />
                  <Text style={[styles.programDetailText, { color: colors.bodyText }]}>
                    Six-week protocol completed — now in maintenance.
                  </Text>
                </View>
                <View style={styles.programDetailRow}>
                  <Feather name="target" size={14} color={colors.cobalt} />
                  <Text style={[styles.programDetailText, { color: colors.bodyText }]}>
                    {PATIENT_PROFILE.carePlan.focus}
                  </Text>
                </View>
                <View style={styles.programDetailRow}>
                  <Feather name="calendar" size={14} color={colors.cobalt} />
                  <Text style={[styles.programDetailText, { color: colors.bodyText }]}>
                    {PATIENT_PROFILE.carePlan.cadence} · Next: {PATIENT_PROFILE.carePlan.nextMilestone}
                  </Text>
                </View>
              </>
            )}
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
                  {live ? (
                    livePhase && liveFacts ? <>Day {liveFacts.programDay} · {livePhase.name}</> : 'Your program guide'
                  ) : (
                    <>Day {ENROLLMENT_DAYS} · {CURRENT_PHASE.name}</>
                  )}
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={colors.subtleText} />
            </Pressable>
          </View>
        </LedgerCard>

        {/* ── Daily targets ── */}
        <SectionTitle
          title="Daily Targets"
          action={isDefaultTargets ? undefined : {
            label: 'Reset to plan',
            onPress: () => patient.setTargets({ ...DEFAULT_TARGETS }),
          }}
        />
        <LedgerCard style={styles.targetsCard}>
          <TargetRow
            label="Calories" unit="cal" testID="target-calories"
            value={patient.targets.calories} step={50} min={1000} max={3000}
            onChange={setTarget('calories')}
          />
          <Divider />
          <TargetRow
            label="Protein" unit="g" testID="target-protein"
            value={patient.targets.protein} step={5} min={60} max={220}
            onChange={setTarget('protein')}
          />
          <Divider />
          <TargetRow
            label="Carbs" unit="g" testID="target-carbs"
            value={patient.targets.carbs} step={5} min={50} max={320}
            onChange={setTarget('carbs')}
          />
          <Divider />
          <TargetRow
            label="Fat" unit="g" testID="target-fat"
            value={patient.targets.fat} step={5} min={20} max={130}
            onChange={setTarget('fat')}
          />
          <Divider />
          <TargetRow
            label="Water" unit="fl oz" testID="target-water"
            value={patient.targets.waterOz} step={8} min={32} max={160}
            onChange={setTarget('waterOz')}
          />
        </LedgerCard>

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

        {/* ── Deliveries ── */}
        {!live && PATIENT_SUBSCRIPTION ? (
          <>
            <SectionTitle title="Product Deliveries" />
            <LedgerCard style={styles.sectionCard}>
              <View style={styles.programTopRow}>
                <Text style={[styles.deliveryTitle, { color: colors.navyLight }]}>
                  Monthly · ${PATIENT_SUBSCRIPTION.monthlyValue}/mo
                </Text>
                <StatusBadge status={PATIENT_SUBSCRIPTION.status} />
              </View>
              {PATIENT_PRODUCTS.map(product => (
                <View key={product.id} style={styles.productRow}>
                  <View
                    style={[styles.iconChip, { backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}
                  >
                    <Feather name="package" size={14} color={colors.cobalt} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.productName, { color: colors.navyLight }]}>{product.name}</Text>
                    <Text style={[styles.productDesc, { color: colors.subtleText }]} numberOfLines={2}>
                      {product.description}
                    </Text>
                  </View>
                  <Text style={[styles.productPrice, { color: colors.navyLight }]}>${product.price}</Text>
                </View>
              ))}
              <Divider style={{ marginVertical: 10 }} />
              <View style={styles.shipmentRow}>
                <Feather name="truck" size={13} color={colors.cobalt} />
                <Text style={[styles.shipmentText, { color: colors.bodyText }]}>
                  Next shipment {formatISO(PATIENT_SUBSCRIPTION.nextShipment)}
                </Text>
              </View>
              {PATIENT_SUBSCRIPTION.shipmentHistory.slice(0, 2).map((shipment, index) => (
                <View key={`${shipment.date}-${index}`} style={styles.shipmentRow}>
                  <Feather name="check" size={13} color={colors.activeGreen} />
                  <Text style={[styles.shipmentText, { color: colors.subtleText }]}>
                    Delivered {formatISO(shipment.date, true)}
                  </Text>
                </View>
              ))}
            </LedgerCard>
          </>
        ) : null}

        {/* ── Care team ── */}
        <SectionTitle title="Your Care Team" />
        <LedgerCard style={{ padding: 16 }}>
          <View style={styles.careRow}>
            <View
              style={[styles.careAvatar, { backgroundColor: colors.navy, borderRadius: colors.radiusSm }]}
            >
              <Text style={[styles.careAvatarText, { color: colors.brandMarkText }]}>
                {!live && PATIENT_PROVIDER ? PATIENT_PROVIDER.name.split(' ').slice(0, 2).map(n => n[0]).join('') : 'CT'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.careName, { color: colors.navyLight }]}>
                {live ? 'Care team' : PATIENT_PROVIDER?.name ?? 'Care team'}
              </Text>
              <Text style={[styles.careRole, { color: colors.subtleText }]}>
                {live ? 'Your office' : PATIENT_PROVIDER?.role ?? 'THINNR Med Spa'}
              </Text>
            </View>
          </View>
          <Divider style={{ marginVertical: 12 }} />
          {live ? null : (
            <View style={styles.shipmentRow}>
              <Feather name="calendar" size={13} color={colors.cobalt} />
              <Text style={[styles.shipmentText, { color: colors.bodyText }]}>
                Next check-in {formatISO(PATIENT_PROFILE.nextCheckIn)}
              </Text>
            </View>
          )}
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
  programDetailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    marginTop: 8,
  },
  programDetailText: {
    fontSize: 12,
    lineHeight: 17,
    flex: 1,
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
  targetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  targetLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
  },
  targetControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 28,
    height: 28,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  targetValue: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    minWidth: 76,
    textAlign: 'center',
  },
  targetUnit: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
  },
  deliveryTitle: {
    fontSize: 16,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    flex: 1,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
  },
  iconChip: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  productName: {
    fontSize: 14.5,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  productDesc: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
    lineHeight: 14,
  },
  productPrice: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
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
