/**
 * Diary — day-by-day food log grouped by meal, with a date navigator,
 * one-tap copy of the whole previous day, per-entry removal and inline
 * editing, daily totals, and the water tracker for that day. Each meal
 * section pairs "Add food" with "Take a photo" — the shared photo-AI entry
 * point with that section's slot pinned, so the analyzed meal lands exactly
 * there. One transient snackbar slot handles Undo after a removal, Undo
 * after a copy (taking back exactly that copy's batch), Undo for a
 * "Yesterday's [meal]" review batch handed back by the Add Food flow, and a
 * "Moved to …" confirmation (with a jump) after a cross-day edit.
 *
 * Visual language: Heritage Hero — paper cards with hairline rules, serif
 * (Playfair) card titles, cobalt primaries, soft radius, and orange kept to
 * small accents (the TODAY badge and the over-target status).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { EntryEditPanel } from '@/components/patient/EntryEditPanel';
import { MealPhotoButton } from '@/components/patient/MealPhotoButton';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { WaterTracker } from '@/components/patient/WaterTracker';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { Snackbar } from '@/components/ui/Snackbar';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { isApprovedFood } from '@/data/approved-foods';
import {
  dayLabel,
  DIARY_MIN_KEY,
  findRecipe,
  formatDateKey,
  MEAL_LABELS,
  MEAL_SLOTS,
  shiftDateKey,
  TODAY_KEY,
  type MealLogEntry,
  type MealSlot,
} from '@/data/patient-data';
import { takePendingLogNotice } from '@/lib/pending-log-notice';

// One snackbar slot on the diary: an undoable removal batch, an undoable copy
// batch, an undoable "Yesterday's [meal]" review batch (parked by the Add
// Food flow, picked up here on focus), or a confirmation that an edited entry
// moved to another day. Rapid deletions stack into the current 'removed'
// notice (in deletion order) so a quick clean-up's single Undo restores every
// row, not just the last one. A 'copied' or 'logged' notice carries exactly
// the entries one commit created — a newer batch re-arms the slot with its
// own entries, so Undo always maps to one commit.
type DiaryNotice =
  | { kind: 'removed'; entries: MealLogEntry[] }
  | { kind: 'copied'; entries: MealLogEntry[]; fromKey: string }
  | { kind: 'logged'; entries: MealLogEntry[]; meal: MealSlot }
  | { kind: 'moved'; dateKey: string };

export default function DiaryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [dateKey, setDateKey] = useState(TODAY_KEY);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Guards the copy affordances while a copy commit is in flight, so a rapid
  // double-tap can't clone the same meal twice.
  const [copying, setCopying] = useState(false);
  // A fresh notice object per event restarts the auto-dismiss timer below,
  // and a newer notice of a different kind replaces whatever is showing —
  // but a removal that lands while a 'removed' notice is up merges into its
  // batch, so no deletion loses its undo window mid clean-up.
  const [notice, setNotice] = useState<DiaryNotice | null>(null);

  // Logged recipe rows (curated or coach-saved) open the ingredient
  // breakdown for THAT entry; quick entries have nothing to break down.
  const entryRecipeId = (entry: MealLogEntry): string | undefined => {
    if (entry.kind !== 'recipe' || !entry.refId) return undefined;
    if (findRecipe(entry.refId)) return entry.refId;
    return patient.savedRecipes.some(r => r.id === entry.refId) ? entry.refId : undefined;
  };

  // Collapse any open edit panel when the day changes, and retire a move
  // confirmation once the patient is already looking at its destination day.
  useEffect(() => {
    setEditingId(null);
    setNotice(cur => (cur?.kind === 'moved' && cur.dateKey === dateKey ? null : cur));
  }, [dateKey]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The "Yesterday's [meal]" review (reached through Add Food) commits its
  // batch in one action, parks it, and dismisses back to the screen it was
  // opened from; when that's the diary, pick the batch up on focus and arm
  // the same Undo the copy actions get. One-shot take — whichever patient
  // screen regains focus first owns the notice.
  useFocusEffect(
    useCallback(() => {
      const pending = takePendingLogNotice();
      if (pending) {
        setNotice({ kind: 'logged', entries: pending.entries, meal: pending.meal });
      }
    }, []),
  );

  const handleRemove = async (entry: MealLogEntry) => {
    setEditingId(cur => (cur === entry.id ? null : cur));
    // Arm the undo affordance only after the deletion has committed, so a
    // fast Undo tap always acts on the recorded deletion (restoreEntries
    // no-ops unless the entry is actually gone). The functional update
    // stacks into an existing removal batch instead of evicting it, and the
    // id guard keeps a double-tapped delete from counting the same row twice.
    await patient.removeEntry(entry.id);
    setNotice(cur => {
      if (cur?.kind !== 'removed') return { kind: 'removed', entries: [entry] };
      if (cur.entries.some(e => e.id === entry.id)) return cur;
      return { kind: 'removed', entries: [...cur.entries, entry] };
    });
  };

  const handleUndo = () => {
    if (notice?.kind !== 'removed') return;
    setNotice(null);
    // One batched restore: every entry comes back in a single commit, so day
    // totals update once and never show a half-restored state.
    void patient.restoreEntries(notice.entries);
  };

  const handleUndoCopy = () => {
    if (notice?.kind !== 'copied') return;
    setNotice(null);
    // One batched remove of exactly the clone ids this copy created, so day
    // totals return to their pre-copy values in a single commit. Clearing the
    // notice first plus removeEntries' id-based no-ops means a double-tapped
    // Undo can never take out more than the copy added.
    void patient.removeEntries(notice.entries.map(e => e.id));
  };

  const handleUndoLogged = () => {
    if (notice?.kind !== 'logged') return;
    setNotice(null);
    // Same mechanics as a copy undo: remove exactly the ids the review's one
    // confirm created (kept yesterday items plus any extras) in one commit.
    void patient.removeEntries(notice.entries.map(e => e.id));
  };

  const handleViewMoved = () => {
    if (notice?.kind !== 'moved') return;
    setNotice(null);
    setDateKey(notice.dateKey);
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
  const onPlan = totals.calories <= patient.targets.calories;

  // Copy source: the day before the one being viewed. Below the diary horizon
  // there is no previous day to copy from.
  const prevKey = shiftDateKey(dateKey, -1);
  const prevEntries = atMin ? [] : patient.entriesForDate(prevKey);
  const prevCalories = prevEntries.reduce((acc, e) => acc + e.calories, 0);
  const sourceLabel = isToday ? 'yesterday' : formatDateKey(prevKey);

  const handleCopy = async (sources: MealLogEntry[]) => {
    if (copying || sources.length === 0) return;
    setCopying(true);
    try {
      // Clones keep each source's logged snapshot; only the day changes.
      // Fresh ids are assigned in the context. Arm the Undo only after the
      // copy has committed, and with the exact clone batch it returned —
      // Undo can then remove precisely those ids and nothing else.
      const clones = await patient.copyEntries(sources, { dateKey });
      setNotice({ kind: 'copied', entries: clones, fromKey: prevKey });
    } finally {
      setCopying(false);
    }
  };

  const openLogFood = (meal: MealSlot) => {
    router.push({ pathname: '/log-food', params: { date: dateKey, meal } });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Food Diary" />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {/* ── Date navigator (with the whole-day copy action) ── */}
        <LedgerCard accentTop style={styles.dateCard}>
          <View style={styles.dateBar}>
            <Pressable
              testID="diary-prev-day"
              disabled={atMin}
              onPress={() => setDateKey(k => shiftDateKey(k, -1))}
              style={({ pressed }) => [
                styles.dateArrow,
                {
                  borderColor: colors.border,
                  borderRadius: colors.radiusSm,
                  backgroundColor: pressed ? colors.accent : colors.card,
                },
                atMin && { opacity: 0.35 },
              ]}
            >
              <Feather name="chevron-left" size={16} color={colors.bodyText} />
            </Pressable>
            <View style={styles.dateCenter}>
              {/* Heritage date device: small caps between hairline rules */}
              <View
                style={[
                  styles.dateStrip,
                  { borderColor: colors.border, backgroundColor: colors.secondary },
                ]}
              >
                <Text style={[styles.dateText, { color: colors.bodyText }]}>
                  {formatDateKey(dateKey)}
                </Text>
              </View>
              {isToday ? (
                <View style={[styles.todayBadge, { backgroundColor: colors.orangeBg, borderColor: colors.orangeBorder }]}>
                  <Text style={[styles.todayBadgeText, { color: colors.orangeText }]}>TODAY</Text>
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
                {
                  borderColor: colors.border,
                  borderRadius: colors.radiusSm,
                  backgroundColor: pressed ? colors.accent : colors.card,
                },
                isToday && { opacity: 0.35 },
              ]}
            >
              <Feather name="chevron-right" size={16} color={colors.bodyText} />
            </Pressable>
          </View>
          {/* One-tap whole-day copy — always offered while the previous day
              has entries. On a day that already has meals it appends ("Adds
              …"), never replaces. */}
          {prevEntries.length > 0 && (
            <>
              <Divider />
              <Pressable
                testID="diary-copy-day"
                disabled={copying}
                onPress={() => {
                  void handleCopy(prevEntries);
                }}
                style={({ pressed }) => [
                  styles.copyDayRow,
                  pressed && { opacity: 0.75 },
                  copying && { opacity: 0.5 },
                ]}
              >
                <View
                  style={[
                    styles.copyDayIcon,
                    { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                  ]}
                >
                  <Feather name="copy" size={14} color={colors.cobalt} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.copyDayTitle, { color: colors.cobalt }]}>
                    Copy all meals from {sourceLabel}
                  </Text>
                  <Text style={[styles.copyDayMeta, { color: colors.subtleText }]}>
                    Adds {prevEntries.length} item{prevEntries.length === 1 ? '' : 's'} · {prevCalories.toLocaleString('en-US')} cal
                  </Text>
                </View>
                <Feather name="chevron-right" size={15} color={colors.subtleText} />
              </Pressable>
            </>
          )}
        </LedgerCard>

        {/* ── Meals — one paper card per slot with a serif title row ── */}
        {MEAL_SLOTS.map(slot => {
          const slotEntries = entries.filter(e => e.meal === slot);
          const slotCals = slotEntries.reduce((acc, e) => acc + e.calories, 0);
          return (
            <LedgerCard key={slot} style={styles.mealCard}>
              <View style={styles.cardTitleRow}>
                <Text style={[styles.cardTitle, { color: colors.navyLight }]}>{MEAL_LABELS[slot]}</Text>
                {slotCals > 0 && (
                  <Text style={[styles.cardTitleValue, { color: colors.bodyText }]}>
                    {slotCals.toLocaleString('en-US')} cal
                  </Text>
                )}
              </View>
              <Divider />
              {slotEntries.length === 0 ? (
                <Text style={[styles.emptyMeal, { color: colors.subtleText }]}>Nothing logged</Text>
              ) : (
                slotEntries.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 && <Divider />}
                    <View style={styles.entryRow}>
                      <Pressable
                        testID={entryRecipeId(entry) ? `diary-entry-open-${entry.id}` : undefined}
                        disabled={!entryRecipeId(entry)}
                        onPress={() => {
                          const recipeId = entryRecipeId(entry);
                          if (recipeId) {
                            router.push({
                              pathname: '/recipe/[id]',
                              params: { id: recipeId, entry: entry.id },
                            });
                          }
                        }}
                        accessibilityRole={entryRecipeId(entry) ? 'button' : undefined}
                        accessibilityLabel={
                          entryRecipeId(entry)
                            ? `${entry.name}, ${entry.calories} calories, logged recipe`
                            : undefined
                        }
                        accessibilityHint={
                          entryRecipeId(entry)
                            ? 'Opens the ingredient breakdown to adjust amounts'
                            : undefined
                        }
                        style={({ pressed }) => [
                          { flex: 1 },
                          pressed && !!entryRecipeId(entry) && { opacity: 0.7 },
                        ]}
                      >
                        <View style={styles.entryNameRow}>
                          <Text style={[styles.entryName, { color: colors.navyLight }]} numberOfLines={1}>
                            {entry.name}
                          </Text>
                          {entry.kind === 'food' && isApprovedFood(entry.refId) && <ApprovedBadge size="sm" />}
                          {!!entryRecipeId(entry) && (
                            <Feather name="chevron-right" size={12} color={colors.subtleText} />
                          )}
                        </View>
                        <Text style={[styles.entryDetail, { color: colors.subtleText }]}>
                          {entry.detail} · P {entry.protein}g · C {entry.carbs}g · F {entry.fat}g
                        </Text>
                      </Pressable>
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
                      <EntryEditPanel
                        entry={entry}
                        onDone={savedDateKey => {
                          setEditingId(null);
                          // Confirm only when the entry actually left this day.
                          if (savedDateKey !== dateKey) {
                            setNotice({ kind: 'moved', dateKey: savedDateKey });
                          }
                        }}
                      />
                    )}
                  </View>
                ))
              )}
              <Divider />
              <View style={styles.actionRow}>
                <Pressable
                  testID={`diary-add-${slot}`}
                  onPress={() => openLogFood(slot)}
                  style={({ pressed }) => [
                    styles.actionChip,
                    {
                      borderColor: colors.activeBorder,
                      borderRadius: colors.radiusSm,
                      backgroundColor: pressed ? colors.accent : colors.activeBg,
                    },
                  ]}
                >
                  <Feather name="plus" size={13} color={colors.cobalt} />
                  <Text style={[styles.actionChipText, { color: colors.cobalt }]}>Add food</Text>
                </Pressable>
                {/* Barcode logging for THIS meal — scan or type the number
                    on a packaged food; the scanner stays bound to this slot
                    and day through lookup, confirm, and add. */}
                <Pressable
                  testID={`diary-barcode-${slot}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Scan a barcode for your ${MEAL_LABELS[slot].toLowerCase()}`}
                  accessibilityHint="Scan or type a packaged food's barcode to log it to this meal."
                  onPress={() =>
                    router.push({ pathname: '/barcode-scan', params: { date: dateKey, meal: slot } })
                  }
                  style={({ pressed }) => [
                    styles.barcodeChip,
                    {
                      borderColor: colors.activeBorder,
                      borderRadius: colors.radiusSm,
                      backgroundColor: pressed ? colors.accent : colors.activeBg,
                    },
                  ]}
                >
                  <MaterialCommunityIcons name="barcode-scan" size={15} color={colors.cobalt} />
                </Pressable>
                {/* Photo-AI logging for THIS meal — the shared capture flow
                    with this section's slot pinned through the analysis. */}
                <MealPhotoButton
                  variant="action"
                  mealSlot={slot}
                  testID={`diary-photo-${slot}`}
                  style={{ flex: 1 }}
                />
              </View>
            </LedgerCard>
          );
        })}

        {/* ── Day totals ── */}
        <LedgerCard style={styles.mealCard}>
          <View style={styles.cardTitleRow}>
            <Text style={[styles.cardTitle, { color: colors.navyLight }]}>Day Totals</Text>
          </View>
          <Divider />
          <View style={styles.totalsRow}>
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navy }]}>{totals.calories.toLocaleString('en-US')}</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>CALORIES</Text>
            </View>
            <View style={[styles.totalsRule, { backgroundColor: colors.divider }]} />
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navyLight }]}>{Math.round(totals.protein)}g</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>PROTEIN</Text>
            </View>
            <View style={[styles.totalsRule, { backgroundColor: colors.divider }]} />
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navyLight }]}>{Math.round(totals.carbs)}g</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>CARBS</Text>
            </View>
            <View style={[styles.totalsRule, { backgroundColor: colors.divider }]} />
            <View style={styles.totalsCol}>
              <Text style={[styles.totalsValue, { color: colors.navyLight }]}>{Math.round(totals.fat)}g</Text>
              <Text style={[styles.totalsLabel, { color: colors.labelText }]}>FAT</Text>
            </View>
          </View>
          <Divider />
          <Text style={[styles.totalsHint, { color: colors.subtleText }]}>
            Target {patient.targets.calories.toLocaleString('en-US')} cal ·{' '}
            <Text style={[styles.totalsStatus, { color: onPlan ? colors.cobalt : colors.orangeText }]}>
              {onPlan ? 'on plan' : 'over target'}
            </Text>
          </Text>
        </LedgerCard>

        {/* ── Water ── */}
        <LedgerCard>
          <View style={styles.cardTitleRow}>
            <Text style={[styles.cardTitle, { color: colors.navyLight }]}>Water</Text>
          </View>
          <Divider />
          <View style={styles.waterBody}>
            <WaterTracker dateKey={dateKey} />
          </View>
        </LedgerCard>

        <SyntheticDisclaimer />
      </ScrollView>

      {/* ── Transient notice (floats above the tab bar) ── */}
      {notice?.kind === 'removed' && (
        <Snackbar
          testID="diary-undo-snackbar"
          message={
            notice.entries.length === 1
              ? `Removed “${notice.entries[0]!.name}”`
              : `Removed ${notice.entries.length} entries`
          }
          actionLabel="UNDO"
          actionTestID="diary-undo"
          onAction={handleUndo}
        />
      )}
      {notice?.kind === 'copied' && (
        <Snackbar
          testID="diary-copied-snackbar"
          message={`Copied ${notice.entries.length} item${notice.entries.length === 1 ? '' : 's'} from ${formatDateKey(notice.fromKey)}`}
          actionLabel="UNDO"
          actionTestID="diary-copied-undo"
          onAction={handleUndoCopy}
        />
      )}
      {notice?.kind === 'logged' && (
        <Snackbar
          testID="diary-logged-snackbar"
          message={`Logged ${notice.entries.length} item${notice.entries.length === 1 ? '' : 's'} to ${MEAL_LABELS[notice.meal]}`}
          actionLabel="UNDO"
          actionTestID="diary-logged-undo"
          onAction={handleUndoLogged}
        />
      )}
      {notice?.kind === 'moved' && (
        <Snackbar
          testID="diary-moved-snackbar"
          message={`Moved to ${dayLabel(notice.dateKey)}`}
          actionLabel="VIEW"
          actionTestID="diary-moved-view"
          onAction={handleViewMoved}
        />
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
  dateCard: {
    marginBottom: 16,
  },
  dateBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
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
    gap: 4,
  },
  dateStrip: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dateText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  todayBadge: {
    borderWidth: 1,
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  todayBadgeText: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: fonts.sansBold,
  },
  jumpToday: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  // Serif card title row — the Heritage card header.
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  cardTitle: {
    fontSize: 18,
    fontFamily: fonts.serif,
    letterSpacing: 0.1,
  },
  cardTitleValue: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  mealCard: {
    marginBottom: 14,
  },
  emptyMeal: {
    fontSize: 12,
    fontFamily: fonts.sans,
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
    fontFamily: fonts.sansSemiBold,
    flexShrink: 1,
  },
  entryDetail: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: fonts.sans,
  },
  entryCals: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  removeBtn: {
    padding: 4,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actionChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 4,
  },
  actionChipText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
  /** Icon-only square sibling of actionChip (same border/padding rhythm). */
  barcodeChip: {
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyDayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  copyDayIcon: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copyDayTitle: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
  copyDayMeta: {
    fontSize: 10,
    marginTop: 2,
    fontFamily: fonts.sans,
  },
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 14,
  },
  totalsCol: {
    flex: 1,
    alignItems: 'center',
  },
  totalsRule: {
    width: 1,
    height: 30,
  },
  totalsValue: {
    fontSize: 18,
    fontWeight: '600',
    letterSpacing: -0.5,
    fontFamily: fonts.sansSemiBold,
  },
  totalsLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: fonts.sansBold,
    marginTop: 3,
  },
  totalsHint: {
    fontSize: 11,
    fontFamily: fonts.sans,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  totalsStatus: {
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  waterBody: {
    padding: 16,
    paddingTop: 14,
  },
});

const NOTICE_WINDOW_MS = 5000;
