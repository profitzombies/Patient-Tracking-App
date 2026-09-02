/**
 * Today — the patient home screen, styled to the approved Heritage Hero
 * reference. Full-bleed photo hero with a light wash (THINNR wordmark, date
 * strip, serif welcome, quick-link chips, floating focus bar), then a
 * day-at-a-glance streak card, program instructions row, the calorie card
 * with an upright dome gauge + macro bars, a combined meals & hydration
 * list, the daily check-in card, and a weight snapshot.
 *
 * All numbers stay live-bound to PatientContext — the reference's demo
 * values are never hardcoded.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { patientContentBottom } from '@/constants/layout';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, type Href } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { useAppWindowDimensions } from '@/hooks/useAppWindowDimensions';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { APPROVED_FOODS_HREF } from '@/constants/links';
import { MacroBar } from '@/components/patient/MacroBar';
import { WaterTracker } from '@/components/patient/WaterTracker';
import { ClaimTestEntryCard } from '@/components/patient/ClaimTestEntryCard';
import { Divider, LedgerCard } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { Snackbar } from '@/components/ui/Snackbar';
import { usePatient } from '@/context/PatientContext';
import { HOME_HERO_IMAGE } from '@/data/recipe-images';
import {
  addDays,
  ENROLLMENT_DAYS,
  MEAL_LABELS,
  MEAL_SLOTS,
  MOOD_LABELS,
  PATIENT_PROFILE,
  SEED_DAYS,
  subDays,
  toDateKey,
  TODAY,
  TODAY_KEY,
  type MealLogEntry,
  type MealSlot,
} from '@/data/patient-data';
import { phaseForDay } from '@/data/program-instructions';
import { takePendingLogNotice } from '@/lib/pending-log-notice';

// Earliest day the demo history covers — date paging stops here.
const MIN_KEY = toDateKey(subDays(TODAY, SEED_DAYS));

// How long the "Logged … to [meal]" Undo snackbar stays up (matches the
// diary's notice window).
const LOGGED_NOTICE_WINDOW_MS = 5000;

// How far the floating focus bar hangs below the hero artwork.
const FOCUS_OVERLAP = 16;

/**
 * Over-photo hero inks from the approved reference. These sit on the
 * photograph + wash where no shared surface token applies (translucent
 * papers and hairlines tuned against the artwork).
 */
const HERO_INK = {
  arrow: '#355273',
  dateBorder: '#c5d3e1',
  dateBg: 'rgba(249,250,251,0.55)',
  dateText: '#365373',
  chipBorder: '#ced9e5',
  chipBg: 'rgba(253,252,249,0.9)',
  chipText: '#334e6e',
  focusBorder: '#c8d7e6',
} as const;

// Pale halo behind the selected day's streak mark (reference ring color —
// between accent and sidebarBg; no exact token exists).
const STREAK_HALO = '#dce8f4';

// Ghost-cobalt "Add" button inks from the reference (no semantic token).
const ADD_BTN_BORDER = '#bad0e7';
const ADD_BTN_BG = '#f5f9fd';

// ── Dome calorie gauge geometry (reference: 244×142, r=100, 22pt stroke) ──
const GAUGE_W = 244;
const GAUGE_H = 142;
const GAUGE_ARC = 'M 22 122 A 100 100 0 0 1 222 122';
// react-native-svg ignores pathLength, so dash math uses the true arc length.
const GAUGE_ARC_LEN = Math.PI * 100;

function shiftKey(dateKey: string, days: number): string {
  return toDateKey(addDays(new Date(`${dateKey}T12:00:00.000Z`), days));
}

function formatHeroDate(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function weekdayLetter(dateKey: string): string {
  return new Date(`${dateKey}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'narrow',
    timeZone: 'UTC',
  });
}

// One short prompt per day, picked deterministically from the anchored date
// (never the device clock) so the demo stays reproducible. Phrasings are kept
// tight enough for the 17px serif line to share the focus bar with its caps
// label on a 390px screen — the earlier "…today?" variants ran ~190px and
// chopped mid-word ("How are you feeling to…") beside the ~93px label.
const CHECKIN_PROMPTS = [
  'How are you feeling?',
  'Any side effects?',
  'Getting enough sleep?',
  "How's your energy?",
];
const CHECKIN_PROMPT = CHECKIN_PROMPTS[Number(TODAY_KEY.slice(8, 10)) % CHECKIN_PROMPTS.length];

export default function TodayScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const liveTodayKey = patient.entryFacts?.todayKey ?? TODAY_KEY;
  const programDay = patient.entryFacts?.programDay ?? ENROLLMENT_DAYS;
  const currentPhase = phaseForDay(programDay);
  const firstName = patient.entryFacts?.firstName ?? PATIENT_PROFILE.name.split(' ')[0];
  const [dateKey, setDateKey] = useState(liveTodayKey);
  // Real-account facts arrive after the first render. If this screen mounted
  // on the demo anchor while they loaded, move it to the server-confirmed
  // local day once instead of leaving meals and water stranded off-screen.
  useEffect(() => {
    if (!patient.entryFacts?.todayKey) return;
    setDateKey(current => (current === TODAY_KEY ? patient.entryFacts!.todayKey : current));
  }, [patient.entryFacts?.todayKey]);
  // The "Yesterday's [meal]" review (reached through this screen's Add Food
  // shortcuts) commits its batch, parks it, and dismisses back here; pick it
  // up on focus and offer the same Undo the diary's copy actions get.
  const [loggedNotice, setLoggedNotice] = useState<{
    entries: MealLogEntry[];
    meal: MealSlot;
  } | null>(null);

  useFocusEffect(
    useCallback(() => {
      const pending = takePendingLogNotice();
      if (pending) setLoggedNotice({ entries: pending.entries, meal: pending.meal });
    }, []),
  );

  useEffect(() => {
    if (!loggedNotice) return;
    const timer = setTimeout(() => setLoggedNotice(null), LOGGED_NOTICE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [loggedNotice]);

  // The hero extends behind the status bar; the web preview reserves the same
  // fake-chrome space as the shared header does.
  const heroTopPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const heroHeight = heroTopPad + 313;
  const bottomPad = patientContentBottom(insets.bottom);

  // The hero's copy is fixed, so on narrow phones (360dp Androids, 375pt
  // iPhones) it must yield space instead of ellipsizing mid-word. Two local
  // width steps — not a breakpoint system: below 390 the focus bar hands its
  // caps label's room to the message and the quick-link chips tighten their
  // gutters; below 350 the chips stack. At ≥390 both render exactly the
  // approved Heritage layout. On web the fit-to-reference shell pins the
  // layout canvas at the 393pt iPhone width (useAppWindowDimensions reports
  // canvas space), so these steps engage exactly as on a real iPhone — never
  // from a narrow preview pane, only under a ?layoutWidth= override. The >0
  // guard keeps non-DOM test renders on the regular branch.
  const { width: windowWidth } = useAppWindowDimensions();
  const heroNarrow = windowWidth > 0 && windowWidth < 390;
  const chipsStacked = windowWidth > 0 && windowWidth < 350;

  const isToday = dateKey === liveTodayKey;
  const atMin = dateKey <= (patient.entryFacts?.programStartDate ?? MIN_KEY);

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

  const mealSummaries = useMemo(
    () =>
      MEAL_SLOTS.map(slot => {
        const slotEntries = entries.filter(e => e.meal === slot);
        return {
          slot,
          count: slotEntries.length,
          calories: slotEntries.reduce((acc, e) => acc + e.calories, 0),
        };
      }),
    [entries],
  );

  // Trailing 7 days ending at the selected day — one mark per day, orange
  // when anything was logged, cobalt + halo on the selected day itself.
  const streakDays = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const key = shiftKey(dateKey, i - 6);
        return {
          key,
          letter: weekdayLetter(key),
          logged: patient.entriesForDate(key).length > 0,
          selected: key === dateKey,
        };
      }),
    [dateKey, patient],
  );
  const loggedCount = streakDays.filter(d => d.logged).length;

  const goal = patient.targets.calories;
  const remaining = goal - totals.calories;
  const overTarget = remaining < 0;
  const pctConsumed = goal > 0 ? Math.round((totals.calories / goal) * 100) : 0;
  const gaugeFrac = Math.min(1, Math.max(0, totals.calories / Math.max(1, goal)));

  const dayCheckIn = patient.checkInFor(dateKey);
  const todayCheckIn = patient.checkInFor(liveTodayKey);

  // Focus-bar message, phrased to always read whole. The checked-in state
  // leans on the check glyph instead of spelling out "Checked in — ", which
  // never fit beside the caps label at any phone width (chopped to
  // "Checked in — feeli…" even at 430px). Screen readers still get the full
  // context via the pill's accessibilityLabel.
  const focusMessage = todayCheckIn
    ? `Feeling ${MOOD_LABELS[todayCheckIn.mood].toLowerCase()}`
    : CHECKIN_PROMPT;
  const focusA11yLabel = todayCheckIn
    ? `Today's focus. Checked in, feeling ${MOOD_LABELS[todayCheckIn.mood].toLowerCase()}.`
    : `Today's focus. ${CHECKIN_PROMPT}`;
  const currentWeight = patient.weightSeries.at(-1)?.weight ?? PATIENT_PROFILE.currentWeight;
  const lost = PATIENT_PROFILE.startingWeight - currentWeight;

  const openLogFood = (meal: MealSlot) => {
    router.push({ pathname: '/log-food', params: { date: dateKey, meal } });
  };

  const openCheckIn = () => {
    Haptics.selectionAsync();
    router.push('/check-in');
  };

  const openRestaurantGuide = () => {
    Haptics.selectionAsync();
    router.push('/restaurant-guide');
  };

  // Deep-link into the food library's Approved Foods view (see constants/links).
  const openApprovedList = () => {
    Haptics.selectionAsync();
    router.push(APPROVED_FOODS_HREF);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        {/* ── Photo hero with light wash ── */}
        <View style={{ height: heroHeight + FOCUS_OVERLAP }}>
          <Image
            source={HOME_HERO_IMAGE}
            style={[styles.heroImage, { height: heroHeight }]}
            contentFit="cover"
            contentPosition="center"
            transition={200}
          />
          {/* Reference wash: secondary-paper tones fading into the page bg */}
          <LinearGradient
            colors={[
              'rgba(245,247,249,0.94)',
              'rgba(245,247,249,0.72)',
              'rgba(245,247,249,0.18)',
              colors.background,
            ]}
            locations={[0, 0.36, 0.72, 1]}
            style={[styles.heroWash, { height: heroHeight }]}
          />

          <View style={[styles.heroContent, { paddingTop: heroTopPad + 24 }]}>
            <View style={styles.heroTopRow}>
              <Text style={[styles.wordmark, { color: colors.navy }]}>THINNR</Text>
              {/* Coach used to sit here as a small hero icon; it has a
                  permanent seat in the floating pill bar now, so the hero
                  keeps only the persona avatar. */}
              <View style={styles.heroActions}>
                <Pressable
                  testID="patient-avatar-btn"
                  onPress={() => {
                    Haptics.selectionAsync();
                    router.push((patient.profile ? '/account' : '/persona') as Href);
                  }}
                  style={({ pressed }) => [
                    styles.avatar,
                    { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Text style={[styles.avatarText, { color: colors.primaryForeground }]}>
                    {[patient.profile?.firstName, patient.profile?.lastName]
                      .filter((part): part is string => !!part)
                      .slice(0, 2)
                      .map(part => part[0])
                      .join('')
                      .toUpperCase() || 'ES'}
                  </Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.heroDateRow}>
              <Pressable
                testID="today-prev-day"
                disabled={atMin}
                onPress={() => setDateKey(k => shiftKey(k, -1))}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.dateArrow,
                  pressed && { opacity: 0.6 },
                  atMin && { opacity: 0.3 },
                ]}
              >
                <Feather name="arrow-left" size={18} color={HERO_INK.arrow} />
              </Pressable>
              <View
                style={[
                  styles.heroDateStrip,
                  { borderColor: HERO_INK.dateBorder, backgroundColor: HERO_INK.dateBg },
                ]}
              >
                <Text style={[styles.heroDateText, { color: HERO_INK.dateText }]}>
                  {formatHeroDate(dateKey)}
                </Text>
              </View>
              <Pressable
                testID="today-next-day"
                disabled={isToday}
                onPress={() => setDateKey(k => shiftKey(k, 1))}
                hitSlop={10}
                style={({ pressed }) => [
                  styles.dateArrow,
                  pressed && { opacity: 0.6 },
                  isToday && { opacity: 0.3 },
                ]}
              >
                <Feather name="arrow-right" size={18} color={HERO_INK.arrow} />
              </Pressable>
            </View>

            <Text style={[styles.heroGreeting, { color: colors.navy }]}>
              Welcome back, {firstName}
            </Text>
            {!isToday && (
              <Pressable
                testID="today-jump-today"
                onPress={() => setDateKey(liveTodayKey)}
                hitSlop={6}
                style={({ pressed }) => [styles.jumpToday, pressed && { opacity: 0.7 }]}
              >
                <Text style={[styles.jumpTodayText, { color: colors.navyLight }]}>
                  Viewing an earlier day — jump to today
                </Text>
              </Pressable>
            )}

            {/* ── Quick-link chips ── */}
            <View
              style={[
                styles.chipRow,
                chipsStacked ? styles.chipRowStacked : heroNarrow && styles.chipRowSnug,
              ]}
            >
              <Pressable
                testID="today-restaurant-guide"
                onPress={openRestaurantGuide}
                style={({ pressed }) => [
                  styles.chip,
                  chipsStacked ? styles.chipStacked : heroNarrow && styles.chipSnug,
                  {
                    backgroundColor: HERO_INK.chipBg,
                    borderColor: HERO_INK.chipBorder,
                    borderRadius: colors.radiusSm,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <MaterialCommunityIcons
                  name="silverware-fork-knife"
                  size={14}
                  color={colors.orange}
                />
                <Text numberOfLines={1} style={[styles.chipText, { color: HERO_INK.chipText }]}>
                  Restaurant guide
                </Text>
                <Feather name="chevron-right" size={13} color={colors.subtleText} />
              </Pressable>
              <Pressable
                testID="today-approved-list"
                onPress={openApprovedList}
                style={({ pressed }) => [
                  styles.chip,
                  chipsStacked ? styles.chipStacked : heroNarrow && styles.chipSnug,
                  {
                    backgroundColor: HERO_INK.chipBg,
                    borderColor: HERO_INK.chipBorder,
                    borderRadius: colors.radiusSm,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Feather name="sun" size={14} color={colors.orange} />
                <Text numberOfLines={1} style={[styles.chipText, { color: HERO_INK.chipText }]}>
                  Approved list
                </Text>
                <Feather name="chevron-right" size={13} color={colors.subtleText} />
              </Pressable>
            </View>
          </View>

          {/* ── Floating focus bar ── */}
          <View style={styles.focusWrap}>
            <Pressable
              testID="today-checkin-pill"
              accessibilityRole="button"
              accessibilityLabel={focusA11yLabel}
              onPress={openCheckIn}
              style={({ pressed }) => [
                styles.focusBar,
                { backgroundColor: colors.sidebarBg, borderColor: HERO_INK.focusBorder },
                pressed && { opacity: 0.9 },
              ]}
            >
              {/* Sparkle glyph from MCI, which the root APP_FONTS gate preloads
                  (un-preloaded families like Ionicons tofu on Android/Expo Go). */}
              {todayCheckIn ? (
                <Feather name="check" size={15} color={colors.cobalt} />
              ) : (
                <MaterialCommunityIcons name="creation" size={15} color={colors.cobalt} />
              )}
              {/* Narrow phones cede the caps label's room to the message so it
                  never chops mid-word; the a11y label above keeps the context. */}
              {!heroNarrow && (
                <Text style={[styles.focusLabel, { color: colors.bodyText }]}>TODAY'S FOCUS</Text>
              )}
              <Text numberOfLines={1} style={[styles.focusValue, { color: colors.navy }]}>
                {focusMessage}
              </Text>
              <Feather name="chevron-right" size={17} color={colors.cobalt} />
            </Pressable>
          </View>
        </View>

        {/* ── Content below the hero ── */}
        <View style={styles.body}>
          {/* ── Day at a glance ── */}
          <LedgerCard accentTop testID="today-glance-card">
            <View style={styles.glanceInner}>
              <View style={styles.glanceHeader}>
                <Text style={[styles.serifTitleSm, { color: colors.navyLight }]}>
                  Your day at a glance
                </Text>
                <View
                  style={[
                    styles.glanceBadge,
                    { backgroundColor: colors.orangeBg, borderColor: colors.orangeBorder },
                  ]}
                >
                  <Text style={[styles.glanceBadgeText, { color: colors.orangeText }]}>
                    {loggedCount} OF 7 LOGGED
                  </Text>
                </View>
              </View>
              <View
                accessibilityLabel={`${loggedCount} of the last 7 days have food logged`}
                style={[styles.streakRow, { borderColor: colors.divider }]}
              >
                {streakDays.map(day => (
                  <View key={day.key} style={styles.streakDay}>
                    <Text style={[styles.streakLetter, { color: colors.subtleText }]}>
                      {day.letter}
                    </Text>
                    <View
                      style={[
                        styles.streakMarkBox,
                        day.selected && { backgroundColor: STREAK_HALO },
                      ]}
                    >
                      <View
                        style={[
                          styles.streakMark,
                          {
                            backgroundColor: day.selected
                              ? colors.cobalt
                              : day.logged
                                ? colors.orange
                                : colors.track,
                          },
                        ]}
                      />
                    </View>
                  </View>
                ))}
              </View>
            </View>
          </LedgerCard>

          {/* ── Program instructions ── */}
          <LedgerCard
            testID="today-instructions-card"
            onPress={() => {
              Haptics.selectionAsync();
              router.push('/instructions');
            }}
            style={styles.rowCard}
          >
            <View style={styles.instructionsRow}>
              <View
                style={[
                  styles.instructionsIcon,
                  { backgroundColor: colors.accent, borderRadius: colors.radiusSm },
                ]}
              >
                <Feather name="book-open" size={17} color={colors.cobalt} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardLabel, { color: colors.labelText }]}>
                  PROGRAM INSTRUCTIONS
                </Text>
                <Text
                  style={[styles.instructionsTitle, { color: colors.navyLight }]}
                  numberOfLines={1}
                >
                  Day {programDay} · {currentPhase.name}
                </Text>
              </View>
              <Feather name="chevron-right" size={17} color={colors.subtleText} />
            </View>
          </LedgerCard>

          <ClaimTestEntryCard />

          {/* ── Calories: dome gauge + macros ── */}
          <LedgerCard style={styles.calorieCard}>
            <View style={styles.calorieHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardLabel, { color: colors.labelText }]}>
                  {isToday ? 'CALORIES FOR TODAY' : 'CALORIES THIS DAY'}
                </Text>
                <Text style={[styles.calorieHeadline, { color: colors.navyLight }]}>
                  {overTarget
                    ? isToday
                      ? "Over today's target."
                      : 'Over target this day.'
                    : 'A well-paced day.'}
                </Text>
              </View>
              <Text style={[styles.caloriePct, { color: colors.bodyText }]}>
                {pctConsumed}% consumed
              </Text>
            </View>

            <View style={styles.gaugeWrap}>
              <Svg width={GAUGE_W} height={GAUGE_H} viewBox={`0 0 ${GAUGE_W} ${GAUGE_H}`}>
                <Path
                  d={GAUGE_ARC}
                  fill="none"
                  stroke={colors.track}
                  strokeWidth={22}
                  strokeLinecap="round"
                />
                {gaugeFrac > 0 && (
                  <Path
                    d={GAUGE_ARC}
                    fill="none"
                    stroke={colors.orange}
                    strokeWidth={22}
                    strokeLinecap="round"
                    strokeDasharray={`${GAUGE_ARC_LEN * gaugeFrac} ${GAUGE_ARC_LEN}`}
                  />
                )}
              </Svg>
              <View style={styles.gaugeCenter}>
                <Text
                  style={[
                    styles.gaugeValue,
                    { color: overTarget ? colors.riskText : colors.navyLight },
                  ]}
                >
                  {Math.abs(remaining).toLocaleString('en-US')}
                </Text>
                <Text
                  style={[
                    styles.gaugeCaption,
                    { color: overTarget ? colors.riskText : colors.labelText },
                  ]}
                >
                  {overTarget ? 'OVER' : 'REMAINING'}
                </Text>
              </View>
            </View>

            <View style={styles.calorieStatsRow}>
              <View style={styles.calorieStat}>
                <Text style={[styles.calorieStatValue, { color: colors.navyLight }]}>
                  {goal.toLocaleString('en-US')}
                </Text>
                <Text style={[styles.calorieStatLabel, { color: colors.subtleText }]}>GOAL</Text>
              </View>
              <View style={[styles.calorieStatDivider, { backgroundColor: colors.divider }]} />
              <View style={styles.calorieStat}>
                <Text style={[styles.calorieStatValue, { color: colors.navyLight }]}>
                  {totals.calories.toLocaleString('en-US')}
                </Text>
                <Text style={[styles.calorieStatLabel, { color: colors.subtleText }]}>FOOD</Text>
              </View>
              <View style={[styles.calorieStatDivider, { backgroundColor: colors.divider }]} />
              <View style={styles.calorieStat}>
                <Text
                  style={[
                    styles.calorieStatValue,
                    { color: overTarget ? colors.riskText : colors.cobalt },
                  ]}
                >
                  {remaining.toLocaleString('en-US')}
                </Text>
                <Text style={[styles.calorieStatLabel, { color: colors.subtleText }]}>LEFT</Text>
              </View>
            </View>

            <View style={[styles.macroBlock, { borderTopColor: colors.divider }]}>
              <MacroBar
                label="Protein"
                value={totals.protein}
                target={patient.targets.protein}
                color={colors.cobalt}
              />
              <MacroBar
                label="Carbs"
                value={totals.carbs}
                target={patient.targets.carbs}
                color={colors.cobaltLight}
              />
              <MacroBar
                label="Fat"
                value={totals.fat}
                target={patient.targets.fat}
                color={colors.orange}
              />
            </View>
          </LedgerCard>

          {/* ── Meals & hydration ── */}
          <Text style={[styles.sectionTitle, { color: colors.navyLight }]}>Meals & hydration</Text>
          <LedgerCard>
            {mealSummaries.map((meal, index) => (
              <View key={meal.slot}>
                {index > 0 && <Divider />}
                <View style={styles.mealRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.mealName, { color: colors.foreground }]}>
                      {MEAL_LABELS[meal.slot]}
                    </Text>
                    <Text style={[styles.mealMeta, { color: colors.subtleText }]}>
                      {meal.count === 0
                        ? 'Nothing logged yet'
                        : `${meal.count} item${meal.count === 1 ? '' : 's'} · ${meal.calories.toLocaleString('en-US')} cal`}
                    </Text>
                  </View>
                  <Pressable
                    testID={`today-add-${meal.slot}`}
                    onPress={() => openLogFood(meal.slot)}
                    style={({ pressed }) => [
                      styles.addBtn,
                      {
                        borderColor: ADD_BTN_BORDER,
                        borderRadius: colors.radiusSm,
                        backgroundColor: pressed ? colors.accent : ADD_BTN_BG,
                      },
                    ]}
                  >
                    <Feather name="plus" size={13} color={colors.cobalt} />
                    <Text style={[styles.addBtnText, { color: colors.cobalt }]}>Add</Text>
                  </Pressable>
                </View>
              </View>
            ))}
            <Divider />
            <View style={styles.waterBlock}>
              <WaterTracker dateKey={dateKey} />
            </View>
          </LedgerCard>

          {/* ── Check-in ── */}
          <LedgerCard style={styles.sectionCard}>
            <Text style={[styles.cardLabel, { color: colors.labelText }]}>DAILY CHECK-IN</Text>
            {dayCheckIn ? (
              <View>
                <View style={styles.checkinDoneRow}>
                  <View
                    style={[
                      styles.checkinDoneIcon,
                      {
                        backgroundColor: colors.activeBg,
                        borderColor: colors.activeBorder,
                        borderRadius: colors.radiusSm,
                      },
                    ]}
                  >
                    <Feather name="check" size={16} color={colors.activeGreen} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.checkinTitle, { color: colors.navyLight }]}>
                      Checked in — feeling {MOOD_LABELS[dayCheckIn.mood].toLowerCase()}
                    </Text>
                    <Text style={[styles.checkinMeta, { color: colors.mutedForeground }]}>
                      {typeof dayCheckIn.weight === 'number'
                        ? `Weight ${dayCheckIn.weight.toFixed(1)} lbs · `
                        : ''}
                      {dayCheckIn.sideEffects.length > 0
                        ? dayCheckIn.sideEffects.join(', ')
                        : 'No side effects'}
                    </Text>
                  </View>
                </View>
                {isToday && (
                  <Pressable
                    testID="today-checkin-update"
                    onPress={() => router.push('/check-in')}
                    style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={[styles.linkText, { color: colors.cobalt }]}>Update check-in</Text>
                    <Feather name="arrow-right" size={13} color={colors.cobalt} />
                  </Pressable>
                )}
              </View>
            ) : isToday ? (
              <View>
                <Text style={[styles.checkinHeadline, { color: colors.navyLight }]}>
                  You haven't checked in today
                </Text>
                <Text style={[styles.checkinBody, { color: colors.mutedForeground }]}>
                  Log your weight, mood, and how the plan feels. It takes 30 seconds.
                </Text>
                <Pressable
                  testID="today-checkin-btn"
                  onPress={() => router.push('/check-in')}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                    pressed && { opacity: 0.88 },
                  ]}
                >
                  <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>
                    Complete Check-In
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View>
                <Text style={[styles.checkinHeadline, { color: colors.navyLight }]}>
                  No check-in recorded
                </Text>
                <Text style={[styles.checkinBody, { color: colors.mutedForeground }]}>
                  Nothing was logged for this day.
                </Text>
              </View>
            )}
          </LedgerCard>

          {/* ── Weight snapshot ── */}
          <LedgerCard style={styles.sectionCard}>
            <View style={styles.weightHeader}>
              <Text style={[styles.serifTitle, { color: colors.navyLight }]}>Weight snapshot</Text>
              <Pressable
                testID="today-view-progress"
                onPress={() => router.push('/progress')}
                hitSlop={6}
                style={({ pressed }) => pressed && { opacity: 0.7 }}
              >
                <Text style={[styles.weightLink, { color: colors.cobalt }]}>
                  View full progress
                </Text>
              </Pressable>
            </View>
            <View style={styles.weightRow}>
              <View style={styles.weightCol}>
                <Text style={[styles.weightValue, { color: colors.foreground }]}>
                  {currentWeight.toFixed(1)} lb
                </Text>
                <Text style={[styles.weightLabel, { color: colors.subtleText }]}>CURRENT</Text>
              </View>
              <View style={[styles.weightDivider, { backgroundColor: colors.divider }]} />
              <View style={styles.weightCol}>
                <Text style={[styles.weightValue, { color: colors.cobalt }]}>
                  {lost >= 0 ? '−' : '+'}
                  {Math.abs(lost).toFixed(1)} lb
                </Text>
                <Text style={[styles.weightLabel, { color: colors.subtleText }]}>TOTAL</Text>
              </View>
              <View style={[styles.weightDivider, { backgroundColor: colors.divider }]} />
              <View style={styles.weightCol}>
                <Text style={[styles.weightValue, { color: colors.foreground }]}>
                  {PATIENT_PROFILE.goalWeight.toFixed(0)} lb
                </Text>
                <Text style={[styles.weightLabel, { color: colors.subtleText }]}>GOAL</Text>
              </View>
            </View>
          </LedgerCard>

          <SyntheticDisclaimer />
        </View>
      </ScrollView>

      {/* ── Undo for a "Yesterday's [meal]" batch logged via Add Food ── */}
      {loggedNotice && (
        <Snackbar
          testID="today-logged-snackbar"
          message={`Logged ${loggedNotice.entries.length} item${loggedNotice.entries.length === 1 ? '' : 's'} to ${MEAL_LABELS[loggedNotice.meal]}`}
          actionLabel="UNDO"
          actionTestID="today-logged-undo"
          onAction={() => {
            if (!loggedNotice) return;
            setLoggedNotice(null);
            // Remove exactly the ids the review's confirm created, in one
            // batched commit — same mechanics as the diary's copy Undo.
            void patient.removeEntries(loggedNotice.entries.map(e => e.id));
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // ── Hero ──
  heroImage: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  heroWash: {
    // react-native-web deprecates the pointerEvents *prop*; use the style key.
    pointerEvents: 'none',
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  heroContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wordmark: {
    fontSize: 25,
    fontFamily: fonts.serifBold,
    letterSpacing: 3.75,
  },
  heroActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatar: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
  heroDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  dateArrow: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroDateStrip: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  heroDateText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  heroGreeting: {
    fontSize: 29,
    lineHeight: 32,
    fontFamily: fonts.serif,
    marginTop: 12,
  },
  jumpToday: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  jumpTodayText: {
    fontSize: 11.5,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
    textDecorationLine: 'underline',
  },
  // ── Hero quick-link chips ──
  chipRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  chip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    boxShadow: '0 5px 12px rgba(35, 61, 95, 0.10)',
  },
  chipText: {
    flex: 1,
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  // Narrow-width variants: "Restaurant guide" needs ~96px of text run, which
  // a 358px screen only affords once the gutters tighten; below 350 even that
  // fails, so the chips stack full-width instead of ellipsizing. Neither
  // variant renders at ≥390.
  chipRowSnug: {
    gap: 6,
  },
  chipRowStacked: {
    flexDirection: 'column',
  },
  chipSnug: {
    paddingHorizontal: 8,
    gap: 6,
  },
  chipStacked: {
    flex: 0,
  },
  // ── Floating focus bar ──
  focusWrap: {
    pointerEvents: 'box-none',
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 0,
  },
  focusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    boxShadow: '0 9px 19px rgba(34, 58, 88, 0.16)',
  },
  focusLabel: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 1.1,
  },
  focusValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 17,
    fontFamily: fonts.serif,
  },
  // ── Body ──
  body: {
    paddingHorizontal: 20,
    paddingTop: 32,
  },
  serifTitle: {
    fontSize: 21,
    fontFamily: fonts.serif,
  },
  serifTitleSm: {
    fontSize: 19,
    fontFamily: fonts.serif,
  },
  sectionTitle: {
    fontSize: 21,
    fontFamily: fonts.serif,
    marginTop: 20,
    marginBottom: 8,
    marginLeft: 4,
  },
  cardLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    fontFamily: fonts.sansBold,
  },
  // ── Day at a glance ──
  glanceInner: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
  },
  glanceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  glanceBadge: {
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  glanceBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 0.5,
  },
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  streakDay: {
    alignItems: 'center',
    gap: 4,
  },
  streakLetter: {
    fontSize: 10,
    fontFamily: fonts.sans,
  },
  streakMarkBox: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakMark: {
    width: 8,
    height: 8,
  },
  // ── Program instructions ──
  rowCard: {
    marginTop: 16,
  },
  instructionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  instructionsIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instructionsTitle: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
    marginTop: 2,
  },
  // ── Calories ──
  calorieCard: {
    marginTop: 16,
    padding: 16,
  },
  calorieHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  calorieHeadline: {
    fontSize: 21,
    fontFamily: fonts.serif,
    marginTop: 4,
  },
  caloriePct: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
    marginTop: 2,
  },
  gaugeWrap: {
    alignSelf: 'center',
    width: GAUGE_W,
    height: GAUGE_H,
    marginTop: 12,
  },
  gaugeCenter: {
    pointerEvents: 'none',
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 4,
    alignItems: 'center',
  },
  gaugeValue: {
    fontSize: 46,
    lineHeight: 48,
    fontFamily: fonts.serif,
  },
  gaugeCaption: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 1.3,
    marginTop: 4,
  },
  calorieStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  calorieStat: {
    flex: 1,
    alignItems: 'center',
  },
  calorieStatValue: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  calorieStatLabel: {
    fontSize: 8,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 0.8,
    marginTop: 2,
  },
  calorieStatDivider: {
    width: 1,
    height: 28,
  },
  macroBlock: {
    borderTopWidth: 1,
    marginTop: 16,
    paddingTop: 12,
    gap: 12,
  },
  // ── Meals & hydration ──
  mealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  mealName: {
    fontSize: 17,
    fontFamily: fonts.serif,
  },
  mealMeta: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: fonts.sans,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  addBtnText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
  waterBlock: {
    padding: 16,
  },
  // ── Check-in ──
  sectionCard: {
    marginTop: 20,
    padding: 16,
  },
  checkinDoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 10,
  },
  checkinDoneIcon: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkinTitle: {
    fontSize: 18,
    fontFamily: fonts.serif,
  },
  checkinMeta: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: fonts.sans,
  },
  checkinHeadline: {
    fontSize: 20,
    fontFamily: fonts.serif,
    marginTop: 4,
  },
  checkinBody: {
    fontSize: 12,
    lineHeight: 20,
    marginTop: 4,
    fontFamily: fonts.sans,
  },
  primaryBtn: {
    marginTop: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
    letterSpacing: 0.3,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
  },
  linkText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: fonts.sansSemiBold,
  },
  // ── Weight snapshot ──
  weightHeader: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 10,
  },
  weightLink: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: fonts.sansBold,
  },
  weightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  weightCol: {
    flex: 1,
    alignItems: 'center',
  },
  weightValue: {
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.5,
    fontFamily: fonts.sansSemiBold,
  },
  weightLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.8,
    fontFamily: fonts.sansBold,
    marginTop: 3,
  },
  weightDivider: {
    width: 1,
    height: 34,
  },
});
