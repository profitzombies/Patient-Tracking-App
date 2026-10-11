/**
 * Account → Medications: the patient's own medication list with add, edit,
 * and stop. Each record drives its own device reminders (name + dose in the
 * alert, daily times or a weekly day) and the office's adherence view, so
 * this is the one place a patient shapes what they are reminded about.
 * Real accounts only.
 */
import React, { useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { ErrorBox, FieldLabel, GhostButton, LedgerInput, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { usePatient } from '@/context/PatientContext';
import { newUuid } from '@/lib/uuid';
import {
  describeSchedule,
  formatClockTime,
  isDateKey,
  MEDICATION_FORM_LABELS,
  MEDICATION_FORMS,
  medicationLine,
  parseClockLabel,
  WEEKDAY_LABELS,
  type MedicationForm,
  type MedicationRecord,
  type MedicationScheduleKind,
} from '@/lib/medication-schedule';

interface Draft {
  id: string | null;
  name: string;
  form: MedicationForm;
  dose: string;
  scheduleKind: MedicationScheduleKind;
  /** Clock labels as typed ("8:00 AM"); parsed to HH:MM on save. */
  times: string[];
  weekday: number | null;
  notes: string;
  startDate: string;
  stopDate: string;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function emptyDraft(todayKey: string): Draft {
  return {
    id: null,
    name: '',
    form: 'tablet',
    dose: '',
    scheduleKind: 'daily',
    times: ['8:00 AM'],
    weekday: null,
    notes: '',
    startDate: todayKey,
    stopDate: '',
  };
}

function draftOf(medication: MedicationRecord): Draft {
  return {
    id: medication.id,
    name: medication.name,
    form: medication.form,
    dose: medication.dose ?? '',
    scheduleKind: medication.scheduleKind,
    times: medication.times.map(formatClockTime),
    weekday: medication.weekday,
    notes: medication.notes ?? '',
    startDate: medication.startDate,
    stopDate: medication.stopDate ?? '',
  };
}

export function MedicationsSection() {
  const colors = useColors();
  const patient = usePatient();
  const todayKey = patient.todayKey;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { active, stopped } = useMemo(() => {
    const sorted = [...patient.medications].sort((a, b) => a.name.localeCompare(b.name));
    // A record stopped today still gets today's doses, but the patient just
    // asked to stop it, so it lists under STOPPED right away.
    const isStopped = (m: MedicationRecord) => m.stopDate !== null && m.stopDate <= todayKey;
    return {
      active: sorted.filter(m => !isStopped(m)),
      stopped: sorted.filter(isStopped),
    };
  }, [patient.medications, todayKey]);

  const openNew = () => { setError(null); setDraft(emptyDraft(todayKey)); };
  const openEdit = (medication: MedicationRecord) => { setError(null); setDraft(draftOf(medication)); };
  const close = () => { setDraft(null); setError(null); };

  const save = async () => {
    if (!draft) return;
    const times: string[] = [];
    for (const label of draft.times) {
      const clock = parseClockLabel(label);
      if (!clock) { setError(`"${label}" isn't a time. Use a form like 8:00 AM.`); return; }
      times.push(clock);
    }
    if (draft.stopDate && !isDateKey(draft.stopDate)) { setError('Stop date must look like 2026-09-30.'); return; }
    if (!isDateKey(draft.startDate)) { setError('Start date must look like 2026-09-01.'); return; }
    setBusy(true);
    setError(null);
    const result = await patient.saveMedication({
      id: draft.id ?? newUuid(),
      name: draft.name,
      form: draft.form,
      dose: draft.dose.trim() || null,
      scheduleKind: draft.scheduleKind,
      times,
      weekday: draft.scheduleKind === 'weekly' ? draft.weekday : null,
      notes: draft.notes.trim() || null,
      startDate: draft.startDate,
      stopDate: draft.stopDate || null,
    });
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    AccessibilityInfo.announceForAccessibility(`${result.medication.name} saved.`);
    close();
  };

  const stop = async (medication: MedicationRecord) => {
    setBusy(true);
    setError(null);
    const stopDate = medication.startDate > todayKey ? medication.startDate : todayKey;
    const result = await patient.saveMedication({
      id: medication.id,
      name: medication.name,
      form: medication.form,
      dose: medication.dose,
      scheduleKind: medication.scheduleKind,
      times: medication.times,
      weekday: medication.weekday,
      notes: medication.notes,
      startDate: medication.startDate,
      stopDate,
    });
    setBusy(false);
    if ('error' in result) { setError(result.error); return; }
    AccessibilityInfo.announceForAccessibility(`${medication.name} stopped. Its reminders are cancelled.`);
  };

  const renderRow = (medication: MedicationRecord, isStopped: boolean) => (
    <View key={medication.id} testID={`medication-row-${medication.id}`} style={[styles.row, { borderTopColor: colors.border }]}>
      <View style={styles.rowInfo}>
        <Text style={[styles.rowName, { color: isStopped ? colors.subtleText : colors.navy }]}>{medicationLine(medication)}</Text>
        <Text style={[styles.rowMeta, { color: colors.bodyText }]}>
          {MEDICATION_FORM_LABELS[medication.form]} · {describeSchedule(medication)}
        </Text>
        <Text style={[styles.rowMeta, { color: colors.subtleText }]}>
          {isStopped
            ? medication.stopDate === todayKey ? 'Stopped today · last doses today' : `Stopped ${medication.stopDate}`
            : medication.startDate > todayKey
              ? `Starts ${medication.startDate}`
              : medication.stopDate
                ? `Through ${medication.stopDate}`
                : `Since ${medication.startDate}`}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <Pressable
          testID={`medication-edit-${medication.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${medication.name}`}
          onPress={() => openEdit(medication)}
          hitSlop={8}
          style={styles.iconBtn}
        >
          <Feather name="edit-2" size={16} color={colors.cobalt} />
        </Pressable>
        {!isStopped ? (
          <Pressable
            testID={`medication-stop-${medication.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${medication.name}`}
            disabled={busy}
            onPress={() => void stop(medication)}
            hitSlop={8}
            style={styles.iconBtn}
          >
            <Feather name="x-circle" size={16} color={colors.destructive} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <>
      <Text style={[styles.section, { color: colors.labelText }]}>MEDICATIONS</Text>
      <LedgerCard testID="account-medications" style={styles.card}>
        <Text style={[styles.body, { color: colors.bodyText }]}>
          Each medication here gets its own reminder with the name and dose, and your care team sees what was taken.
        </Text>
        {active.length === 0 && stopped.length === 0 ? (
          <Text testID="account-medications-empty" style={[styles.body, styles.gap, { color: colors.subtleText }]}>
            No medications yet.
          </Text>
        ) : null}
        {active.map(m => renderRow(m, false))}
        {stopped.length > 0 ? (
          <>
            <Text style={[styles.subLabel, { color: colors.labelText }]}>STOPPED</Text>
            {stopped.map(m => renderRow(m, true))}
          </>
        ) : null}
        {error && !draft ? <View style={styles.gap}><ErrorBox testID="account-medications-error" message={error} /></View> : null}
        {!draft ? (
          <PrimaryButton testID="account-medication-add" label="Add a medication" disabled={busy} onPress={openNew} style={styles.gap} />
        ) : null}

        {draft ? (
          <View testID="medication-form" style={[styles.form, { borderTopColor: colors.border }]}>
            <Text style={[styles.formTitle, { color: colors.navy }]}>{draft.id ? 'Edit medication' : 'New medication'}</Text>
            <FieldLabel text="Name" />
            <LedgerInput
              testID="medication-name"
              value={draft.name}
              onChangeText={name => setDraft({ ...draft, name })}
              placeholder="Semaglutide"
              autoCapitalize="words"
            />
            <View style={styles.gap}>
              <FieldLabel text="Form" />
              <View style={styles.chipWrap}>
                {MEDICATION_FORMS.map(form => {
                  const selected = draft.form === form;
                  return (
                    <Pressable
                      key={form}
                      testID={`medication-form-${form}`}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => setDraft({ ...draft, form })}
                      style={[styles.chip, { borderColor: selected ? colors.cobalt : colors.border, backgroundColor: selected ? colors.cobalt : colors.card, borderRadius: colors.radiusSm }]}
                    >
                      <Text style={[styles.chipText, { color: selected ? colors.paperCardAlt : colors.navy }]}>{MEDICATION_FORM_LABELS[form]}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.gap}>
              <FieldLabel text="Dose (optional)" />
              <LedgerInput testID="medication-dose" value={draft.dose} onChangeText={dose => setDraft({ ...draft, dose })} placeholder="0.5 mg" />
            </View>
            <View style={styles.gap}>
              <FieldLabel text="Schedule" />
              <PillSelector<MedicationScheduleKind>
                options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }]}
                selected={draft.scheduleKind}
                onSelect={scheduleKind => setDraft({ ...draft, scheduleKind, times: scheduleKind === 'weekly' ? draft.times.slice(0, 1) : draft.times })}
              />
            </View>
            {draft.scheduleKind === 'weekly' ? (
              <View style={styles.gap}>
                <FieldLabel text="Day of the week" />
                <View style={styles.chipWrap}>
                  {WEEKDAY_SHORT.map((label, weekday) => {
                    const selected = draft.weekday === weekday;
                    return (
                      <Pressable
                        key={label}
                        testID={`medication-weekday-${weekday}`}
                        accessibilityRole="button"
                        accessibilityLabel={WEEKDAY_LABELS[weekday]}
                        accessibilityState={{ selected }}
                        onPress={() => setDraft({ ...draft, weekday })}
                        style={[styles.chip, { borderColor: selected ? colors.cobalt : colors.border, backgroundColor: selected ? colors.cobalt : colors.card, borderRadius: colors.radiusSm }]}
                      >
                        <Text style={[styles.chipText, { color: selected ? colors.paperCardAlt : colors.navy }]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : null}
            <View style={styles.gap}>
              <FieldLabel text={draft.scheduleKind === 'weekly' ? 'Reminder time' : 'Reminder times'} />
              {draft.times.map((label, index) => (
                <View key={index} style={styles.timeRow}>
                  <LedgerInput
                    testID={`medication-time-${index}`}
                    value={label}
                    onChangeText={value => setDraft({ ...draft, times: draft.times.map((t, i) => (i === index ? value : t)) })}
                    placeholder="8:00 AM"
                    autoCapitalize="characters"
                    style={styles.timeInput}
                  />
                  {draft.times.length > 1 ? (
                    <Pressable
                      testID={`medication-time-remove-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove time ${label}`}
                      onPress={() => setDraft({ ...draft, times: draft.times.filter((_, i) => i !== index) })}
                      hitSlop={8}
                      style={styles.iconBtn}
                    >
                      <Feather name="minus-circle" size={18} color={colors.destructive} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
              {draft.scheduleKind === 'daily' && draft.times.length < 6 ? (
                <GhostButton
                  testID="medication-time-add"
                  label="Add another time"
                  onPress={() => setDraft({ ...draft, times: [...draft.times, '3:00 PM'] })}
                  style={styles.smallGap}
                />
              ) : null}
            </View>
            <View style={styles.dateRow}>
              <View style={styles.dateItem}>
                <FieldLabel text="Start date" />
                <LedgerInput testID="medication-start" value={draft.startDate} onChangeText={startDate => setDraft({ ...draft, startDate })} placeholder="2026-09-01" autoCapitalize="none" />
              </View>
              <View style={styles.dateItem}>
                <FieldLabel text="Stop date" />
                <LedgerInput testID="medication-stop-date" value={draft.stopDate} onChangeText={stopDate => setDraft({ ...draft, stopDate })} placeholder="Optional" autoCapitalize="none" />
              </View>
            </View>
            <View style={styles.gap}>
              <FieldLabel text="Notes (optional)" />
              <LedgerInput testID="medication-notes" value={draft.notes} onChangeText={notes => setDraft({ ...draft, notes })} placeholder="With food, rotate injection site…" multiline />
            </View>
            {error ? <View style={styles.gap}><ErrorBox testID="medication-form-error" message={error} /></View> : null}
            <PrimaryButton testID="medication-save" label={busy ? 'Saving…' : 'Save medication'} disabled={busy} onPress={() => void save()} style={styles.gap} />
            <GhostButton testID="medication-cancel" label="Cancel" disabled={busy} onPress={close} style={styles.smallGap} />
          </View>
        ) : null}
      </LedgerCard>
    </>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginTop: 20, marginBottom: 8 },
  card: { padding: 16 },
  body: { fontSize: 14, lineHeight: 21, fontFamily: 'Inter_400Regular' },
  subLabel: { fontSize: 10, letterSpacing: 1.4, fontFamily: 'Inter_700Bold', marginTop: 14 },
  gap: { marginTop: 14 },
  smallGap: { marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    marginTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowInfo: { flex: 1, gap: 2 },
  rowName: { fontSize: 14.5, fontFamily: 'Inter_600SemiBold' },
  rowMeta: { fontSize: 12, lineHeight: 17, fontFamily: 'Inter_400Regular' },
  rowActions: { flexDirection: 'row', gap: 4 },
  iconBtn: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
  form: { marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  formTitle: { fontSize: 16, fontFamily: 'Inter_700Bold', marginBottom: 10 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, minHeight: 40, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: 12.5, fontFamily: 'Inter_600SemiBold' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  timeInput: { flex: 1 },
  dateRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
  dateItem: { flex: 1 },
});
