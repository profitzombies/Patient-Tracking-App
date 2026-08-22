/**
 * Today — the patient home screen. Opens with a full-bleed illustrated food
 * hero (THINNR wordmark, date paging, greeting, floating check-in prompt),
 * followed by calories remaining, macros, meals, water, daily check-in
 * status, and a weight snapshot for the selected day.
 */
import React, { useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { MacroBar } from '@/components/patient/MacroBar';
import { WaterTracker } from '@/components/patient/WaterTracker';
import { Divider, LedgerCard, ProgressBar, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
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
  type MealSlot,
} from '@/data/patient-data';
import { phaseForDay } from '@/data/program-instructions';

// Earliest day the demo history covers — date paging stops here.
const MIN_KEY = toDateKey(subDays(TODAY, SEED_DAYS));

const FIRST_NAME = PATIENT_PROFILE.name.split(' ')[0];

// Where the patient is in the THINNR protocol — drives the instructions card.
const CURRENT_PHASE = phaseForDay(ENROLLMENT_DAYS);

// How far the check-in pill hangs below the hero artwork.
const PILL_OVERLAP = 22;

// Pale halo behind the hero type for legibility over the artwork. Web uses
// the CSS-style shorthand to avoid react-native-web's textShadow* deprecation.
const TEXT_HALO: TextStyle =
  Platform.OS === 'web'
    ? ({ textShadow: '0 0 10px rgba(240,244,250,0.9)' } as unknown as TextStyle)
    : {
        textShadowColor: 'rgba(240,244,250,0.9)',
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: 10,
      };

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

// One short prompt per day, picked deterministically from the anchored date
// (never the device clock) so the demo stays reproducible.
const CHECKIN_PROMPTS = [
  'How are you feeling today?',
  'Any side effects to note?',
  'Getting enough sleep?',
  "How's your energy today?",
];
const CHECKIN_PROMPT = CHECKIN_PROMPTS[Number(TODAY_KEY.slice(8, 10)) % CHECKIN_PROMPTS.length];

export default function TodayScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const [dateKey, setDateKey] = useState(TODAY_KEY);

  // The hero extends behind the status bar; the web preview reserves the same
  // fake-chrome space as PatientHeader did.
  const heroTopPad = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const heroHeight = heroTopPad + 296;
  const bottomPad = Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20;

  const isToday = dateKey === TODAY_KEY;
  const atMin = dateKey <= MIN_KEY;

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

  const remaining = patient.targets.calories - totals.calories;
  const dayCheckIn = patient.checkInFor(dateKey);
  const todayCheckIn = patient.checkInFor(TODAY_KEY);
  const currentWeight = patient.weightSeries.at(-1)?.weight ?? PATIENT_PROFILE.currentWeight;
  const lost = PATIENT_PROFILE.startingWeight - currentWeight;

  const openLogFood = (meal: MealSlot) => {
    router.push({ pathname: '/log-food', params: { date: dateKey, meal } });
  };

  const openCheckIn = () => {
    Haptics.selectionAsync();
    router.push('/check-in');
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottomPad }}>
        {/* ── Illustrated hero ── */}
        <View style={{ height: heroHeight + PILL_OVERLAP }}>
          <Image
            source={HOME_HERO_IMAGE}
            style={[styles.heroImage, { height: heroHeight }]}
            contentFit="cover"
            contentPosition="top center"
            transition={200}
          />
          {/* Soft scrim so the overlaid type stays legible over the artwork */}
          <LinearGradient
            colors={[
              'rgba(237,242,249,0.96)',
              'rgba(237,242,249,0.74)',
              'rgba(237,242,249,0.32)',
              'rgba(237,242,249,0)',
            ]}
            locations={[0, 0.45, 0.75, 1]}
            style={[styles.heroTopScrim, { height: heroTopPad + 205 }]}
            pointerEvents="none"
          />
          <LinearGradient
            colors={['rgba(238,241,246,0)', 'rgba(238,241,246,0.45)']}
            style={[styles.heroBottomScrim, { bottom: PILL_OVERLAP }]}
            pointerEvents="none"
          />

          <View style={[styles.heroContent, { paddingTop: heroTopPad + 8 }]}>
            <View style={styles.heroTopRow}>
              <Text style={[styles.wordmark, TEXT_HALO, { color: colors.navy }]}>THINNR</Text>
              <Pressable
                testID="patient-avatar-btn"
                onPress={() => {
                  Haptics.selectionAsync();
                  router.push('/persona');
                }}
                style={({ pressed }) => [
                  styles.avatar,
                  { backgroundColor: colors.cobalt },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.avatarText, { color: colors.primaryForeground }]}>ES</Text>
              </Pressable>
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
                <Feather name="arrow-left" size={18} color={colors.navy} />
              </Pressable>
              <Text style={[styles.heroDate, TEXT_HALO, { color: colors.navy }]}>
                {formatHeroDate(dateKey)}
              </Text>
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
                <Feather name="arrow-right" size={18} color={colors.navy} />
              </Pressable>
            </View>

            <Text style={[styles.heroGreeting, TEXT_HALO, { color: colors.navy }]}>
              Welcome back, {FIRST_NAME}
            </Text>
            {!isToday && (
              <Pressable
                testID="today-jump-today"
                onPress={() => setDateKey(TODAY_KEY)}
                hitSlop={6}
                style={({ pressed }) => [styles.jumpToday, pressed && { opacity: 0.7 }]}
              >
                <Text style={[styles.jumpTodayText, { color: colors.navyLight }]}>
                  Viewing an earlier day — jump to today
                </Text>
              </Pressable>
            )}
          </View>

          {/* ── Floating check-in prompt ── */}
          <View style={styles.pillWrap} pointerEvents="box-none">
            <Pressable
              testID="today-checkin-pill"
              onPress={openCheckIn}
              style={({ pressed }) => [
                styles.pill,
                todayCheckIn
                  ? { backgroundColor: 'rgba(251,252,255,0.95)', borderColor: colors.activeBorder }
                  : { backgroundColor: 'rgba(23,44,86,0.86)', borderColor: 'rgba(251,252,255,0.3)' },
                pressed && { opacity: 0.88 },
              ]}
            >
              <View
                style={[
                  styles.pillIcon,
                  { backgroundColor: todayCheckIn ? colors.activeBg : 'rgba(251,252,255,0.22)' },
                ]}
              >
                <Feather
                  name={todayCheckIn ? 'check' : 'message-circle'}
                  size={13}
                  color={todayCheckIn ? colors.activeGreen : '#fbfcff'}
                />
              </View>
              <Text
                numberOfLines={1}
                style={[styles.pillText, { color: todayCheckIn ? colors.navyLight : '#fbfcff' }]}
              >
                {todayCheckIn
                  ? `Checked in — feeling ${MOOD_LABELS[todayCheckIn.mood].toLowerCase()}`
                  : CHECKIN_PROMPT}
              </Text>
              <Feather
                name="chevron-right"
                size={14}
                color={todayCheckIn ? colors.subtleText : 'rgba(251,252,255,0.8)'}
              />
            </Pressable>
          </View>
        </View>

        {/* ── Content below the hero ── */}
        <View style={styles.body}>
          {/* ── Program instructions ── */}
          <LedgerCard
            testID="today-instructions-card"
            onPress={() => {
              Haptics.selectionAsync();
              router.push('/instructions');
            }}
            style={styles.card}
          >
            <View style={styles.instructionsRow}>
              <View style={[styles.instructionsIcon, { backgroundColor: colors.sidebarBg }]}>
                <Feather name="book-open" size={15} color={colors.cobalt} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardLabel, { color: colors.labelText }]}>PROGRAM INSTRUCTIONS</Text>
                <Text
                  style={[styles.instructionsTitle, { color: colors.navyLight }]}
                  numberOfLines={1}
                >
                  Day {ENROLLMENT_DAYS} · {CURRENT_PHASE.name}
                </Text>
              </View>
              <Feather name="chevron-right" size={16} color={colors.subtleText} />
            </View>
          </LedgerCard>

          {/* ── Calories ── */}
          <LedgerCard style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.labelText }]}>CALORIES REMAINING</Text>
            <View style={styles.calorieRow}>
              <Text style={[styles.calorieBig, { color: remaining < 0 ? colors.riskText : colors.navy }]}>
                {remaining.toLocaleString('en-US')}
              </Text>
              <View style={styles.calorieMathBlock}>
                <View style={styles.calorieMathRow}>
                  <Text style={[styles.calorieMathValue, { color: colors.navyLight }]}>
                    {patient.targets.calories.toLocaleString('en-US')}
                  </Text>
                  <Text style={[styles.calorieMathLabel, { color: colors.labelText }]}>GOAL</Text>
                </View>
                <Text style={[styles.calorieMathOp, { color: colors.subtleText }]}>−</Text>
                <View style={styles.calorieMathRow}>
                  <Text style={[styles.calorieMathValue, { color: colors.navyLight }]}>
                    {totals.calories.toLocaleString('en-US')}
                  </Text>
                  <Text style={[styles.calorieMathLabel, { color: colors.labelText }]}>FOOD</Text>
                </View>
              </View>
            </View>
            <ProgressBar
              value={(totals.calories / Math.max(1, patient.targets.calories)) * 100}
              style={{ marginTop: 12 }}
            />
            <Text style={[styles.calorieHint, { color: colors.subtleText }]}>
              {isToday
                ? remaining >= 0
                  ? `${remaining.toLocaleString('en-US')} cal left for dinner and snacks`
                  : `${Math.abs(remaining).toLocaleString('en-US')} cal over target — tomorrow is a reset`
                : remaining >= 0
                  ? `Finished ${remaining.toLocaleString('en-US')} cal under target this day`
                  : `${Math.abs(remaining).toLocaleString('en-US')} cal over target this day`}
            </Text>
          </LedgerCard>

          {/* ── Macros ── */}
          <LedgerCard style={styles.card}>
            <Text style={[styles.cardLabel, { color: colors.labelText }]}>MACROS</Text>
            <View style={{ gap: 12, marginTop: 12 }}>
              <MacroBar label="Protein" value={totals.protein} target={patient.targets.protein} color={colors.cobalt} />
              <MacroBar label="Carbs" value={totals.carbs} target={patient.targets.carbs} color={colors.cobaltLight} />
              <MacroBar label="Fat" value={totals.fat} target={patient.targets.fat} color={colors.cobaltMuted} />
            </View>
          </LedgerCard>

          {/* ── Meals ── */}
          <SectionHeader label="Meals" style={styles.sectionHeader} />
          <LedgerCard>
            {mealSummaries.map((meal, index) => (
              <View key={meal.slot}>
                {index > 0 && <Divider />}
                <View style={styles.mealRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.mealName, { color: colors.navyLight }]}>{MEAL_LABELS[meal.slot]}</Text>
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
                      { borderColor: colors.border, backgroundColor: pressed ? colors.accent : colors.card },
                    ]}
                  >
                    <Feather name="plus" size={13} color={colors.cobalt} />
                    <Text style={[styles.addBtnText, { color: colors.cobalt }]}>Add</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </LedgerCard>

          {/* ── Water ── */}
          <SectionHeader label="Water" style={styles.sectionHeader} />
          <LedgerCard style={{ padding: 16 }}>
            <WaterTracker dateKey={dateKey} />
          </LedgerCard>

          {/* ── Check-in ── */}
          <SectionHeader label="Daily Check-In" style={styles.sectionHeader} />
          <LedgerCard style={{ padding: 16 }}>
            {dayCheckIn ? (
              <View>
                <View style={styles.checkinDoneRow}>
                  <View style={[styles.checkinDoneIcon, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                    <Feather name="check" size={16} color={colors.activeGreen} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.checkinTitle, { color: colors.navyLight }]}>
                      Checked in — feeling {MOOD_LABELS[dayCheckIn.mood].toLowerCase()}
                    </Text>
                    <Text style={[styles.checkinMeta, { color: colors.subtleText }]}>
                      {typeof dayCheckIn.weight === 'number' ? `Weight ${dayCheckIn.weight.toFixed(1)} lbs · ` : ''}
                      {dayCheckIn.sideEffects.length > 0 ? dayCheckIn.sideEffects.join(', ') : 'No side effects'}
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
                <Text style={[styles.checkinTitle, { color: colors.navyLight }]}>You haven't checked in today</Text>
                <Text style={[styles.checkinMeta, { color: colors.subtleText, marginTop: 3 }]}>
                  Log your weight, mood, and how the plan feels. It takes 30 seconds.
                </Text>
                <Pressable
                  testID="today-checkin-btn"
                  onPress={() => router.push('/check-in')}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    { backgroundColor: colors.cobalt },
                    pressed && { opacity: 0.88 },
                  ]}
                >
                  <Text style={[styles.primaryBtnText, { color: colors.primaryForeground }]}>Complete Check-In</Text>
                </Pressable>
              </View>
            ) : (
              <View>
                <Text style={[styles.checkinTitle, { color: colors.navyLight }]}>No check-in recorded</Text>
                <Text style={[styles.checkinMeta, { color: colors.subtleText, marginTop: 3 }]}>
                  Nothing was logged for this day.
                </Text>
              </View>
            )}
          </LedgerCard>

          {/* ── Weight snapshot ── */}
          <SectionHeader label="Weight" style={styles.sectionHeader} />
          <LedgerCard style={{ padding: 16 }}>
            <View style={styles.weightRow}>
              <View style={styles.weightCol}>
                <Text style={[styles.weightValue, { color: colors.navy }]}>{currentWeight.toFixed(1)}</Text>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>CURRENT LBS</Text>
              </View>
              <View style={styles.weightCol}>
                <Text style={[styles.weightValue, { color: colors.cobalt }]}>−{lost.toFixed(1)}</Text>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>SINCE START</Text>
              </View>
              <View style={styles.weightCol}>
                <Text style={[styles.weightValue, { color: colors.navyLight }]}>{PATIENT_PROFILE.goalWeight.toFixed(0)}</Text>
                <Text style={[styles.weightLabel, { color: colors.labelText }]}>GOAL LBS</Text>
              </View>
            </View>
            <Pressable
              testID="today-view-progress"
              onPress={() => router.push('/progress')}
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
            >
              <Text style={[styles.linkText, { color: colors.cobalt }]}>View full progress</Text>
              <Feather name="arrow-right" size={13} color={colors.cobalt} />
            </Pressable>
          </LedgerCard>

          <SyntheticDisclaimer />
        </View>
      </ScrollView>
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
  heroTopScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  heroBottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 56,
  },
  heroContent: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  wordmark: {
    fontSize: 25,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 2.5,
  },
  avatar: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
  },
  heroDateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 10,
  },
  dateArrow: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroDate: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.2,
  },
  heroGreeting: {
    fontSize: 25,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    letterSpacing: -0.2,
    marginTop: 8,
  },
  jumpToday: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  jumpTodayText: {
    fontSize: 11.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    textDecorationLine: 'underline',
  },
  // ── Check-in pill ──
  pillWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '86%',
    borderRadius: 999,
    borderWidth: 1,
    paddingVertical: 9,
    paddingHorizontal: 12,
    ...Platform.select({
      web: { boxShadow: '0 6px 14px rgba(23,44,86,0.22)' },
      default: {
        shadowColor: '#172c56',
        shadowOpacity: 0.2,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 6,
      },
    }),
  },
  pillIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    flexShrink: 1,
  },
  // ── Body ──
  body: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  card: {
    padding: 16,
    marginBottom: 14,
  },
  cardLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  sectionHeader: {
    marginBottom: 8,
    marginTop: 4,
  },
  instructionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  instructionsIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instructionsTitle: {
    fontSize: 13.5,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
    marginTop: 3,
  },
  calorieRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  calorieBig: {
    fontSize: 40,
    fontWeight: '600',
    letterSpacing: -2,
    fontFamily: 'Inter_600SemiBold',
  },
  calorieMathBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 8,
  },
  calorieMathRow: {
    alignItems: 'flex-end',
  },
  calorieMathValue: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  calorieMathLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginTop: 2,
  },
  calorieMathOp: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
  },
  calorieHint: {
    fontSize: 11,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
  mealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  mealName: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  mealMeta: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
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
    fontFamily: 'Inter_700Bold',
  },
  checkinDoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  checkinDoneIcon: {
    width: 34,
    height: 34,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkinTitle: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'Inter_600SemiBold',
  },
  checkinMeta: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  primaryBtn: {
    marginTop: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'Inter_700Bold',
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
    fontFamily: 'Inter_600SemiBold',
  },
  weightRow: {
    flexDirection: 'row',
  },
  weightCol: {
    flex: 1,
  },
  weightValue: {
    fontSize: 22,
    fontWeight: '600',
    letterSpacing: -0.8,
    fontFamily: 'Inter_600SemiBold',
  },
  weightLabel: {
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 1,
    fontFamily: 'Inter_700Bold',
    marginTop: 3,
  },
});
