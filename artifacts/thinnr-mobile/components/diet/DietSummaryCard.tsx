/**
 * The diet block at the top of Food preferences: the plan in force (or the
 * protocol while it locks the picker), the phase, the special-diet settings
 * (eating window / Whole30 day one), the pending-review notice, the activity
 * level with an inline change, and the "Change diet" door.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { DIET_BY_SLUG, OVERSIGHT_NOTE_TEXT, PROTOCOL_LENGTH_DAYS, type ActivityLevel } from '@/lib/diet-fit';
import { formatClock, whole30Status, type DietState } from '@/lib/diet-state';
import { formatDateKey } from '@/data/patient-data';
import { COMPLEXITY_LABELS } from './DietCardList';
import { ACTIVITY_SHORT_LABELS, ActivityLevelPicker, SectionLabel } from './DietChoiceFields';
import { ReviewCard } from './DietPicker';

export function phaseLabel(diet: DietState): string {
  if (diet.phase.phase === 'protocol') return `THINNR protocol · day ${diet.phase.programDay} of ${PROTOCOL_LENGTH_DAYS}`;
  if (diet.programId === 'thinnr') return `THINNR maintenance · day ${diet.phase.maintenanceDay}`;
  if (diet.programId === 'glp1') return 'GLP-1 program';
  return 'Tracking';
}

export function DietSummaryCard({ diet, onChangeDiet }: { diet: DietState; onChangeDiet: () => void }) {
  const colors = useColors();
  const patient = usePatient();
  const [editingActivity, setEditingActivity] = useState(false);
  const [savingActivity, setSavingActivity] = useState(false);
  const locked = diet.phase.dietPickerLocked;
  const entry = diet.currentDiet ? DIET_BY_SLUG.get(diet.currentDiet.dietSlug) ?? null : null;
  const settings = diet.currentDiet?.settings ?? {};
  const w30 = settings.whole30StartDate ? whole30Status(settings.whole30StartDate, diet.dateKey) : null;

  const changeActivity = (level: ActivityLevel) => {
    setSavingActivity(true);
    void patient.saveDietActivity(level, 'settings').then(() => {
      setSavingActivity(false);
      setEditingActivity(false);
    });
  };

  return (
    <LedgerCard style={styles.card} testID="diet-summary">
      <SectionLabel text={locked ? 'Active plan' : 'Your diet'} />
      <Text testID="diet-summary-name" style={[styles.name, { color: colors.navy }]}>
        {locked ? 'THINNR protocol' : entry?.name ?? 'No diet picked yet'}
      </Text>
      <Text testID="diet-summary-phase" style={[styles.meta, { color: colors.subtleText }]}>{phaseLabel(diet)}</Text>
      {locked ? (
        <Text style={[styles.body, { color: colors.bodyText }]}>
          Your Approved Foods list is what fits right now. The diet picker unlocks when the protocol finishes and you move into maintenance.
        </Text>
      ) : entry ? (
        <>
          <Text style={[styles.body, { color: colors.bodyText }]}>{entry.summary}</Text>
          <Text style={[styles.meta, { color: colors.subtleText }]}>Complexity · {COMPLEXITY_LABELS[entry.complexity]}</Text>
          {entry.oversightNote ? (
            <Text testID="diet-summary-oversight" style={[styles.meta, { color: colors.navy }]}>{OVERSIGHT_NOTE_TEXT}</Text>
          ) : null}
        </>
      ) : (
        <Text style={[styles.body, { color: colors.bodyText }]}>
          Pick a diet framework, or just track what you eat — "Fits your diet" badges follow your choice.
        </Text>
      )}

      {settings.fastingWindow ? (
        <View testID="diet-summary-fasting" style={[styles.settingRow, { borderColor: colors.border, borderRadius: colors.radiusSm }]}>
          <Text style={[styles.meta, { color: colors.labelText }]}>EATING WINDOW</Text>
          <Text style={[styles.settingValue, { color: colors.navy }]}>
            {formatClock(settings.fastingWindow.eatingStart)} – {formatClock(settings.fastingWindow.eatingEnd)}
          </Text>
        </View>
      ) : null}
      {w30 && settings.whole30StartDate ? (
        <View testID="diet-summary-whole30" style={[styles.settingRow, { borderColor: colors.border, borderRadius: colors.radiusSm }]}>
          <Text style={[styles.meta, { color: colors.labelText }]}>WHOLE30</Text>
          <Text style={[styles.settingValue, { color: colors.navy }]}>
            {w30.day < 1 ? `Starts ${formatDateKey(settings.whole30StartDate)}` : w30.finished ? 'All 30 days done' : `Day ${w30.day} of 30`}
          </Text>
        </View>
      ) : null}

      {diet.pendingBlock && diet.pendingBlock.status === 'pending' ? (
        <ReviewCard
          testID="diet-summary-pending"
          body={`Your care team has been asked to review your pick of ${DIET_BY_SLUG.get(diet.pendingBlock.dietSlug)?.name ?? 'a diet'}. You can choose something else meanwhile.`}
        />
      ) : null}

      <View style={[styles.activity, { borderTopColor: colors.border }]}>
        <View style={styles.activityHead}>
          <View>
            <Text style={[styles.meta, { color: colors.labelText }]}>ACTIVITY LEVEL</Text>
            <Text testID="diet-summary-activity" style={[styles.settingValue, { color: colors.navy }]}>
              {diet.activityLevel ? ACTIVITY_SHORT_LABELS[diet.activityLevel.level] : 'Not set'}
            </Text>
            {diet.activityLevel ? (
              <Text style={[styles.meta, { color: colors.subtleText }]}>Updated {formatDateKey(diet.activityLevel.recordedOn)}</Text>
            ) : null}
          </View>
          <Pressable testID="diet-summary-activity-edit" accessibilityRole="button" onPress={() => setEditingActivity(v => !v)} hitSlop={6}>
            <Text style={[styles.link, { color: colors.cobalt }]}>{editingActivity ? 'Cancel' : 'Change'}</Text>
          </Pressable>
        </View>
        {editingActivity ? (
          <ActivityLevelPicker testIDPrefix="diet-summary-activity" value={diet.activityLevel?.level ?? null} onChange={changeActivity} />
        ) : null}
        {savingActivity ? <Text style={[styles.meta, { color: colors.subtleText }]}>Saving…</Text> : null}
      </View>

      {locked ? (
        <GhostButton testID="diet-summary-locked" label="Diet picker unlocks after the protocol" disabled onPress={() => undefined} style={styles.gap} />
      ) : (
        <PrimaryButton testID="diet-summary-change" label={entry ? 'Change diet' : 'Pick a diet'} onPress={onChangeDiet} style={styles.gap} />
      )}
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 8 },
  name: { fontFamily: 'PlayfairDisplay_700Bold', fontSize: 22 },
  meta: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.6 },
  body: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  settingRow: { borderWidth: 1, padding: 10, gap: 2 },
  settingValue: { fontFamily: fonts.sansSemiBold, fontSize: 15 },
  activity: { borderTopWidth: 1, paddingTop: 10, marginTop: 4, gap: 8 },
  activityHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  link: { fontFamily: fonts.sansMedium, fontSize: 13 },
  gap: { marginTop: 6 },
});
