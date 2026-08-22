/**
 * EntryEditPanel — inline controls that expand under a diary entry row so a
 * patient can fix a logged entry in place: switch the meal slot or step the
 * quantity. Calories/macros rescale from the entry's own logged snapshot
 * (via rescaleEntrySnapshot), so the correction stays faithful even if the
 * library food has been edited since logging.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { PillSelector } from '@/components/ui/LedgerPrimitives';
import { usePatient } from '@/context/PatientContext';
import { formatQty, rescaleEntrySnapshot } from '@/data/diary-entries';
import { MEAL_LABELS, MEAL_SLOTS, type MealLogEntry, type MealSlot } from '@/data/patient-data';

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

interface EntryEditPanelProps {
  entry: MealLogEntry;
  /** Close the panel (after save, or via the row's edit toggle). */
  onDone: () => void;
}

export function EntryEditPanel({ entry, onDone }: EntryEditPanelProps) {
  const colors = useColors();
  const patient = usePatient();
  const [meal, setMeal] = useState<MealSlot>(entry.meal);
  const [qty, setQty] = useState(entry.quantity);
  const [saving, setSaving] = useState(false);

  const preview = rescaleEntrySnapshot(entry, qty);
  const dirty = meal !== entry.meal || qty !== entry.quantity;

  const save = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await patient.updateEntry(entry.id, { meal, quantity: qty });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.panel, { backgroundColor: colors.sidebarBg }]}>
      <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} style={{ marginBottom: 10 }} />
      <View style={styles.controls}>
        <Pressable
          testID="entryedit-qty-minus"
          onPress={() => setQty(q => Math.max(0.5, Math.round((q - 0.5) * 2) / 2))}
          disabled={qty <= 0.5}
          style={({ pressed }) => [
            styles.stepBtn,
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
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
            { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
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
            { backgroundColor: colors.cobalt },
            (pressed || saving) && { opacity: 0.85 },
            !dirty && { opacity: 0.4 },
          ]}
        >
          <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>Save changes</Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: colors.subtleText }]}>
        Saves as {preview.detail} · {preview.calories} cal · {MEAL_LABELS[meal]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
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
    fontFamily: 'Inter_600SemiBold',
    minWidth: 30,
    textAlign: 'center',
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
    fontFamily: 'Inter_700Bold',
  },
  hint: {
    fontSize: 10,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
});
