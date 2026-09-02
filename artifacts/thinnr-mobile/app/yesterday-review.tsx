/**
 * Yesterday review — tap-in from Add Food's "Yesterday's [meal]" option.
 * Lists the previous day's entries for the target slot with untick toggles,
 * lets the patient search-add extra foods, then logs the final selection into
 * the target slot in one confirm (fresh entries, snapshots preserved). The
 * confirm parks an Undo notice and unwinds both this modal and Add Food, so
 * the originating screen (Diary or Today) shows the snackbar.
 */
import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { Divider, EmptyState, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { isApprovedFood } from '@/data/approved-foods';
import { yesterdaySlotPreview } from '@/data/diary-entries';
import {
  DIARY_MIN_KEY,
  formatDateKey,
  MEAL_LABELS,
  MEAL_SLOTS,
  shiftDateKey,
  type MealLogEntry,
  type MealSlot,
} from '@/data/patient-data';
import { useLoggableItems, type LoggableItem } from '@/hooks/useLoggableItems';
import { setPendingLogNotice } from '@/lib/pending-log-notice';

/** One search-added extra; keyed so the same item can be added twice. */
interface ExtraDraft {
  key: string;
  item: LoggableItem;
}

const MAX_SEARCH_RESULTS = 8;

export default function YesterdayReviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const params = useLocalSearchParams<{ date?: string; meal?: string }>();

  const dateKey = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : patient.todayKey;
  const meal: MealSlot = MEAL_SLOTS.includes(params.meal as MealSlot)
    ? (params.meal as MealSlot)
    : 'breakfast';

  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<ExtraDraft[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const extraSeq = useRef(0);

  const { allItems } = useLoggableItems();

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  // Same "yesterday" as the diary and Add Food: the day before the date
  // being viewed. Below the diary horizon there is no previous day.
  const isToday = dateKey === patient.todayKey;
  const prevKey = shiftDateKey(dateKey, -1);
  const atMin = dateKey <= DIARY_MIN_KEY;
  const preview = atMin ? null : yesterdaySlotPreview(patient.entriesForDate(prevKey), meal);
  const sources = useMemo(() => preview?.sources ?? [], [preview]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allItems
      .filter(item => `${item.name} ${item.sub}`.toLowerCase().includes(q))
      .slice(0, MAX_SEARCH_RESULTS);
  }, [allItems, query]);

  const keptSources = sources.filter(entry => !unticked.has(entry.id));
  const selectedCount = keptSources.length + extras.length;
  const totalCals =
    keptSources.reduce((acc, entry) => acc + entry.calories, 0) +
    extras.reduce((acc, extra) => acc + Math.round(extra.item.calories), 0);
  const canLog = selectedCount > 0 && !saving;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const title = isToday
    ? `Yesterday's ${MEAL_LABELS[meal]}`
    : `${MEAL_LABELS[meal]} from ${formatDateKey(prevKey)}`;
  const targetLabel = dateKey === patient.todayKey ? 'Today' : formatDateKey(dateKey);

  const toggleSource = (id: string) => {
    setUnticked(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addExtra = (item: LoggableItem) => {
    extraSeq.current += 1;
    setExtras(current => [...current, { key: `${item.refId}-x${extraSeq.current}`, item }]);
    setQuery('');
  };

  const removeExtra = (key: string) => {
    setExtras(current => current.filter(extra => extra.key !== key));
  };

  /** Extras log at qty 1 — the same shape Add Food's quick paths produce. */
  const extraToDraft = (item: LoggableItem): Omit<MealLogEntry, 'id'> => ({
    dateKey,
    meal,
    kind: item.kind,
    refId: item.refId,
    name: item.name,
    detail: item.kind === 'recipe' ? '1 serving · recipe' : `1 × ${item.serving}`,
    quantity: 1,
    calories: Math.round(item.calories),
    protein: Math.round(item.protein),
    carbs: Math.round(item.carbs),
    fat: Math.round(item.fat),
  });

  const handleLog = async () => {
    if (!canLog) return;
    setSaving(true);
    try {
      const created = await patient.copyEntriesWithExtras(
        keptSources,
        extras.map(extra => extraToDraft(extra.item)),
        { dateKey, meal },
      );
      if (created.length > 0) {
        // The originating screen (Diary or Today) takes this on focus and
        // arms the Undo snackbar for exactly this batch.
        setPendingLogNotice({ entries: created, meal, dateKey });
      }
      // Unwind this review AND the Add Food modal beneath it in one go.
      try {
        router.dismiss(2);
      } catch {
        router.replace('/today');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View
        style={[
          styles.header,
          { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt },
        ]}
      >
        <Pressable testID="yesterday-cancel" onPress={() => router.back()} hitSlop={8}>
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>{title}</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>
            Logs to {MEAL_LABELS[meal]} · {targetLabel}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 120 }]}
      >
        {/* ── Yesterday's items with keep/skip toggles ── */}
        <LedgerCard>
          <Text style={[styles.groupHeader, { color: colors.labelText }]}>
            FROM {isToday ? 'YESTERDAY' : formatDateKey(prevKey).toUpperCase()} · UNTICK TO SKIP
          </Text>
          {sources.length === 0 ? (
            <EmptyState
              icon={<Feather name="rotate-ccw" size={22} color={colors.subtleText} />}
              title="Nothing to copy"
              body={`No ${MEAL_LABELS[meal]} entries were logged the day before. You can still search below to add foods.`}
            />
          ) : (
            sources.map((entry, index) => {
              const checked = !unticked.has(entry.id);
              return (
                <View key={entry.id}>
                  {index > 0 && <Divider />}
                  <Pressable
                    testID={`yesterday-toggle-${entry.id}`}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    accessibilityLabel={`${entry.name}, ${entry.calories} calories`}
                    accessibilityHint={
                      checked
                        ? 'Unticks this item so it is not logged'
                        : 'Includes this item when you log'
                    }
                    onPress={() => toggleSource(entry.id)}
                    style={({ pressed }) => [
                      styles.itemRow,
                      pressed && { backgroundColor: colors.accent },
                    ]}
                  >
                    <Feather
                      name={checked ? 'check-square' : 'square'}
                      size={16}
                      color={checked ? colors.cobalt : colors.subtleText}
                    />
                    <View style={[{ flex: 1 }, !checked && styles.dimmed]}>
                      <View style={styles.itemNameRow}>
                        <Text style={[styles.itemName, { color: colors.navyLight }]} numberOfLines={1}>
                          {entry.name}
                        </Text>
                        {entry.kind === 'food' && entry.refId && isApprovedFood(entry.refId) && (
                          <ApprovedBadge size="sm" />
                        )}
                      </View>
                      <Text style={[styles.itemSub, { color: colors.subtleText }]} numberOfLines={1}>
                        {entry.detail} · P {entry.protein}g
                      </Text>
                    </View>
                    <Text
                      style={[
                        styles.itemCals,
                        { color: colors.navyLight },
                        !checked && styles.dimmed,
                      ]}
                    >
                      {entry.calories}
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </LedgerCard>

        {/* ── Search-add extras ── */}
        <LedgerCard style={{ marginTop: 12 }}>
          <Text style={[styles.groupHeader, { color: colors.labelText }]}>ADD SOMETHING ELSE</Text>
          {extras.map((extra, index) => (
            <View key={extra.key}>
              {index > 0 && <Divider />}
              <View style={styles.itemRow} testID={`yesterday-extra-${extra.key}`}>
                <Feather name="plus-circle" size={16} color={colors.activeGreen} />
                <View style={{ flex: 1 }}>
                  <View style={styles.itemNameRow}>
                    <Text style={[styles.itemName, { color: colors.navyLight }]} numberOfLines={1}>
                      {extra.item.name}
                    </Text>
                    {extra.item.approved && <ApprovedBadge size="sm" />}
                  </View>
                  <Text style={[styles.itemSub, { color: colors.subtleText }]} numberOfLines={1}>
                    {extra.item.kind === 'recipe' ? '1 serving · recipe' : `1 × ${extra.item.serving}`}
                  </Text>
                </View>
                <Text style={[styles.itemCals, { color: colors.navyLight }]}>
                  {Math.round(extra.item.calories)}
                </Text>
                <Pressable
                  testID={`yesterday-extra-remove-${extra.key}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${extra.item.name}`}
                  onPress={() => removeExtra(extra.key)}
                  hitSlop={8}
                  style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                  disabled={saving}
                >
                  <Feather name="x" size={15} color={colors.subtleText} />
                </Pressable>
              </View>
            </View>
          ))}
          {extras.length > 0 && <Divider />}
          <View style={styles.searchWrap}>
            <View
              style={[
                styles.searchBox,
                { borderColor: colors.border, backgroundColor: colors.background, borderRadius: colors.radiusSm },
              ]}
            >
              <Feather name="search" size={14} color={colors.subtleText} />
              <TextInput
                testID="yesterday-search"
                value={query}
                onChangeText={setQuery}
                placeholder="Search foods and recipes to add..."
                placeholderTextColor={colors.subtleText}
                style={[styles.searchInput, { color: colors.foreground }]}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery('')} hitSlop={8}>
                  <Feather name="x" size={14} color={colors.subtleText} />
                </Pressable>
              )}
            </View>
          </View>
          {query.trim().length > 0 &&
            (results.length === 0 ? (
              <Text style={[styles.noMatches, { color: colors.subtleText }]}>
                No matches. Try a different search.
              </Text>
            ) : (
              results.map(item => (
                <View key={item.refId}>
                  <Divider />
                  <Pressable
                    testID={`yesterday-add-${item.refId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Add ${item.name}, ${Math.round(item.calories)} calories`}
                    onPress={() => addExtra(item)}
                    disabled={saving}
                    style={({ pressed }) => [
                      styles.itemRow,
                      pressed && { backgroundColor: colors.accent },
                    ]}
                  >
                    <Feather name="plus-square" size={16} color={colors.subtleText} />
                    <View style={{ flex: 1 }}>
                      <View style={styles.itemNameRow}>
                        <Text style={[styles.itemName, { color: colors.navyLight }]} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {item.approved && <ApprovedBadge size="sm" />}
                      </View>
                      <Text style={[styles.itemSub, { color: colors.subtleText }]} numberOfLines={1}>
                        {item.sub} · {item.serving} · P {item.protein}g
                      </Text>
                    </View>
                    <Text style={[styles.itemCals, { color: colors.navyLight }]}>
                      {Math.round(item.calories)}
                    </Text>
                  </Pressable>
                </View>
              ))
            ))}
        </LedgerCard>
      </KeyboardAwareScrollViewCompat>

      {/* ── Confirm bar ── */}
      <View
        style={[
          styles.footer,
          { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: bottomPad },
        ]}
      >
        <View style={styles.footerInfo}>
          <Text testID="yesterday-summary" style={[styles.footerCount, { color: colors.navyLight }]}>
            {selectedCount} item{selectedCount === 1 ? '' : 's'} ·{' '}
            {totalCals.toLocaleString('en-US')} cal
          </Text>
          <Text style={[styles.footerMeta, { color: colors.subtleText }]}>
            Fresh entries · Undo available after logging
          </Text>
        </View>
        <Pressable
          testID="yesterday-log"
          accessibilityRole="button"
          accessibilityLabel={`Log ${selectedCount} item${selectedCount === 1 ? '' : 's'} to ${MEAL_LABELS[meal]}`}
          accessibilityState={{ disabled: !canLog }}
          onPress={() => void handleLog()}
          disabled={!canLog}
          style={({ pressed }) => [
            styles.logBtn,
            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
            !canLog && { opacity: 0.45 },
            pressed && canLog && { opacity: 0.85 },
          ]}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.primaryForeground} />
          ) : (
            <Text style={[styles.logBtnText, { color: colors.primaryForeground }]}>
              Log to {MEAL_LABELS[meal]}
            </Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
  },
  headerAction: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    width: 52,
  },
  headerCenter: {
    alignItems: 'center',
    flexShrink: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.1,
  },
  headerSub: {
    fontSize: 10,
    marginTop: 1,
    fontFamily: 'Inter_400Regular',
  },
  headerSpacer: {
    width: 52,
  },
  content: {
    padding: 16,
  },
  groupHeader: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 2,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  itemNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  itemName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  itemSub: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  itemCals: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  dimmed: {
    opacity: 0.4,
  },
  searchWrap: {
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 38,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  noMatches: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    boxShadow: '0 -8px 20px rgba(40, 55, 74, 0.08)',
  },
  footerInfo: {
    flex: 1,
  },
  footerCount: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  footerMeta: {
    fontSize: 10,
    marginTop: 1,
    fontFamily: 'Inter_400Regular',
  },
  logBtn: {
    height: 38,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
});
