/**
 * EntryEditPanel — inline controls that expand under a diary entry row so a
 * patient can fix a logged entry in place: switch the meal slot, step the
 * quantity, or move it to a different day (clamped to the diary's range).
 * Calories/macros rescale from the entry's own logged snapshot (via
 * rescaleEntrySnapshot), so the correction stays faithful even if the
 * library food has been edited since logging.
 *
 * Heritage language: the panel is the pale-cobalt "focus bar" surface set
 * off by a hairline, with soft-radius stepper controls and a cobalt save.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PillSelector } from '@/components/ui/LedgerPrimitives';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { formatQty, rescaleEntrySnapshot } from '@/data/diary-entries';
import {
  dayLabel,
  DIARY_MIN_KEY,
  MEAL_LABELS,
  MEAL_SLOTS,
  shiftDateKey,
  TODAY_KEY,
  type MealLogEntry,
  type MealSlot,
} from '@/data/patient-data';

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

interface EntryEditPanelProps {
  entry: MealLogEntry;
  /** Close the panel after a successful save; reports the day the entry now lives on. */
  onDone: (savedDateKey: string) => void;
}

export function EntryEditPanel({ entry, onDone }: EntryEditPanelProps) {
  const colors = useColors();
  const patient = usePatient();
  const [meal, setMeal] = useState<MealSlot>(entry.meal);
  const [qty, setQty] = useState(entry.quantity);
  const [dateKey, setDateKey] = useState(entry.dateKey);
  const [saving, setSaving] = useState(false);

  const preview = rescaleEntrySnapshot(entry, qty);
  const moved = dateKey !== entry.dateKey;
  const dirty = meal !== entry.meal || qty !== entry.quantity || moved;
  const atMin = dateKey <= DIARY_MIN_KEY;
  const atMax = dateKey >= TODAY_KEY;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await patient.updateEntry(entry.id, { meal, quantity: qty, dateKey });
      onDone(dateKey);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: colors.sidebarBg, borderTopColor: colors.activeBorder },
      ]}
    >
      <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} style={{ marginBottom: 10 }} />
      <View style={[styles.controls, { marginBottom: 10 }]}>
        <Pressable
          testID="entryedit-day-prev"
          onPress={() => setDateKey(k => shiftDateKey(k, -1))}
          disabled={atMin}
          style={({ pressed }) => [
            styles.stepBtn,
            {
              borderColor: colors.activeBorder,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
            atMin && { opacity: 0.35 },
          ]}
        >
          <Feather name="chevron-left" size={13} color={colors.bodyText} />
        </Pressable>
        <View style={styles.dayCenter}>
          <Feather name="calendar" size={11} color={colors.bodyText} />
          <Text testID="entryedit-day" style={[styles.dayValue, { color: moved ? colors.cobalt : colors.navy }]}>
            {dayLabel(dateKey)}
          </Text>
        </View>
        <Pressable
          testID="entryedit-day-next"
          onPress={() => setDateKey(k => shiftDateKey(k, 1))}
          disabled={atMax}
          style={({ pressed }) => [
            styles.stepBtn,
            {
              borderColor: colors.activeBorder,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
            atMax && { opacity: 0.35 },
          ]}
        >
          <Feather name="chevron-right" size={13} color={colors.bodyText} />
        </Pressable>
      </View>
      <View style={styles.controls}>
        <Pressable
          testID="entryedit-qty-minus"
          onPress={() => setQty(q => Math.max(0.5, Math.round((q - 0.5) * 2) / 2))}
          disabled={qty <= 0.5}
          style={({ pressed }) => [
            styles.stepBtn,
            {
              borderColor: colors.activeBorder,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
            qty <= 0.5 && { opacity: 0.35 },
          ]}
        >
          <Feather name="minus" size={13} color={colors.bodyText} />
        </Pressable>
        <Text testID="entryedit-qty" style={[styles.qtyValue, { color: colors.navy }]}>
          {formatQty(qty)}
        </Text>
        <Pressable
          testID="entryedit-qty-plus"
          onPress={() => setQty(q => Math.min(10, Math.round((q + 0.5) * 2) / 2))}
          disabled={qty >= 10}
          style={({ pressed }) => [
            styles.stepBtn,
            {
              borderColor: colors.activeBorder,
              borderRadius: colors.radiusSm,
              backgroundColor: pressed ? colors.accent : colors.card,
            },
            qty >= 10 && { opacity: 0.35 },
          ]}
        >
          <Feather name="plus" size={13} color={colors.bodyText} />
        </Pressable>
        <Pressable
          testID="entryedit-save"
          onPress={save}
          disabled={saving || !dirty}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
            (pressed || saving) && { opacity: 0.85 },
            !dirty && { opacity: 0.4 },
          ]}
        >
          <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>Save changes</Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colors.bodyText }]}>
        Saves as {preview.detail} · {preview.calories} cal · {MEAL_LABELS[meal]}
        {moved ? ` · moves to ${dayLabel(dateKey)}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepBtn: {
    width: 32,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyValue: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
    minWidth: 30,
    textAlign: 'center',
  },
  dayCenter: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  dayValue: {
    fontSize: 12.5,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  saveBtn: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
  hint: {
    fontSize: 10,
    marginTop: 8,
    fontFamily: fonts.sans,
  },
});
