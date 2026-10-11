/**
 * Daily targets for a signed-in patient: the calculated numbers (goals +
 * BMR + activity) with an edit path that stores overrides through the
 * offline queue. Diet choice never changes these. RN primitives only.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { ACTIVITY_LABELS } from '@/lib/diet-fit';
import type { DietTargetsState, TargetNumbers, TargetOverrideWrite } from '@/lib/diet-state';

type TargetKey = keyof TargetNumbers;

export const TARGET_FIELDS: Array<{ key: TargetKey; label: string; unit: string; step: number; min: number; max: number }> = [
  { key: 'calories', label: 'Calories', unit: 'cal', step: 50, min: 800, max: 5000 },
  { key: 'protein', label: 'Protein', unit: 'g', step: 5, min: 30, max: 400 },
  { key: 'carbs', label: 'Carbs', unit: 'g', step: 5, min: 0, max: 600 },
  { key: 'fat', label: 'Fat', unit: 'g', step: 5, min: 10, max: 300 },
  { key: 'waterOz', label: 'Water', unit: 'fl oz', step: 8, min: 16, max: 200 },
];

/** The overrides a draft implies: numbers that differ from the calculated value, null where it matches. */
export function overridesForDraft(targets: DietTargetsState, draft: TargetNumbers): TargetOverrideWrite {
  const out: TargetOverrideWrite = {};
  for (const field of TARGET_FIELDS) {
    const value = draft[field.key];
    const calculated = targets.calculated[field.key];
    const current = targets.overrides[field.key];
    if (value === calculated) {
      if (current !== null) out[field.key] = null;
    } else if (value !== current) {
      out[field.key] = value;
    }
  }
  return out;
}

export function TargetsEditor({ targets }: { targets: DietTargetsState }) {
  const colors = useColors();
  const patient = usePatient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TargetNumbers>({ ...targets.effective });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!editing) setDraft({ ...targets.effective });
  }, [editing, targets.effective]);

  const save = async () => {
    const overrides = overridesForDraft(targets, draft);
    if (Object.keys(overrides).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setFailed(false);
    const ok = await patient.saveDietTargets(overrides);
    setSaving(false);
    if (ok) setEditing(false);
    else setFailed(true);
  };

  const resetAll = async () => {
    const overrides: TargetOverrideWrite = {};
    for (const key of targets.overridden) overrides[key] = null;
    if (Object.keys(overrides).length === 0) return;
    setSaving(true);
    setFailed(false);
    const ok = await patient.saveDietTargets(overrides);
    setSaving(false);
    setFailed(!ok);
    if (ok) setEditing(false);
  };

  return (
    <LedgerCard style={styles.card} testID="targets-editor">
      {targets.missing.length > 0 ? (
        <Text testID="targets-missing" style={[styles.note, { color: colors.subtleText }]}>
          Add your {targets.missing.join(', ')} so we can calculate these for you — until then these are starting numbers.
        </Text>
      ) : (
        <Text testID="targets-basis" style={[styles.note, { color: colors.subtleText }]}>
          Calculated from your goals and body measurements
          {targets.activityLevel ? ` at a ${ACTIVITY_LABELS[targets.activityLevel].toLowerCase()} activity level` : ''}. Your diet choice doesn’t change them.
        </Text>
      )}
      {TARGET_FIELDS.map((field, index) => {
        const value = editing ? draft[field.key] : targets.effective[field.key];
        const overridden = targets.overrides[field.key] !== null;
        return (
          <View key={field.key}>
            {index > 0 ? <Divider /> : null}
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: colors.labelText }]}>{field.label.toUpperCase()}</Text>
                {overridden && !editing ? (
                  <Text testID={`target-${field.key}-calculated`} style={[styles.note, { color: colors.subtleText }]}>
                    Edited · calculated {targets.calculated[field.key].toLocaleString('en-US')}
                  </Text>
                ) : null}
              </View>
              {editing ? (
                <View style={styles.controls}>
                  <Pressable
                    testID={`target-${field.key}-minus`}
                    accessibilityRole="button"
                    accessibilityLabel={`Lower ${field.label}`}
                    disabled={value <= field.min}
                    onPress={() => setDraft(d => ({ ...d, [field.key]: Math.max(field.min, d[field.key] - field.step) }))}
                    style={[styles.stepBtn, { borderColor: colors.border, borderRadius: colors.radiusSm }, value <= field.min && { opacity: 0.35 }]}
                  >
                    <Text style={[styles.stepText, { color: colors.bodyText }]}>−</Text>
                  </Pressable>
                  <Text testID={`target-${field.key}-value`} style={[styles.value, { color: colors.navy }]}>
                    {value.toLocaleString('en-US')}
                    <Text style={[styles.unit, { color: colors.subtleText }]}> {field.unit}</Text>
                  </Text>
                  <Pressable
                    testID={`target-${field.key}-plus`}
                    accessibilityRole="button"
                    accessibilityLabel={`Raise ${field.label}`}
                    disabled={value >= field.max}
                    onPress={() => setDraft(d => ({ ...d, [field.key]: Math.min(field.max, d[field.key] + field.step) }))}
                    style={[styles.stepBtn, { borderColor: colors.border, borderRadius: colors.radiusSm }, value >= field.max && { opacity: 0.35 }]}
                  >
                    <Text style={[styles.stepText, { color: colors.bodyText }]}>+</Text>
                  </Pressable>
                </View>
              ) : (
                <Text testID={`target-${field.key}-value`} style={[styles.value, { color: colors.navy }]}>
                  {value.toLocaleString('en-US')}
                  <Text style={[styles.unit, { color: colors.subtleText }]}> {field.unit}</Text>
                </Text>
              )}
            </View>
          </View>
        );
      })}
      {failed ? (
        <Text testID="targets-save-failed" style={[styles.note, { color: colors.riskText }]}>Those targets didn’t save. Please try again.</Text>
      ) : null}
      <View style={styles.actions}>
        {editing ? (
          <>
            <PrimaryButton testID="targets-save" label={saving ? 'Saving…' : 'Save targets'} disabled={saving} onPress={() => void save()} style={styles.grow} />
            <GhostButton testID="targets-cancel" label="Cancel" disabled={saving} onPress={() => setEditing(false)} style={styles.grow} />
          </>
        ) : (
          <>
            <GhostButton testID="targets-edit" label="Edit targets" onPress={() => setEditing(true)} style={styles.grow} />
            {targets.overridden.length > 0 ? (
              <GhostButton testID="targets-reset" label={saving ? 'Resetting…' : 'Use calculated'} disabled={saving} onPress={() => void resetAll()} style={styles.grow} />
            ) : null}
          </>
        )}
      </View>
    </LedgerCard>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 8 },
  note: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, gap: 10 },
  label: { fontFamily: fonts.sansMedium, fontSize: 11, letterSpacing: 0.8 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepBtn: { width: 30, height: 30, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontFamily: fonts.sansSemiBold, fontSize: 16, lineHeight: 18 },
  value: { fontFamily: fonts.sansSemiBold, fontSize: 16, minWidth: 84, textAlign: 'center' },
  unit: { fontFamily: fonts.sans, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  grow: { flex: 1 },
});
