import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';
import theme, { fonts } from '@/constants/colors';
import { Divider, LedgerCard, ProgressBar, SectionHeader, StatusBadge } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { MOCK_PRODUCTS, MOCK_PROVIDERS } from '@/data/mock-data';
import { useOperations } from '@/context/OperationsContext';

const formatDate = (date: string, includeYear = false) =>
  new Date(date).toLocaleDateString('en-US', includeYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' });

function WeightTrendChart({ history, startWeight, goalWeight }: {
  history: { date: string; weight: number }[];
  startWeight: number;
  goalWeight: number;
}) {
  const colors = useColors();
  const chartWidth = Math.max(330, history.length * 52);
  const chartHeight = 166;
  const top = 16;
  const bottom = 34;
  const side = 22;
  const values = [...history.map(entry => entry.weight), startWeight, goalWeight];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = Math.max(2, (high - low) * 0.14);
  const min = low - padding;
  const max = high + padding;
  const range = Math.max(1, max - min);
  const plotHeight = chartHeight - top - bottom;
  const xFor = (index: number) => history.length < 2
    ? chartWidth / 2
    : side + (index / (history.length - 1)) * (chartWidth - side * 2);
  const yFor = (weight: number) => top + ((max - weight) / range) * plotHeight;
  const path = history.map((entry, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(entry.weight)}`).join(' ');
  const goalY = yFor(goalWeight);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ paddingRight: 8 }}
      accessibilityLabel="Weight trend chart; swipe horizontally to review all weigh-ins"
    >
      <Svg width={chartWidth} height={chartHeight}>
        <Line x1={side} x2={chartWidth - side} y1={goalY} y2={goalY} stroke={colors.cobaltMuted} strokeWidth={1} strokeDasharray="4 4" />
        <SvgText x={chartWidth - side} y={Math.max(12, goalY - 5)} textAnchor="end" fill={colors.subtleText} fontSize="9">
          Goal {goalWeight.toFixed(1)}
        </SvgText>
        <Line x1={side} x2={chartWidth - side} y1={top + plotHeight} y2={top + plotHeight} stroke={colors.divider} strokeWidth={1} />
        <Path d={path} fill="none" stroke={colors.cobalt} strokeWidth={2.5} />
        {history.map((entry, index) => (
          <React.Fragment key={`${entry.date}-${index}`}>
            <Circle cx={xFor(index)} cy={yFor(entry.weight)} r={3.5} fill={colors.card} stroke={colors.cobalt} strokeWidth={2} />
            <SvgText x={xFor(index)} y={chartHeight - 12} textAnchor="middle" fill={colors.subtleText} fontSize="8">
              {formatDate(entry.date)}
            </SvgText>
          </React.Fragment>
        ))}
      </Svg>
    </ScrollView>
  );
}

export default function PatientDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const ops = useOperations();

  // Use merged projections so overrides are always reflected after hydration
  const patient = useMemo(() => ops.mergedPatients.find(p => p.id === id), [ops.mergedPatients, id]);
  const provider = MOCK_PROVIDERS.find(p => p.id === patient?.providerId);
  const subscription = useMemo(
    () => ops.mergedSubscriptions.find(s => s.patientId === patient?.id),
    [ops.mergedSubscriptions, patient?.id],
  );
  const products = useMemo(
    () =>
      (patient?.products ?? [])
        .map(pid => MOCK_PRODUCTS.find(pr => pr.id === pid))
        .filter(Boolean) as typeof MOCK_PRODUCTS,
    [patient],
  );

  // ─── Local UI state ────────────────────────────────────────────────────────
  const [editOpen, setEditOpen] = useState(false);
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [emailError, setEmailError] = useState('');

  const [weightModalOpen, setWeightModalOpen] = useState(false);
  const [weightDraft, setWeightDraft] = useState('');
  const [weightError, setWeightError] = useState('');
  const [weightSaved, setWeightSaved] = useState(false);

  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);

  const [subModalOpen, setSubModalOpen] = useState(false);
  const [subStatusDraft, setSubStatusDraft] = useState<'active' | 'paused' | 'overdue' | 'cancelled'>('active');

  const topPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomPad = Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20;
  const modalAnimation = Platform.OS === 'web' ? 'none' as const : 'slide' as const;
  const returnToRoster = () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/patients');
  };

  // Guard: don't render interactive content before hydration to avoid acting on default state
  if (!ops.hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={[styles.header, { paddingTop: topPad + 8, backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border }]}>
          <Pressable testID="patient-back-btn" onPress={returnToRoster}
            style={({ pressed }) => [styles.headerBtn, { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border }]}>
            <Feather name="arrow-left" size={16} color={colors.bodyText} />
          </Pressable>
          <View style={{ flex: 1 }} />
        </View>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.cobalt} />
        </View>
      </View>
    );
  }

  if (!patient) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontFamily: 'Inter_600SemiBold' }}>Patient not found.</Text>
        <Pressable onPress={returnToRoster} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.cobalt, fontSize: 14, fontFamily: 'Inter_600SemiBold' }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // Merged patient already carries contact overrides and latest weight
  const contact = { email: patient.email, phone: patient.phone };
  const weightHistory = [...patient.progressHistory].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  const localNotes = ops.getPatientNotes(patient.id);
  // Merged subscription already carries status override
  const subStatus = subscription?.status ?? 'active';

  const currentWeight = weightHistory.at(-1)?.weight ?? patient.currentWeight;
  const weightLoss = patient.startingWeight - currentWeight;
  const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
  const goalProgress = Math.min(100, Math.max(0, (weightLoss / (patient.startingWeight - patient.goalWeight)) * 100));
  const poundsToGoal = Math.max(0, currentWeight - patient.goalWeight);
  const orderedWeights = [...weightHistory].reverse();
  const orderedActivity = [
    ...localNotes.map(note => ({
      id: note.id,
      date: note.date,
      type: 'note',
      description: note.text,
      user: note.user,
    })),
    ...patient.activity,
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const latestReadingDate = weightHistory.at(-1)?.date ?? patient.startDate;

  // ─── Actions ───────────────────────────────────────────────────────────────
  const openEdit = () => {
    setEditEmail(contact.email);
    setEditPhone(contact.phone);
    setEmailError('');
    setEditOpen(true);
  };

  const saveContact = useCallback(async () => {
    if (!editEmail.includes('@')) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailError('');
    await ops.saveContactOverride({ patientId: patient.id, email: editEmail, phone: editPhone });
    setEditOpen(false);
  }, [editEmail, editPhone, ops, patient.id]);

  const openWeightModal = () => {
    setWeightDraft(currentWeight.toFixed(1));
    setWeightError('');
    setWeightSaved(false);
    setWeightModalOpen(true);
  };

  const saveWeight = useCallback(async () => {
    const n = parseFloat(weightDraft);
    if (!Number.isFinite(n) || n < 50 || n > 800) {
      setWeightError('Enter a weight between 50 and 800 lbs.');
      return;
    }
    setWeightError('');
    await ops.appendWeightEntry({ patientId: patient.id, date: new Date().toISOString(), weight: n });
    setWeightSaved(true);
    setTimeout(() => setWeightModalOpen(false), 800);
  }, [weightDraft, ops, patient.id]);

  const openNoteModal = () => {
    setNoteDraft('');
    setNoteSaved(false);
    setNoteModalOpen(true);
  };

  const saveNote = useCallback(async () => {
    const text = noteDraft.trim();
    if (!text) return;
    await ops.appendNote({
      patientId: patient.id,
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      date: new Date().toISOString(),
      text,
      user: 'Dr. Sarah Jenkins',
    });
    setNoteSaved(true);
    setTimeout(() => setNoteModalOpen(false), 800);
  }, [noteDraft, ops, patient.id]);

  const openSubModal = () => {
    setSubStatusDraft(subStatus);
    setSubModalOpen(true);
  };

  const saveSubStatus = useCallback(async () => {
    await ops.saveSubStatusOverride({ patientId: patient.id, status: subStatusDraft });
    setSubModalOpen(false);
  }, [ops, patient.id, subStatusDraft]);

  const SUB_STATUS_OPTIONS: ('active' | 'paused' | 'overdue' | 'cancelled')[] = ['active', 'paused', 'overdue', 'cancelled'];

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Custom header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: topPad + 8,
            backgroundColor: colors.paperCardAlt,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable
          testID="patient-back-btn"
          onPress={() => {
            Haptics.selectionAsync();
            returnToRoster();
          }}
          style={({ pressed }) => [styles.headerBtn, { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border }]}
        >
          <Feather name="arrow-left" size={16} color={colors.bodyText} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.navy }]} numberOfLines={1}>
          {patient.name}
        </Text>
        <Pressable
          testID="patient-edit-btn"
          onPress={openEdit}
          style={({ pressed }) => [styles.headerBtn, { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border }]}
        >
          <Feather name="edit-2" size={15} color={colors.bodyText} />
        </Pressable>
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={{ paddingBottom: bottomPad }}
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
      >
        {/* Identity block */}
        <View style={[styles.identityBlock, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
          <View style={[styles.avatar, { backgroundColor: colors.activeBg }]}>
            <Text style={[styles.avatarText, { color: colors.cobalt }]}>{patient.initials}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.nameRow}>
              <Text style={[styles.patientName, { color: colors.navy }]}>{patient.name}</Text>
              <StatusBadge status={patient.status} />
            </View>
            <View style={styles.contactRow}>
              <Feather name="mail" size={12} color={colors.subtleText} />
              <Text style={[styles.contactText, { color: colors.bodyText }]}>{contact.email}</Text>
            </View>
            <View style={styles.contactRow}>
              <Feather name="phone" size={12} color={colors.subtleText} />
              <Text style={[styles.contactText, { color: colors.bodyText }]}>{contact.phone}</Text>
            </View>
            <View style={styles.contactRow}>
              <Feather name="user" size={12} color={colors.subtleText} />
              <Text style={[styles.contactText, { color: colors.bodyText }]}>{provider?.name}</Text>
            </View>
            <Text style={[styles.recordId, { color: colors.labelText }]}>
              SYNTHETIC RECORD #{patient.id.replace('pat_', '')} · ENROLLED {formatDate(patient.startDate, true).toUpperCase()}
            </Text>
          </View>
        </View>

        {/* Protocol progress */}
        <View style={styles.section}>
          <LedgerCard style={{ padding: 16 }}>
            <View style={styles.progressTitleRow}>
              <View style={{ flex: 1 }}>
                <SectionHeader label="Progress at a glance" />
                <Text style={[styles.sectionIntro, { color: colors.subtleText }]}>
                  {patient.stage === 'protocol'
                    ? `Week ${patient.protocolWeek} of 6 · ${patient.carePlan.protocolStatus}`
                    : `Maintenance phase · ${patient.carePlan.protocolStatus}`}
                </Text>
              </View>
              <View style={[styles.stagePill, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                <Text style={[styles.stagePillText, { color: colors.cobalt }]}>
                  {formatDate(latestReadingDate)} reading
                </Text>
              </View>
            </View>

            <View style={[styles.metricGrid, { borderColor: colors.divider }]}>
              <View style={[styles.metricCell, { borderColor: colors.divider }]}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>STARTING</Text>
                <Text style={[styles.weightValue, { color: colors.navy }]}>
                  {patient.startingWeight.toFixed(1)}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
                </Text>
              </View>
              <View style={[styles.metricCell, { borderColor: colors.divider }]}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>CURRENT</Text>
                <Text style={[styles.weightValue, { color: colors.cobalt }]}>
                  {currentWeight.toFixed(1)}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
                </Text>
              </View>
              <View style={[styles.metricCell, { borderColor: colors.divider }]}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>LOST TO DATE</Text>
                <Text style={[styles.weightValue, { color: colors.navy }]}>
                  {weightLoss.toFixed(1)}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
                </Text>
              </View>
              <View style={[styles.metricCell, { borderColor: colors.divider }]}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>TO GOAL</Text>
                <Text style={[styles.weightValue, { color: colors.navy }]}>
                  {poundsToGoal.toFixed(1)}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
                </Text>
              </View>
            </View>

            <View style={{ marginTop: 16 }}>
              <View style={styles.goalRow}>
                <Text style={[styles.goalLabel, { color: colors.bodyText }]}>Goal Completion</Text>
                <Text style={[styles.goalPct, { color: colors.cobalt }]}>{goalProgress.toFixed(0)}%</Text>
              </View>
              <ProgressBar value={goalProgress} style={{ marginTop: 6, height: 10 }} />
              <Text style={[styles.goalDetail, { color: colors.subtleText }]}>
                {percentLoss}% of baseline · Goal reference {patient.goalWeight.toFixed(1)} lbs
              </Text>
            </View>
          </LedgerCard>
        </View>

        {/* Weight history */}
        <View style={styles.section}>
          <LedgerCard>
            <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardTitle, { color: colors.labelText }]}>WEIGHT TREND</Text>
                <Text style={[styles.cardSubtitle, { color: colors.subtleText }]}>Enrollment through latest reading</Text>
              </View>
              <Pressable
                testID="log-weight-btn"
                onPress={openWeightModal}
                style={({ pressed }) => [
                  styles.actionLink,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
              >
                <Feather name="plus-circle" size={13} color={colors.cobalt} />
                <Text style={[styles.actionLinkText, { color: colors.cobalt }]}>Log Entry</Text>
              </Pressable>
            </View>
            <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
              <WeightTrendChart
                history={weightHistory}
                startWeight={patient.startingWeight}
                goalWeight={patient.goalWeight}
              />
            </View>
            <View style={[styles.historyHeader, { backgroundColor: colors.paperCardAlt, borderTopColor: colors.divider, borderBottomColor: colors.divider }]}>
              <Text style={[styles.historyHeaderText, { color: colors.labelText }]}>WEIGH-IN LOG · NEWEST FIRST</Text>
            </View>
            {orderedWeights.map((entry, index) => {
              const fromBaseline = patient.startingWeight - entry.weight;
              const baselineText = Math.abs(fromBaseline) < 0.05
                ? 'Baseline'
                : fromBaseline > 0
                  ? `${fromBaseline.toFixed(1)} lbs lost`
                  : `${Math.abs(fromBaseline).toFixed(1)} lbs above`;
              return (
                <View
                  key={`${entry.date}-${index}`}
                  testID={`weight-history-row-${index}`}
                  style={[styles.historyRow, { borderBottomColor: colors.divider }]}
                >
                  <View style={styles.historyDate}>
                    <Text style={[styles.historyDatePrimary, { color: colors.navy }]}>{formatDate(entry.date, true)}</Text>
                    <Text style={[styles.historyDateSecondary, { color: colors.subtleText }]}>
                      {index === 0 ? 'Latest reading' : baselineText}
                    </Text>
                  </View>
                  <View style={styles.historyNumbers}>
                    <Text style={[styles.historyWeight, { color: colors.navy }]}>{entry.weight.toFixed(1)} lbs</Text>
                    <Text style={[styles.historyToGoal, { color: colors.bodyText }]}>
                      {Math.max(0, entry.weight - patient.goalWeight).toFixed(1)} to goal
                    </Text>
                  </View>
                </View>
              );
            })}
          </LedgerCard>
        </View>

        {/* Care plan */}
        <View style={styles.section}>
          <LedgerCard>
            <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.labelText }]}>CARE PLAN</Text>
              <View style={[styles.stagePill, { backgroundColor: patient.status === 'overdue' ? colors.warnBg : colors.activeBg, borderColor: patient.status === 'overdue' ? colors.warnBorder : colors.activeBorder }]}>
                <Text style={[styles.stagePillText, { color: patient.status === 'overdue' ? colors.warnText : colors.cobalt }]}>
                  {patient.carePlan.protocolStatus}
                </Text>
              </View>
            </View>
            <View style={{ padding: 16 }}>
              <Text style={[styles.planName, { color: colors.navy }]}>{patient.carePlan.name}</Text>
              <Text style={[styles.planFocus, { color: colors.bodyText }]}>{patient.carePlan.focus}</Text>
              <Divider style={{ marginVertical: 14 }} />
              <View style={styles.planGrid}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.detailLabel, { color: colors.labelText }]}>CARE CADENCE</Text>
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>{patient.carePlan.cadence}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.detailLabel, { color: colors.labelText }]}>NEXT ACTION</Text>
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>{patient.carePlan.nextMilestone}</Text>
                </View>
              </View>
            </View>
          </LedgerCard>
        </View>

        {/* Adherence and check-ins */}
        <View style={styles.section}>
          <LedgerCard>
            <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.labelText }]}>ADHERENCE & CHECK-INS</Text>
            </View>
            <View style={styles.adherenceSummary}>
              <View style={[styles.adherenceScore, { borderColor: patient.adherence > 80 ? colors.activeBorder : colors.warnBorder, backgroundColor: patient.adherence > 80 ? colors.activeBg : colors.warnBg }]}>
                <Text style={[styles.adherenceScoreText, { color: patient.adherence > 80 ? colors.cobalt : colors.warnText }]}>
                  {patient.adherence}%
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.adherenceTitle, { color: colors.navy }]}>Routine adherence</Text>
                <Text style={[styles.adherencePattern, { color: colors.bodyText }]}>{patient.adherenceDetail.recentPattern}</Text>
                <Text style={[styles.adherenceRate, { color: colors.subtleText }]}>
                  Check-in completion {patient.adherenceDetail.checkInRate}% · Last {formatDate(patient.adherenceDetail.lastCheckIn)}
                </Text>
              </View>
            </View>
            {patient.checkIns.map((checkIn, index) => (
              <View key={`${checkIn.date}-${index}`} style={[styles.checkInRow, { borderTopColor: colors.divider }]}>
                <View style={styles.checkInMeta}>
                  <View style={[styles.moodPill, { backgroundColor: checkIn.mood === 'needs follow-up' ? colors.warnBg : colors.activeBg, borderColor: checkIn.mood === 'needs follow-up' ? colors.warnBorder : colors.activeBorder }]}>
                    <Text style={[styles.moodText, { color: checkIn.mood === 'needs follow-up' ? colors.warnText : colors.cobalt }]}>
                      {checkIn.mood.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={[styles.checkInDate, { color: colors.subtleText }]}>{formatDate(checkIn.date, true)}</Text>
                </View>
                <Text style={[styles.checkInSummary, { color: colors.bodyText }]}>{checkIn.summary}</Text>
              </View>
            ))}
          </LedgerCard>
        </View>

        {/* Patient details */}
        <View style={styles.section}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Patient Details" />
            <View style={styles.detailGrid}>
              <View style={styles.detailBlock}>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>ENROLLMENT</Text>
                <View style={styles.detailValueRow}>
                  <Feather name="calendar" size={13} color={colors.bodyText} />
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>{formatDate(patient.startDate, true)}</Text>
                </View>
              </View>
              <View style={styles.detailBlock}>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>NEXT CHECK-IN</Text>
                <View style={styles.detailValueRow}>
                  <Feather name="target" size={13} color={colors.bodyText} />
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>{formatDate(patient.nextCheckIn, true)}</Text>
                </View>
              </View>
              <View style={styles.detailBlock}>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>ASSIGNED PROVIDER</Text>
                <View style={styles.detailValueRow}>
                  <Feather name="user" size={13} color={colors.bodyText} />
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>{provider?.name ?? 'Unassigned'}</Text>
                </View>
              </View>
            </View>
          </LedgerCard>
        </View>

        {/* Active protocol products */}
        {products.length > 0 && (
          <View style={styles.section}>
            <LedgerCard>
              <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
                <Text style={[styles.cardTitle, { color: colors.labelText }]}>ACTIVE PROTOCOL</Text>
              </View>
              <View style={{ padding: 16, gap: 10 }}>
                {products.map(product => (
                  <View key={product.id} style={[styles.productRow, { borderColor: colors.divider }]}>
                    <View style={[styles.productThumb, { backgroundColor: colors.accent, borderColor: colors.divider }]}>
                      <Image
                        source={{ uri: product.imageUrl }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="contain"
                        onError={() => {}}
                      />
                    </View>
                    <View>
                      <Text style={[styles.productName, { color: colors.navy }]}>{product.name}</Text>
                      <Text style={[styles.productCat, { color: colors.subtleText }]}>{product.category}</Text>
                    </View>
                  </View>
                ))}
              </View>
            </LedgerCard>
          </View>
        )}

        {/* Clinical activity + notes */}
        <View style={styles.section}>
          <LedgerCard>
            <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.labelText }]}>CLINICAL ACTIVITY</Text>
              <Pressable
                testID="add-note-btn"
                onPress={openNoteModal}
                style={({ pressed }) => [styles.actionLink, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Feather name="file-text" size={13} color={colors.cobalt} />
                <Text style={[styles.actionLinkText, { color: colors.cobalt }]}>Add Note</Text>
              </Pressable>
            </View>
            <View style={[styles.careSummary, { backgroundColor: colors.paperCardAlt, borderColor: colors.divider }]}>
              <Text style={[styles.detailLabel, { color: colors.labelText }]}>CARE SUMMARY</Text>
              {patient.notes.map(note => (
                <View key={note} style={[styles.summaryNote, { borderLeftColor: colors.activeBorder }]}>
                  <Text style={[styles.summaryText, { color: colors.bodyText }]}>{note}</Text>
                </View>
              ))}
            </View>
            {orderedActivity.map(act => (
              <View key={act.id} style={[styles.activityItem, { borderBottomColor: colors.divider }]}>
                {act.type === 'check_in' ? (
                  <Feather name="check-circle" size={15} color={colors.cobalt} />
                ) : act.type === 'fulfillment' ? (
                  <Feather name="truck" size={15} color={colors.subtleText} />
                ) : (
                  <Feather name="file-text" size={15} color={colors.subtleText} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.activityDesc, { color: colors.navy }]}>{act.description}</Text>
                  <Text style={[styles.activityMeta, { color: colors.subtleText }]}>
                    {formatDate(act.date, true)} · {act.user}
                  </Text>
                </View>
              </View>
            ))}
          </LedgerCard>
        </View>

        {/* Subscription card */}
        {subscription && (
          <View style={styles.section}>
            <LedgerCard style={{ padding: 16 }}>
              <View style={styles.subTitleRow}>
                <SectionHeader label="Subscription" />
                <StatusBadge status={subStatus} />
              </View>
              <Text style={[styles.subValue, { color: colors.navy }]}>
                ${subscription.monthlyValue}
                <Text style={[styles.subUnit, { color: colors.subtleText }]}>/mo</Text>
              </Text>
              <Text style={[styles.subCadence, { color: colors.bodyText }]}>
                {subscription.cadence} fulfillment · payment {subscription.paymentStatus}
              </Text>
              <Divider style={{ marginVertical: 12 }} />
              <View style={styles.subMetaRow}>
                <Text style={[styles.subMetaLabel, { color: colors.bodyText }]}>Next Shipment</Text>
                <Text style={[styles.subMetaValue, { color: colors.navy }]}>
                  {new Date(subscription.nextShipment).toLocaleDateString()}
                </Text>
              </View>
              <View style={[styles.shipmentHistory, { borderColor: colors.divider, backgroundColor: colors.paperCardAlt }]}>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>RECENT SHIPMENTS</Text>
                {subscription.shipmentHistory
                  .slice()
                  .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                  .map((shipment, index) => (
                    <View key={`${shipment.date}-${index}`} style={styles.shipmentRow}>
                      <View style={styles.shipmentStatus}>
                        <Feather name="package" size={13} color={colors.cobalt} />
                        <Text style={[styles.shipmentStatusText, { color: colors.navyLight }]}>{shipment.status}</Text>
                      </View>
                      <Text style={[styles.shipmentDate, { color: colors.subtleText }]}>{formatDate(shipment.date, true)}</Text>
                    </View>
                  ))}
              </View>
              <Pressable
                testID="manage-subscription-btn"
                onPress={openSubModal}
                style={({ pressed }) => [
                  styles.manageBtn,
                  { backgroundColor: colors.cobalt },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.manageBtnText, { color: colors.primaryForeground }]}>Manage Subscription</Text>
              </Pressable>
            </LedgerCard>
          </View>
        )}

        <SyntheticDisclaimer />
      </KeyboardAwareScrollViewCompat>

      {/* ── Edit Contact Modal ── */}
      <Modal visible={editOpen} animationType={modalAnimation} presentationStyle="formSheet" onRequestClose={() => setEditOpen(false)}>
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable
              testID="edit-cancel-btn"
              accessibilityRole="button"
              hitSlop={8}
              onPressIn={() => setEditOpen(false)}
              onPress={() => setEditOpen(false)}
              style={styles.modalHeaderAction}
            >
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Edit Contact</Text>
            <Pressable testID="edit-save-btn" onPress={saveContact} style={[styles.modalHeaderAction, styles.modalHeaderActionEnd]}>
              <Text style={[styles.modalSave, { color: colors.cobalt }]}>Save</Text>
            </Pressable>
          </View>
          <KeyboardAwareScrollViewCompat style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }} bottomOffset={20}>
            <Text style={[styles.fieldLabel, { color: colors.labelText }]}>EMAIL</Text>
            <TextInput
              testID="edit-email-input"
              value={editEmail}
              onChangeText={t => { setEditEmail(t); setEmailError(''); }}
              keyboardType="email-address"
              autoCapitalize="none"
              style={[styles.fieldInput, { borderColor: emailError ? colors.riskText : colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              placeholderTextColor={colors.subtleText}
            />
            {emailError ? <Text style={[styles.fieldError, { color: colors.riskText }]}>{emailError}</Text> : null}
            <Text style={[styles.fieldLabel, { color: colors.labelText, marginTop: 16 }]}>PHONE</Text>
            <TextInput
              testID="edit-phone-input"
              value={editPhone}
              onChangeText={setEditPhone}
              keyboardType="phone-pad"
              style={[styles.fieldInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
              placeholderTextColor={colors.subtleText}
            />
          </KeyboardAwareScrollViewCompat>
        </View>
      </Modal>

      {/* ── Log Weight Modal ── */}
      <Modal visible={weightModalOpen} animationType={modalAnimation} presentationStyle="formSheet" onRequestClose={() => setWeightModalOpen(false)}>
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable
              testID="weight-cancel-btn"
              accessibilityRole="button"
              hitSlop={8}
              onPressIn={() => setWeightModalOpen(false)}
              onPress={() => setWeightModalOpen(false)}
              style={styles.modalHeaderAction}
            >
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Log Weight Entry</Text>
            <Pressable testID="weight-save-btn" onPress={saveWeight} disabled={weightSaved} style={[styles.modalHeaderAction, styles.modalHeaderActionEnd]}>
              <Text style={[styles.modalSave, { color: weightSaved ? colors.subtleText : colors.cobalt }]}>
                {weightSaved ? 'Saved' : 'Save'}
              </Text>
            </Pressable>
          </View>
          <View style={{ padding: 20 }}>
            <Text style={[styles.fieldLabel, { color: colors.labelText }]}>CURRENT WEIGHT (LBS)</Text>
            <TextInput
              testID="weight-input"
              value={weightDraft}
              onChangeText={t => { setWeightDraft(t); setWeightError(''); }}
              keyboardType="decimal-pad"
              style={[styles.fieldInput, { borderColor: weightError ? colors.riskText : colors.border, color: colors.foreground, backgroundColor: colors.card, fontSize: 22, fontFamily: 'Inter_600SemiBold' }]}
            />
            {weightError ? <Text style={[styles.fieldError, { color: colors.riskText }]}>{weightError}</Text> : null}
            {weightSaved && <Text style={[styles.fieldSuccess, { color: colors.cobalt }]}>Weight entry saved successfully.</Text>}
          </View>
        </View>
      </Modal>

      {/* ── Add Note Modal ── */}
      <Modal visible={noteModalOpen} animationType={modalAnimation} presentationStyle="formSheet" onRequestClose={() => setNoteModalOpen(false)}>
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable
              testID="note-cancel-btn"
              accessibilityRole="button"
              hitSlop={8}
              onPressIn={() => setNoteModalOpen(false)}
              onPress={() => setNoteModalOpen(false)}
              style={styles.modalHeaderAction}
            >
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Add Clinical Note</Text>
            <Pressable testID="note-save-btn" onPress={saveNote} disabled={noteSaved} style={[styles.modalHeaderAction, styles.modalHeaderActionEnd]}>
              <Text style={[styles.modalSave, { color: noteSaved ? colors.subtleText : colors.cobalt }]}>
                {noteSaved ? 'Saved' : 'Save'}
              </Text>
            </Pressable>
          </View>
          <KeyboardAwareScrollViewCompat style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }} bottomOffset={20}>
            <Text style={[styles.fieldLabel, { color: colors.labelText }]}>NOTE</Text>
            <TextInput
              testID="note-input"
              value={noteDraft}
              onChangeText={setNoteDraft}
              multiline
              numberOfLines={6}
              placeholder="Add a concise internal note..."
              placeholderTextColor={colors.subtleText}
              style={[styles.textArea, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.card }]}
            />
            {noteSaved && <Text style={[styles.fieldSuccess, { color: colors.cobalt }]}>Note saved successfully.</Text>}
          </KeyboardAwareScrollViewCompat>
        </View>
      </Modal>

      {/* ── Subscription Status Modal ── */}
      <Modal visible={subModalOpen} animationType={modalAnimation} presentationStyle="formSheet" onRequestClose={() => setSubModalOpen(false)}>
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable
              testID="sub-cancel-btn"
              accessibilityRole="button"
              hitSlop={8}
              onPressIn={() => setSubModalOpen(false)}
              onPress={() => setSubModalOpen(false)}
              style={styles.modalHeaderAction}
            >
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Manage Subscription</Text>
            <Pressable testID="sub-save-btn" onPress={saveSubStatus} style={[styles.modalHeaderAction, styles.modalHeaderActionEnd]}>
              <Text style={[styles.modalSave, { color: colors.cobalt }]}>Save</Text>
            </Pressable>
          </View>
          <View style={{ padding: 20 }}>
            <Text style={[styles.fieldLabel, { color: colors.labelText }]}>DELIVERY STATUS</Text>
            <View style={{ marginTop: 12, gap: 8 }}>
              {SUB_STATUS_OPTIONS.map(status => {
                const selected = subStatusDraft === status;
                return (
                  <Pressable
                    key={status}
                    testID={`sub-status-option-${status}`}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setSubStatusDraft(status);
                    }}
                    style={({ pressed }) => [
                      styles.subOption,
                      {
                        borderColor: selected ? colors.cobalt : colors.border,
                        backgroundColor: selected ? colors.activeBg : pressed ? colors.accent : colors.card,
                      },
                    ]}
                  >
                    <StatusBadge status={status} />
                    {selected && <Feather name="check" size={14} color={colors.cobalt} />}
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerBtn: {
    width: 34,
    height: 34,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 16,
    fontFamily: fonts.serifBold,
    textAlign: 'center',
  },
  identityBlock: {
    flexDirection: 'row',
    padding: 16,
    gap: 14,
    borderBottomWidth: 1,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: theme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  patientName: {
    fontSize: 20,
    fontFamily: fonts.serifBold,
    letterSpacing: -0.2,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  contactText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    flexShrink: 1,
  },
  recordId: {
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.8,
    marginTop: 8,
    lineHeight: 13,
  },
  section: {
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  progressTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 16,
    gap: 8,
  },
  sectionIntro: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    lineHeight: 15,
    marginTop: 4,
  },
  stagePill: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: '48%',
  },
  stagePillText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    textAlign: 'center',
  },
  metricGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderTopWidth: 1,
    borderLeftWidth: 1,
  },
  metricCell: {
    width: '50%',
    padding: 12,
    borderRightWidth: 1,
    borderBottomWidth: 1,
  },
  weightLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  weightValue: {
    fontSize: 22,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.5,
  },
  weightUnit: {
    fontSize: 13,
    fontWeight: '400',
    fontFamily: 'Inter_400Regular',
  },
  goalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  goalLabel: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
  },
  goalPct: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  goalDetail: {
    fontSize: 10,
    textAlign: 'right',
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  cardTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  cardSubtitle: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
  },
  actionLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  actionLinkText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  historyHeader: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  historyHeaderText: {
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: 1,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  historyDate: {
    flex: 1,
  },
  historyDatePrimary: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  historyDateSecondary: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    marginTop: 3,
  },
  historyNumbers: {
    alignItems: 'flex-end',
  },
  historyWeight: {
    fontSize: 13,
    fontFamily: 'Inter_700Bold',
  },
  historyToGoal: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
    marginTop: 3,
  },
  planName: {
    fontSize: 16,
    fontFamily: fonts.serif,
  },
  planFocus: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    marginTop: 5,
  },
  planGrid: {
    flexDirection: 'row',
    gap: 16,
  },
  adherenceSummary: {
    flexDirection: 'row',
    padding: 16,
    gap: 12,
    alignItems: 'center',
  },
  adherenceScore: {
    width: 52,
    height: 52,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  adherenceScoreText: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  adherenceTitle: {
    fontSize: 14,
    fontFamily: fonts.serif,
  },
  adherencePattern: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: 'Inter_400Regular',
    marginTop: 3,
  },
  adherenceRate: {
    fontSize: 9,
    lineHeight: 14,
    fontFamily: 'Inter_400Regular',
    marginTop: 5,
  },
  checkInRow: {
    padding: 14,
    borderTopWidth: 1,
  },
  checkInMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  moodPill: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  moodText: {
    fontSize: 8,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.5,
  },
  checkInDate: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
  },
  checkInSummary: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: 'Inter_400Regular',
    marginTop: 8,
  },
  detailLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  detailValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  detailValue: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
    lineHeight: 18,
    flexShrink: 1,
  },
  detailGrid: {
    marginTop: 12,
    gap: 14,
  },
  detailBlock: {
    flex: 1,
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
  },
  productThumb: {
    width: 48,
    height: 48,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    overflow: 'hidden',
  },
  productName: {
    fontSize: 14,
    fontFamily: fonts.serif,
  },
  productCat: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
    textTransform: 'capitalize',
  },
  careSummary: {
    margin: 14,
    padding: 12,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
  },
  summaryNote: {
    borderLeftWidth: 2,
    paddingLeft: 10,
    marginTop: 8,
  },
  summaryText: {
    fontSize: 11,
    lineHeight: 17,
    fontFamily: 'Inter_400Regular',
  },
  activityItem: {
    flexDirection: 'row',
    gap: 12,
    padding: 14,
    borderBottomWidth: 1,
    alignItems: 'flex-start',
  },
  activityDesc: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    lineHeight: 18,
  },
  activityMeta: {
    fontSize: 10,
    marginTop: 4,
    fontFamily: 'Inter_400Regular',
  },
  subTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  subValue: {
    fontSize: 28,
    fontFamily: fonts.serif,
    letterSpacing: -0.4,
    marginTop: 8,
  },
  subUnit: {
    fontSize: 13,
    fontWeight: '400',
    fontFamily: 'Inter_400Regular',
  },
  subCadence: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    marginTop: 4,
    textTransform: 'capitalize',
  },
  subMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  subMetaLabel: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  subMetaValue: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  shipmentHistory: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    padding: 12,
    marginTop: 12,
  },
  shipmentRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  shipmentStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  shipmentStatusText: {
    fontSize: 11,
    textTransform: 'capitalize',
    fontFamily: 'Inter_600SemiBold',
  },
  shipmentDate: {
    fontSize: 9,
    fontFamily: 'Inter_400Regular',
  },
  manageBtn: {
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 12,
  },
  manageBtnText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  // Modals
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  modalHeaderAction: {
    minWidth: 60,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  modalHeaderActionEnd: {
    alignItems: 'flex-end',
  },
  modalCancel: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: fonts.serifBold,
  },
  modalSave: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  fieldLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginBottom: 8,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  fieldError: {
    fontSize: 11,
    marginTop: 6,
    fontFamily: 'Inter_400Regular',
  },
  fieldSuccess: {
    fontSize: 11,
    marginTop: 8,
    fontFamily: 'Inter_600SemiBold',
  },
  textArea: {
    borderWidth: 1,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    minHeight: 120,
    textAlignVertical: 'top',
  },
  subOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderWidth: 1,
    borderRadius: theme.radiusSm,
  },
});
