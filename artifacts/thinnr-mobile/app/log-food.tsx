/**
 * Log Food — search the food database and recipes, pick a quantity, and
 * add it to a meal. Includes recents, favorites, quick-add custom foods,
 * and — when the viewed day's previous day has entries in the selected
 * slot — a "Yesterday's [meal]" option above the most-logged group that
 * opens a review-and-log of that whole slot.
 */
import React, { useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { ApprovedBadge } from '@/components/patient/ApprovedBadge';
import { FavoriteStar } from '@/components/patient/FavoriteStar';
import { Divider, EmptyState, LedgerCard, PillSelector } from '@/components/ui/LedgerPrimitives';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import { APPROVED_BADGE_EXPLANATION } from '@/data/approved-foods';
import { rankMostLogged, yesterdaySlotPreview } from '@/data/diary-entries';
import {
  DIARY_MIN_KEY,
  formatDateKey,
  MEAL_LABELS,
  MEAL_SLOTS,
  shiftDateKey,
  subDays,
  toDateKey,
  TODAY,
  type MealSlot,
} from '@/data/patient-data';
import { useLoggableItems, type LoggableItem } from '@/hooks/useLoggableItems';
import { toTitleCase } from '@/lib/title-case';

type Scope = 'recent' | 'favorites' | 'all';

/** A titled section of the results list (title is null for flat lists). */
interface ResultGroup {
  key: string;
  title: string | null;
  items: LoggableItem[];
}

const SCOPE_OPTIONS: { label: string; value: Scope }[] = [
  { label: 'Recent', value: 'recent' },
  { label: 'Favorites', value: 'favorites' },
  { label: 'All', value: 'all' },
];

// "Most logged" ranks diary frequency over a recent window so true staples
// surface first. Window is anchored to the demo's fixed TODAY, one-offs
// (fewer than MIN_COUNT logs) stay in the plain Recent list, and the group
// is capped so it stays scannable.
const MOST_LOGGED_WINDOW_DAYS = 30;
const MOST_LOGGED_SINCE_KEY = toDateKey(subDays(TODAY, MOST_LOGGED_WINDOW_DAYS - 1));
const MOST_LOGGED_MIN_COUNT = 2;
const MOST_LOGGED_LIMIT = 10;

const MEAL_OPTIONS = MEAL_SLOTS.map(slot => ({ label: MEAL_LABELS[slot], value: slot }));

function parseNum(raw: string): number {
  const value = parseFloat(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : NaN;
}

function formatQty(qty: number): string {
  return qty % 1 === 0 ? String(qty) : qty.toFixed(1);
}

export default function LogFoodScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();
  const params = useLocalSearchParams<{ date?: string; meal?: string }>();

  const dateKey = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
    ? params.date
    : patient.todayKey;
  const initialMeal = MEAL_SLOTS.includes(params.meal as MealSlot)
    ? (params.meal as MealSlot)
    : 'breakfast';

  const [meal, setMeal] = useState<MealSlot>(initialMeal);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('recent');
  const [approvedOnly, setApprovedOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);

  // Quick-add form
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState('');
  const [quickServing, setQuickServing] = useState('');
  const [quickCals, setQuickCals] = useState('');
  const [quickProtein, setQuickProtein] = useState('');
  const [quickCarbs, setQuickCarbs] = useState('');
  const [quickFat, setQuickFat] = useState('');
  const [quickError, setQuickError] = useState('');

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 20 : Math.max(insets.bottom, 16);

  // One catalog shared with the "Yesterday's [meal]" review, so both search
  // the exact same items.
  const { allItems, byId } = useLoggableItems();

  // "Yesterday's [meal]" — the previous day's entries for the selected slot,
  // offered above the most-logged group as a tap-in review-and-log.
  // "Yesterday" follows the diary's meaning (the day before the date being
  // viewed); below the diary horizon there is no previous day, and an empty
  // slot hides the option entirely.
  const isToday = dateKey === patient.todayKey;
  const prevKey = shiftDateKey(dateKey, -1);
  const atMin = dateKey <= DIARY_MIN_KEY;
  const yesterdayOption = atMin
    ? null
    : yesterdaySlotPreview(patient.entriesForDate(prevKey), meal);
  // Same label rule as the diary's copy actions: "Yesterday's …" only when
  // viewing today; otherwise name the actual source date.
  const yesterdayTitle = isToday
    ? `Yesterday's ${MEAL_LABELS[meal]}`
    : `${MEAL_LABELS[meal]} from ${formatDateKey(prevKey)}`;

  // Diary staples: ranked by log frequency over the window, ties by recency.
  // Counts come from all diary entries (seeded + user-added), so the demo
  // patient sees real staples before ever logging anything themselves.
  const mostLogged = useMemo<LoggableItem[]>(
    () =>
      rankMostLogged(patient.allEntries, MOST_LOGGED_SINCE_KEY)
        .filter(freq => freq.count >= MOST_LOGGED_MIN_COUNT)
        .map((freq): LoggableItem | null => {
          const item = byId.get(freq.refId);
          return item ? { ...item, loggedCount: freq.count } : null;
        })
        .filter((i): i is LoggableItem => Boolean(i))
        .slice(0, MOST_LOGGED_LIMIT),
    [patient.allEntries, byId],
  );

  const groups = useMemo<ResultGroup[]>(() => {
    const q = query.trim().toLowerCase();
    let built: ResultGroup[];
    if (q) {
      built = [{
        key: 'search',
        title: null,
        items: allItems.filter(item => `${item.name} ${item.sub}`.toLowerCase().includes(q)),
      }];
    } else if (scope === 'recent') {
      const inMostLogged = new Set(mostLogged.map(item => item.refId));
      const recents = patient.recents
        .filter(id => !inMostLogged.has(id))
        .map(id => byId.get(id))
        .filter((i): i is LoggableItem => Boolean(i));
      built = [
        { key: 'most-logged', title: `MOST LOGGED · LAST ${MOST_LOGGED_WINDOW_DAYS} DAYS`, items: mostLogged },
        { key: 'recent', title: 'RECENT', items: recents },
      ];
    } else if (scope === 'favorites') {
      built = [{
        key: 'favorites',
        title: null,
        items: patient.favorites.map(id => byId.get(id)).filter((i): i is LoggableItem => Boolean(i)),
      }];
    } else {
      built = [{ key: 'all', title: null, items: allItems }];
    }
    return built
      .map(group => (approvedOnly ? { ...group, items: group.items.filter(item => item.approved) } : group))
      .filter(group => group.items.length > 0);
  }, [query, scope, approvedOnly, allItems, byId, mostLogged, patient.recents, patient.favorites]);

  const totalVisible = groups.reduce((sum, group) => sum + group.items.length, 0);

  const selected = selectedId ? byId.get(selectedId) : undefined;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/today');
  };

  /** Navigate to the full recipe page so the patient can review before logging. */
  const openRecipe = (item: LoggableItem) => {
    router.push({
      pathname: '/recipe/[id]',
      params: { id: item.refId, date: dateKey, meal },
    });
  };

  /** Hand off to the yesterday review — it logs the final selection itself. */
  const openYesterdayReview = () => {
    router.push({ pathname: '/yesterday-review', params: { date: dateKey, meal } });
  };

  /** Quick-add a recipe at qty=1 without opening the detail page (used by the + button). */
  const quickLogRecipe = async (item: LoggableItem) => {
    if (saving) return;
    setSaving(true);
    try {
      await patient.addEntry({
        dateKey,
        meal,
        kind: 'recipe',
        refId: item.refId,
        name: item.name,
        detail: '1 serving · recipe',
        quantity: 1,
        calories: Math.round(item.calories),
        protein: Math.round(item.protein),
        carbs: Math.round(item.carbs),
        fat: Math.round(item.fat),
      });
      goBack();
    } finally {
      setSaving(false);
    }
  };

  const addSelected = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await patient.addEntry({
        dateKey,
        meal,
        kind: selected.kind,
        refId: selected.refId,
        name: selected.name,
        detail: `${formatQty(qty)} × ${selected.serving}`,
        quantity: qty,
        calories: Math.round(selected.calories * qty),
        protein: Math.round(selected.protein * qty),
        carbs: Math.round(selected.carbs * qty),
        fat: Math.round(selected.fat * qty),
      });
      goBack();
    } finally {
      setSaving(false);
    }
  };

  const saveQuickAdd = async () => {
    if (saving) return;
    const name = quickName.trim();
    const calories = parseNum(quickCals);
    if (!name) {
      setQuickError('Give it a name.');
      return;
    }
    if (Number.isNaN(calories)) {
      setQuickError('Calories are required (0 or more).');
      return;
    }
    setQuickError('');
    setSaving(true);
    try {
      const protein = Number.isNaN(parseNum(quickProtein)) ? 0 : parseNum(quickProtein);
      const carbs = Number.isNaN(parseNum(quickCarbs)) ? 0 : parseNum(quickCarbs);
      const fat = Number.isNaN(parseNum(quickFat)) ? 0 : parseNum(quickFat);
      const serving = quickServing.trim() || '1 serving';
      const food = await patient.addCustomFood({
        // Created names are Title Case everywhere foods are created.
        name: toTitleCase(name),
        serving,
        calories: Math.round(calories),
        protein: Math.round(protein),
        carbs: Math.round(carbs),
        fat: Math.round(fat),
      });
      await patient.addEntry({
        dateKey,
        meal,
        kind: 'food',
        refId: food.id,
        name: food.name,
        detail: `1 × ${food.serving}`,
        quantity: 1,
        calories: food.calories,
        protein: food.protein,
        carbs: food.carbs,
        fat: food.fat,
      });
      goBack();
    } finally {
      setSaving(false);
    }
  };

  const numericInputProps = {
    keyboardType: Platform.OS === 'web' ? undefined : ('decimal-pad' as const),
    placeholderTextColor: colors.subtleText,
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: topPad, borderBottomColor: colors.border, backgroundColor: colors.paperCardAlt }]}>
        <Pressable testID="logfood-cancel" onPress={goBack} hitSlop={8}>
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Add Food</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>
            {dateKey === patient.todayKey ? 'Today' : formatDateKey(dateKey)}
          </Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + (selected ? 120 : 0) }]}
      >
        <PillSelector options={MEAL_OPTIONS} selected={meal} onSelect={setMeal} style={{ marginBottom: 12 }} />

        <View style={styles.searchRow}>
          <View style={[styles.searchBox, { borderColor: colors.border, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}>
            <Feather name="search" size={14} color={colors.subtleText} />
            <TextInput
              testID="logfood-search"
              value={query}
              onChangeText={setQuery}
              placeholder="Search foods and recipes..."
              placeholderTextColor={colors.subtleText}
              style={[styles.searchInput, { color: colors.foreground }]}
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <Feather name="x" size={14} color={colors.subtleText} />
              </Pressable>
            )}
          </View>
          <Pressable
            testID="logfood-approved-toggle"
            accessibilityLabel="Only show approved foods"
            onPress={() => setApprovedOnly(v => !v)}
            style={({ pressed }) => [
              styles.approvedBtn,
              {
                borderColor: approvedOnly ? colors.activeGreen : colors.border,
                backgroundColor: approvedOnly ? colors.activeBg : pressed ? colors.accent : colors.card,
                borderRadius: colors.radiusSm,
              },
            ]}
          >
            <Feather name="check" size={15} color={approvedOnly ? colors.activeGreen : colors.bodyText} />
          </Pressable>
        </View>

        {approvedOnly && (
          <View style={styles.legendRow}>
            <ApprovedBadge size="sm" />
            <Text style={[styles.legendText, { color: colors.subtleText }]}>
              Showing only foods approved for the THINNR program
            </Text>
          </View>
        )}

        {query.trim() === '' && (
          <PillSelector options={SCOPE_OPTIONS} selected={scope} onSelect={setScope} style={{ marginTop: 10 }} />
        )}

        {/* ── Quick add ── */}
        <LedgerCard style={{ marginTop: 12 }}>
          <Pressable
            testID="logfood-quick-toggle"
            onPress={() => setQuickOpen(open => !open)}
            style={({ pressed }) => [styles.quickToggle, pressed && { backgroundColor: colors.accent }]}
          >
            <Feather name={quickOpen ? 'chevron-down' : 'plus'} size={14} color={colors.cobalt} />
            <Text style={[styles.quickToggleText, { color: colors.cobalt }]}>
              Quick add a custom food
            </Text>
          </Pressable>
          {quickOpen && (
            <View style={styles.quickForm}>
              <Divider style={{ marginBottom: 12 }} />
              <TextInput
                testID="logfood-quick-name"
                value={quickName}
                onChangeText={setQuickName}
                placeholder="Name (e.g. Deli turkey sandwich)"
                placeholderTextColor={colors.subtleText}
                style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm }]}
              />
              <TextInput
                testID="logfood-quick-serving"
                value={quickServing}
                onChangeText={setQuickServing}
                placeholder="Serving (e.g. 1 sandwich)"
                placeholderTextColor={colors.subtleText}
                style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm }]}
              />
              <View style={styles.quickGrid}>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>CALORIES</Text>
                  <TextInput
                    testID="logfood-quick-calories"
                    value={quickCals}
                    onChangeText={setQuickCals}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
                  />
                </View>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>PROTEIN G</Text>
                  <TextInput
                    testID="logfood-quick-protein"
                    value={quickProtein}
                    onChangeText={setQuickProtein}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
                  />
                </View>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>CARBS G</Text>
                  <TextInput
                    testID="logfood-quick-carbs"
                    value={quickCarbs}
                    onChangeText={setQuickCarbs}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
                  />
                </View>
                <View style={styles.quickGridItem}>
                  <Text style={[styles.quickFieldLabel, { color: colors.labelText }]}>FAT G</Text>
                  <TextInput
                    testID="logfood-quick-fat"
                    value={quickFat}
                    onChangeText={setQuickFat}
                    placeholder="0"
                    {...numericInputProps}
                    style={[styles.quickInput, { borderColor: colors.border, color: colors.foreground, backgroundColor: colors.background, borderRadius: colors.radiusSm, marginBottom: 0 }]}
                  />
                </View>
              </View>
              {quickError ? (
                <Text style={[styles.quickError, { color: colors.riskText }]}>{quickError}</Text>
              ) : null}
              <Pressable
                testID="logfood-quick-save"
                onPress={saveQuickAdd}
                disabled={saving}
                style={({ pressed }) => [
                  styles.quickSaveBtn,
                  { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                  (pressed || saving) && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.quickSaveText, { color: colors.primaryForeground }]}>
                  Save & Log to {MEAL_LABELS[meal]}
                </Text>
              </Pressable>
            </View>
          )}
        </LedgerCard>

        {/* ── Yesterday's [meal] — review & log the previous day's slot ── */}
        {query.trim() === '' && yesterdayOption && (
          <LedgerCard style={{ marginTop: 12 }}>
            <Pressable
              testID="logfood-yesterday"
              accessibilityRole="button"
              accessibilityLabel={`${yesterdayTitle}: ${yesterdayOption.sources.map(e => e.name).join(', ')}. ${yesterdayOption.calories} calories total.`}
              accessibilityHint={`Opens a review where you can remove items or add more before logging to ${MEAL_LABELS[meal]}.`}
              onPress={openYesterdayReview}
              style={({ pressed }) => [styles.yesterdayRow, pressed && { opacity: 0.75 }]}
            >
              <View
                style={[
                  styles.yesterdayIcon,
                  { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                ]}
              >
                <Feather name="rotate-ccw" size={14} color={colors.cobalt} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.yesterdayTitle, { color: colors.cobalt }]}>
                  {yesterdayTitle}
                </Text>
                <Text
                  style={[styles.yesterdayMeta, { color: colors.subtleText }]}
                  numberOfLines={1}
                >
                  {yesterdayOption.sources.map(e => e.name).join(', ')} ·{' '}
                  {yesterdayOption.calories.toLocaleString('en-US')} cal
                </Text>
              </View>
              <Feather name="chevron-right" size={15} color={colors.subtleText} />
            </Pressable>
          </LedgerCard>
        )}

        {/* ── Results ── */}
        <Text style={[styles.resultCount, { color: colors.labelText }]}>
          {totalVisible} ITEM{totalVisible === 1 ? '' : 'S'}
          {approvedOnly ? ' · APPROVED' : ''}
        </Text>
        {totalVisible === 0 ? (
          <LedgerCard>
            <EmptyState
              icon={<Feather name="search" size={22} color={colors.subtleText} />}
              title={
                approvedOnly
                  ? 'No approved foods here'
                  : scope === 'recent' && !query
                    ? 'Nothing logged yet'
                    : scope === 'favorites' && !query
                      ? 'No favorites yet'
                      : 'No matches'
              }
              body={
                approvedOnly
                  ? 'Turn off the filter, or browse Approved Foods in the Library tab.'
                  : scope === 'recent' && !query
                    ? 'Foods you log will show up here for fast re-adding.'
                    : scope === 'favorites' && !query
                      ? 'Tap the star on any food or recipe to save it here for one-tap logging.'
                      : 'Try a different search, or quick add it above.'
              }
            />
          </LedgerCard>
        ) : (
          <LedgerCard>
            {groups.map((group, groupIndex) => (
              <View key={group.key}>
                {groupIndex > 0 && <Divider />}
                {group.title && (
                  <Text
                    testID={`logfood-group-${group.key}`}
                    style={[styles.groupHeader, { color: colors.labelText }]}
                  >
                    {group.title}
                  </Text>
                )}
                {group.items.map((item, index) => {
                  const isSelected = selectedId === item.refId;
                  const isRecipe = item.kind === 'recipe';
                  return (
                    <View key={`${item.refId}-${index}`}>
                      {index > 0 && <Divider />}
                      <Pressable
                        testID={`logfood-item-${item.refId}`}
                        onPress={() => {
                          if (isRecipe) {
                            openRecipe(item);
                          } else {
                            setSelectedId(current => (current === item.refId ? null : item.refId));
                            setQty(1);
                          }
                        }}
                        style={({ pressed }) => [
                          styles.itemRow,
                          isSelected && { backgroundColor: colors.sidebarBg },
                          pressed && !isSelected && { backgroundColor: colors.accent },
                        ]}
                      >
                        <View style={{ flex: 1 }}>
                          <View style={styles.itemNameRow}>
                            <Text style={[styles.itemName, { color: colors.navyLight }]} numberOfLines={1}>
                              {item.name}
                            </Text>
                            {item.approved && <ApprovedBadge size="sm" />}
                          </View>
                          <Text style={[styles.itemSub, { color: colors.subtleText }]} numberOfLines={1}>
                            {item.loggedCount ? `${item.loggedCount}× logged · ` : ''}
                            {item.sub} · {item.serving} · P {item.protein}g
                          </Text>
                        </View>
                        <FavoriteStar id={item.refId} name={item.name} testID={`logfood-fav-${item.refId}`} />
                        <Text style={[styles.itemCals, { color: colors.navyLight }]}>{item.calories}</Text>
                        {isRecipe ? (
                          /* Separate Pressable so + quick-adds without opening the page */
                          <Pressable
                            testID={`logfood-quicklog-${item.refId}`}
                            onPress={() => quickLogRecipe(item)}
                            disabled={saving}
                            hitSlop={8}
                            style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                          >
                            <Feather name="plus-square" size={16} color={colors.subtleText} />
                          </Pressable>
                        ) : (
                          <Feather
                            name={isSelected ? 'check-square' : 'plus-square'}
                            size={16}
                            color={isSelected ? colors.cobalt : colors.subtleText}
                          />
                        )}
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            ))}
          </LedgerCard>
        )}
      </KeyboardAwareScrollViewCompat>

      {/* ── Selected item action bar ── */}
      {selected && (
        <View
          style={[
            styles.actionBar,
            {
              backgroundColor: colors.card,
              borderTopColor: colors.border,
              paddingBottom: bottomPad,
            },
          ]}
        >
          <View style={styles.actionInfo}>
            <Text style={[styles.actionName, { color: colors.navyLight }]} numberOfLines={1}>
              {selected.name}
            </Text>
            <Text style={[styles.actionMeta, { color: colors.subtleText }]}>
              {formatQty(qty)} × {selected.serving} · {Math.round(selected.calories * qty)} cal
            </Text>
          </View>
          <View style={styles.actionControls}>
            <Pressable
              testID="logfood-qty-minus"
              onPress={() => setQty(q => Math.max(0.5, Math.round((q - 0.5) * 2) / 2))}
              disabled={qty <= 0.5}
              style={({ pressed }) => [
                styles.stepBtn,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.background, borderRadius: colors.radiusSm },
                qty <= 0.5 && { opacity: 0.35 },
              ]}
            >
              <Feather name="minus" size={13} color={colors.bodyText} />
            </Pressable>
            <Text style={[styles.qtyValue, { color: colors.navy }]}>{formatQty(qty)}</Text>
            <Pressable
              testID="logfood-qty-plus"
              onPress={() => setQty(q => Math.min(10, Math.round((q + 0.5) * 2) / 2))}
              disabled={qty >= 10}
              style={({ pressed }) => [
                styles.stepBtn,
                { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.background, borderRadius: colors.radiusSm },
                qty >= 10 && { opacity: 0.35 },
              ]}
            >
              <Feather name="plus" size={13} color={colors.bodyText} />
            </Pressable>
            <Pressable
              testID="logfood-add"
              onPress={addSelected}
              disabled={saving}
              style={({ pressed }) => [
                styles.addBtn,
                { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                (pressed || saving) && { opacity: 0.85 },
              ]}
            >
              <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>
                Add to {MEAL_LABELS[meal]}
              </Text>
            </Pressable>
          </View>
        </View>
      )}
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
  searchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 38,
  },
  approvedBtn: {
    width: 38,
    height: 38,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  legendText: {
    fontSize: 10.5,
    fontFamily: 'Inter_400Regular',
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  quickToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  quickToggleText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  quickForm: {
    paddingHorizontal: 14,
    paddingBottom: 14,
  },
  quickInput: {
    borderWidth: 1,
    paddingHorizontal: 10,
    height: 38,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    marginBottom: 8,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  quickGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  quickGridItem: {
    flex: 1,
  },
  quickFieldLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
    marginBottom: 4,
  },
  quickError: {
    fontSize: 11,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
  quickSaveBtn: {
    marginTop: 12,
    paddingVertical: 11,
    alignItems: 'center',
  },
  quickSaveText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  resultCount: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: 'Inter_700Bold',
    marginTop: 14,
    marginBottom: 8,
  },
  yesterdayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  yesterdayIcon: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  yesterdayTitle: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  yesterdayMeta: {
    fontSize: 10.5,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
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
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    boxShadow: '0 -8px 20px rgba(40, 55, 74, 0.08)',
  },
  actionInfo: {
    marginBottom: 10,
  },
  actionName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  actionMeta: {
    fontSize: 11,
    marginTop: 1,
    fontFamily: 'Inter_400Regular',
  },
  actionControls: {
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
  addBtn: {
    flex: 1,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtnText: {
    fontSize: 12.5,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
});
