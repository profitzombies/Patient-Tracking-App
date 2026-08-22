import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useColors } from '@/hooks/useColors';
import { Divider, LedgerCard, ProgressBar, SectionHeader, StatusBadge } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { MOCK_PRODUCTS, MOCK_PROVIDERS } from '@/data/mock-data';
import { useOperations } from '@/context/OperationsContext';

function WeightBarChart({ history, startWeight, goalWeight }: {
  history: { date: string; weight: number }[];
  startWeight: number;
  goalWeight: number;
}) {
  const colors = useColors();
  const range = startWeight - goalWeight;

  return (
    <View style={{ height: 100, flexDirection: 'row', alignItems: 'flex-end', gap: 4 }}>
      {history.map((entry, idx) => {
        const h = ((entry.weight - goalWeight) / range) * 100;
        const clipped = Math.max(8, Math.min(98, h));
        return (
          <View key={`${entry.date}-${idx}`} style={{ flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center' }}>
            <Text style={{ fontSize: 8, color: colors.subtleText, marginBottom: 2, fontFamily: 'Inter_400Regular' }}>
              {entry.weight}
            </Text>
            <View style={{ width: '80%', height: `${clipped}%`, backgroundColor: colors.cobalt }} />
            <Text
              style={{ fontSize: 8, color: colors.subtleText, marginTop: 3, fontFamily: 'Inter_400Regular' }}
              numberOfLines={1}
            >
              {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </Text>
          </View>
        );
      })}
    </View>
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

  // Guard: don't render interactive content before hydration to avoid acting on default state
  if (!ops.hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View style={[styles.header, { paddingTop: topPad + 8, backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border }]}>
          <Pressable testID="patient-back-btn" onPress={() => router.back()}
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
        <Pressable onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: colors.cobalt, fontSize: 14, fontFamily: 'Inter_600SemiBold' }}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // Merged patient already carries contact overrides and latest weight
  const contact = { email: patient.email, phone: patient.phone };
  const weightHistory = patient.progressHistory;
  const localNotes = ops.getPatientNotes(patient.id);
  // Merged subscription already carries status override
  const subStatus = subscription?.status ?? 'active';

  const currentWeight = weightHistory.at(-1)?.weight ?? patient.currentWeight;
  const weightLoss = patient.startingWeight - currentWeight;
  const percentLoss = ((weightLoss / patient.startingWeight) * 100).toFixed(1);
  const goalProgress = Math.min(100, Math.max(0, (weightLoss / (patient.startingWeight - patient.goalWeight)) * 100));

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
            router.back();
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
        <View style={[styles.identityBlock, { borderBottomColor: colors.border }]}>
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
          </View>
        </View>

        {/* Protocol progress */}
        <View style={styles.section}>
          <LedgerCard style={{ padding: 16 }}>
            <View style={styles.progressTitleRow}>
              <SectionHeader label="Protocol Progress" />
              <View style={[styles.stagePill, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                <Text style={[styles.stagePillText, { color: colors.cobalt }]}>
                  {patient.stage === 'protocol' ? `Wk ${patient.protocolWeek} of 6` : 'Maintenance Phase'}
                </Text>
              </View>
            </View>

            <View style={styles.weightRow}>
              <View style={styles.weightCell}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>STARTING</Text>
                <Text style={[styles.weightValue, { color: colors.navy }]}>
                  {patient.startingWeight}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
                </Text>
              </View>
              <View style={[styles.weightCell, { borderLeftWidth: 1, borderLeftColor: colors.divider, paddingLeft: 16 }]}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>CURRENT</Text>
                <Text style={[styles.weightValue, { color: colors.cobalt }]}>
                  {currentWeight.toFixed(1)}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
                </Text>
              </View>
              <View style={[styles.weightCell, { borderLeftWidth: 1, borderLeftColor: colors.divider, paddingLeft: 16 }]}>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>GOAL</Text>
                <Text style={[styles.weightValue, { color: colors.navy }]}>
                  {patient.goalWeight}<Text style={[styles.weightUnit, { color: colors.subtleText }]}> lbs</Text>
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
                Total loss: {weightLoss.toFixed(1)} lbs ({percentLoss}%)
              </Text>
            </View>
          </LedgerCard>
        </View>

        {/* Weight history */}
        <View style={styles.section}>
          <LedgerCard>
            <View style={[styles.cardTitleRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.cardTitle, { color: colors.labelText }]}>WEIGHT HISTORY</Text>
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
            <View style={{ padding: 16 }}>
              <WeightBarChart
                history={weightHistory}
                startWeight={patient.startingWeight}
                goalWeight={patient.goalWeight}
              />
            </View>
          </LedgerCard>
        </View>

        {/* Patient details sidebar info */}
        <View style={styles.section}>
          <LedgerCard style={{ padding: 16 }}>
            <SectionHeader label="Patient Details" />
            <View style={{ marginTop: 12, gap: 12 }}>
              <View>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>START DATE</Text>
                <View style={styles.detailValueRow}>
                  <Feather name="calendar" size={13} color={colors.bodyText} />
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>
                    {new Date(patient.startDate).toLocaleDateString()}
                  </Text>
                </View>
              </View>
              <View>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>ADHERENCE SCORE</Text>
                <View style={styles.detailValueRow}>
                  <Feather name="activity" size={13} color={patient.adherence > 80 ? colors.cobalt : colors.warnText} />
                  <Text style={[styles.detailValue, { color: patient.adherence > 80 ? colors.navyLight : colors.warnText }]}>
                    {patient.adherence}/100
                  </Text>
                </View>
              </View>
              <View>
                <Text style={[styles.detailLabel, { color: colors.labelText }]}>NEXT CHECK-IN</Text>
                <View style={styles.detailValueRow}>
                  <Feather name="target" size={13} color={colors.bodyText} />
                  <Text style={[styles.detailValue, { color: colors.navyLight }]}>
                    {new Date(patient.nextCheckIn).toLocaleDateString()}
                  </Text>
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
            {/* Persisted local notes first */}
            {localNotes.map(note => (
              <View key={note.id} style={[styles.activityItem, { borderBottomColor: colors.divider }]}>
                <Feather name="file-text" size={15} color={colors.subtleText} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.activityDesc, { color: colors.navy }]}>{note.text}</Text>
                  <Text style={[styles.activityMeta, { color: colors.subtleText }]}>
                    {new Date(note.date).toLocaleDateString()} · {note.user}
                  </Text>
                </View>
              </View>
            ))}
            {patient.activity.map(act => (
              <View key={act.id} style={[styles.activityItem, { borderBottomColor: colors.divider }]}>
                {act.type === 'check_in' ? (
                  <Feather name="check-circle" size={15} color={colors.cobalt} />
                ) : (
                  <Feather name="file-text" size={15} color={colors.subtleText} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.activityDesc, { color: colors.navy }]}>{act.description}</Text>
                  <Text style={[styles.activityMeta, { color: colors.subtleText }]}>
                    {new Date(act.date).toLocaleDateString()} · {act.user}
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
                {subscription.cadence} fulfillment
              </Text>
              <Divider style={{ marginVertical: 12 }} />
              <View style={styles.subMetaRow}>
                <Text style={[styles.subMetaLabel, { color: colors.bodyText }]}>Next Shipment</Text>
                <Text style={[styles.subMetaValue, { color: colors.navy }]}>
                  {new Date(subscription.nextShipment).toLocaleDateString()}
                </Text>
              </View>
              <Pressable
                testID="manage-subscription-btn"
                onPress={openSubModal}
                style={({ pressed }) => [
                  styles.manageBtn,
                  { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                ]}
              >
                <Text style={[styles.manageBtnText, { color: colors.cobalt }]}>Manage Subscription</Text>
              </Pressable>
            </LedgerCard>
          </View>
        )}

        <SyntheticDisclaimer />
      </KeyboardAwareScrollViewCompat>

      {/* ── Edit Contact Modal ── */}
      <Modal visible={editOpen} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable testID="edit-cancel-btn" onPress={() => setEditOpen(false)}>
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Edit Contact</Text>
            <Pressable testID="edit-save-btn" onPress={saveContact}>
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
      <Modal visible={weightModalOpen} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable testID="weight-cancel-btn" onPress={() => setWeightModalOpen(false)}>
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Log Weight Entry</Text>
            <Pressable testID="weight-save-btn" onPress={saveWeight} disabled={weightSaved}>
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
      <Modal visible={noteModalOpen} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable testID="note-cancel-btn" onPress={() => setNoteModalOpen(false)}>
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Add Clinical Note</Text>
            <Pressable testID="note-save-btn" onPress={saveNote} disabled={noteSaved}>
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
      <Modal visible={subModalOpen} animationType="slide" presentationStyle="formSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border, paddingTop: insets.top + 16 }]}>
            <Pressable testID="sub-cancel-btn" onPress={() => setSubModalOpen(false)}>
              <Text style={[styles.modalCancel, { color: colors.bodyText }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.modalTitle, { color: colors.navy }]}>Manage Subscription</Text>
            <Pressable testID="sub-save-btn" onPress={saveSubStatus}>
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
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
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.4,
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
  },
  stagePill: {
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  stagePillText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  weightRow: {
    flexDirection: 'row',
    gap: 0,
  },
  weightCell: {
    flex: 1,
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
  },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderWidth: 1,
  },
  productThumb: {
    width: 48,
    height: 48,
    borderWidth: 1,
    overflow: 'hidden',
  },
  productName: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  productCat: {
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
    textTransform: 'capitalize',
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
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: -0.8,
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
  manageBtn: {
    borderWidth: 1,
    paddingVertical: 10,
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
  modalCancel: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
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
  },
});
