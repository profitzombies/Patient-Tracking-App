/**
 * Diary — day-by-day food log grouped by meal, with a date navigator,
 * per-entry removal, daily totals, and the water tracker for that day.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { EntryEditPanel } from '@/components/patient/EntryEditPanel';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { WaterTracker } from '@/components/patient/WaterTracker';
import { Divider, LedgerCard, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import { isApprovedFood } from '@/data/approved-foods';
import {
  DIARY_MIN_KEY,
  formatDateKey,
  MEAL_LABELS,
  MEAL_SLOTS,
  shiftDateKey,
  TODAY_KEY,
  type MealLogEntry,
  type MealSlot,
} from '@/data/patient-data';

export default function DiaryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [dateKey, setDateKey] = useState(TODAY_KEY);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Last removed entry, kept around briefly so the deletion can be undone.
  // A fresh object per removal restarts the auto-dismiss timer below.
  const [lastRemoved, setLastRemoved] = useState<{ entry: MealLogEntry } | null>(null);

  // Collapse any open edit panel when the day changes.
  useEffect(() => {
    setEditingId(null);
  }, [dateKey]);

  useEffect(() => {
    if (!lastRemoved) return;
    const timer = setTimeout(() => setLastRemoved(null), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [lastRemoved]);

  const handleRemove = async (entry: MealLogEntry) => {
    setEditingId(cur => (cur === entry.id ? null : cur));
    // Arm the undo affordance only after the deletion has committed, so a
    // fast Undo tap always acts on the recorded deletion (restoreEntry
    // no-ops unless the entry is actually gone).
    await patient.removeEntry(entry.id);
    setLastRemoved({ entry });
  };

  const handleUndo = () => {
    if (!lastRemoved) return;
    const { entry } = lastRemoved;
    setLastRemoved(null);
    void patient.restoreEntry(entry);
  };

  const bottomPad = Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20;

  const entries = patient.entriesForDate(dateKey);
  const totals = useMemo(
    () =>
      entries.reduce(
        (acc, e) => ({
          calories: acc.calories + e.calories,
          protein: acc.protein + e.protein,
          carbs: acc.carbs + e.carbs,
          fat: acc.fat + e.fat,
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      ),
    [entries],
  );

  const isToday = dateKey === TODAY_KEY;
  const atMin = dateKey <= DIARY_MIN_KEY;

  const openLogFood = (meal: MealSlot) => {
    router.push({ pathname: '/log-food', params: { date: dateKey, meal } });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Food Diary" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Date navigator ── */}
        <LedgerCard style={styles.dateBar}>
          <Pressable
            testID="diary-prev-day"
            disabled={atMin}
            onPress={() => setDateKey(k => shiftDateKey(k, -1))}
            style={({ pressed }) => [
              styles.dateArrow,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
              atMin && { opacity: 0.35 },
            ]}
          >
            <Feather name="chevron-left" size={16} color={colors.bodyText} />
          </Pressable>
          <View style={styles.dateCenter}>
            <Text style={[styles.dateText, { color: colors.navy }]}>{formatDateKey(dateKey)}</Text>
            {isToday ? (
              <View style={[styles.todayBadge, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                <Text style={[styles.todayBadgeText, { color: colors.activeGreen }]}>TODAY</Text>
              </View>
            ) : (
              <Pressable onPress={() => setDateKey(TODAY_KEY)} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Text style={[styles.jumpToday, { color: colors.cobalt }]}>Jump to today</Text>
              </Pressable>
            )}
          </View>
          <Pressable
            testID="diary-next-day"
            disabled={isToday}
            onPress={() => setDateKey(k => shiftDateKey(k, 1))}
            style={({ pressed }) => [
              styles.dateArrow,
              { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
              isToday && { opacity: 0.35 },
            ]}
          >
            <Feather name="chevron-right" size={16} color={colors.bodyText} />
          </Pressable>
        </LedgerCard>

        {/* ── Meals ── */}
        {MEAL_SLOTS.map(slot => {
          const slotEntries = entries.filter(e => e.meal === slot);
          const slotCals = slotEntries.reduce((acc, e) => acc + e.calories, 0);
          return (
            <View key={slot} style={{ marginBottom: 14 }}>
              <SectionHeader
                label={MEAL_LABELS[slot]}
                value={slotCals > 0 ? `${slotCals.toLocaleString('en-US')} cal` : undefined}
                style={{ marginBottom: 8 }}
              />
              <LedgerCard>
                {slotEntries.length === 0 ? (
                  <Text style={[styles.emptyMeal, { color: colors.subtleText }]}>Nothing logged</Text>
                ) : (
                  slotEntries.map((entry, index) => (
                    <View key={entry.id}>
                      {index > 0 && <Divider />}
                      <View style={styles.entryRow}>
                        <View style={{ flex: 1 }}>
                          <View style={styles.entryNameRow}>
                            <Text style={[styles.entryName, { color: colors.navyLight }]} numberOfLines={1}>
                              {entry.name}
                            </Text>
                            {entry.kind === 'food' && isApprovedFood(entry.refId) && <ApprovedBadge size="sm" />}
                          </View>
                          <Text style={[styles.entryDetail, { color: colors.subtleText }]}>
                            {entry.detail} · P {entry.protein}g · C {entry.carbs}g · F {entry.fat}g
                          </Text>
                        </View>
                        <Text style={[styles.entryCals, { color: colors.navyLight }]}>{entry.calories}</Text>
                        <Pressable
                          testID={`diary-edit-${entry.id}`}
                          onPress={() => setEditingId(cur => (cur === entry.id ? null : entry.id))}
                          hitSlop={8}
                          style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.6 }]}
                        >
                          <Feather
                            name="edit-2"
                            size={14}
                            color={editingId === entry.id ? colors.cobalt : colors.subtleText}
                          />
                        </Pressable>
                        <Pressable
                          testID={`diary-remove-${entry.id}`}
                          onPress={() => {
                            void handleRemove(entry);
                          }}
                          hitSlop={8}
                          style={({ pressed }) => [styles.removeBtn, pressed && { opacity: 0.6 }]}
                        >
                          <Feather name="x" size={14} color={colors.subtleText} />
                        </Pressable>
                      </View>
                      {editingId === entry.id && (
                        <EntryEditPanel entry={entry} onDone={() => setEditingId(null)} />
                      )}
                    </View>
                  ))
                )}
                <Divider />
                <Pressable
                  testID={`diary-add-${slot}`}
                  onPress={() => openLogFood(slot)}
                  style={({ pressed }) => [styles.addRow, pressed && { backgroundColor: colors.accent }]}
                >
                  <Feather name="plus" size={14} color={colors.cobalt} />
                  <Text style={[styles.addRowText, { color: colors.cobalt }]}>Add food</Text>
                </Pressable>
              </LedgerCard>
            </View>
          );
        })}

        {/* ── Day totals ── */}
        <SectionHeader label="Day Totals" style={{ marginBottom: 8 }} />
        <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
          <View style={styles.totalsRow}>
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navy }]}>{totals.calories.toLocaleString('en-US')}</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>CALORIES</Text>
            </View>
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navyLight }]}>{Math.round(totals.protein)}g</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>PROTEIN</Text>
            </View>
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navyLight }]}>{Math.round(totals.carbs)}g</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>CARBS</Text>
            </View>
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navyLight }]}>{Math.round(totals.fat)}g</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>FAT</Text>
            </View>
          </View>
          <Text style={[styles.totalsHint, { color: colors.subtleText }]}>
            Target {patient.targets.calories.toLocaleString('en-US')} cal · {totals.calories <= patient.targets.calories ? 'on plan' : 'over target'}
          </Text>
        </LedgerCard>

        {/* ── Water ── */}
        <SectionHeader label="Water" style={{ marginBottom: 8 }} />
        <LedgerCard style={{ padding: 16 }}>
          <WaterTracker dateKey={dateKey} />
        </LedgerCard>

        <SyntheticDisclaimer />
      </ScrollView>

      {/* ── Undo snackbar (floats above the tab bar) ── */}
      {lastRemoved && (
        <View
          testID="diary-undo-snackbar"
          style={[
            styles.snackbar,
            {
              backgroundColor: colors.navy,
              borderColor: colors.navyLight,
              bottom: (Platform.OS === 'web' ? 84 : insets.bottom + 84) + 12,
            },
          ]}
        >
          <Text style={[styles.snackbarText, { color: colors.paperCard }]} numberOfLines={1}>
            Removed “{lastRemoved.entry.name}”
          </Text>
          <Pressable
            testID="diary-undo"
            onPress={handleUndo}
            hitSlop={8}
            style={({ pressed }) => [
              styles.undoBtn,
              { borderColor: colors.cobaltMuted },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.undoText, { color: colors.paperCard }]}>UNDO</Text>
          </Pressable>
        </View>
      )}
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
  dateBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
    marginBottom: 16,
  },
  dateArrow: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateCenter: {
    alignItems: 'center',
    gap: 3,
  },
  dateText: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.2,
  },
  todayBadge: {
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  todayBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
  },
  jumpToday: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  emptyMeal: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    gap: 10,
  },
  entryNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  entryName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  entryDetail: {
    fontSize: 10,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  entryCals: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  removeBtn: {
    padding: 4,
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 11,
  },
  addRowText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  totalsRow: {
    flexDirection: 'row',
  },
  totalsCol: {
    flex: 1,
  },
  totalsValue: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.5,
    fontFamily: 'Inter_600SemiBold',
  },
  totalsLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
  },
  totalsHint: {
    fontSize: 11,
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
  },
  snackbar: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  snackbarText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  undoBtn: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  undoText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
  },
});

const UNDO_WINDOW_MS = 5000;
