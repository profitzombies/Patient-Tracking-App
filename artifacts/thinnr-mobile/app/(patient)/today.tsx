/**
 * Today — the patient home screen. Calories remaining, macros, meals,
 * water, daily check-in status, and a weight snapshot.
 */
import React, { useMemo } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { PatientHeader } from '@/components/patient/PatientHeader';
import { MacroBar } from '@/components/patient/MacroBar';
import { WaterTracker } from '@/components/patient/WaterTracker';
import { Divider, LedgerCard, ProgressBar, SectionHeader } from '@/components/ui/LedgerPrimitives';
import { SyntheticDisclaimer } from '@/components/ui/ScreenHeader';
import { usePatient } from '@/context/PatientContext';
import {
  MEAL_LABELS,
  MEAL_SLOTS,
  MOOD_LABELS,
  PATIENT_PROFILE,
  TODAY,
  TODAY_KEY,
  type MealSlot,
} from '@/data/patient-data';

const todayLabel = TODAY.toLocaleDateString('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

export default function TodayScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();

  const bottomPad = Platform.OS === 'web' ? 84 + 20 : insets.bottom + 84 + 20;

  const entries = patient.entriesForDate(TODAY_KEY);
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
  const todayCheckIn = patient.checkInFor(TODAY_KEY);
  const currentWeight = patient.weightSeries.at(-1)?.weight ?? PATIENT_PROFILE.currentWeight;
  const lost = PATIENT_PROFILE.startingWeight - currentWeight;

  const openLogFood = (meal: MealSlot) => {
    router.push({ pathname: '/log-food', params: { date: TODAY_KEY, meal } });
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <PatientHeader title="Today" subtitle={todayLabel.toUpperCase()} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
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
            {remaining >= 0
              ? `${remaining.toLocaleString('en-US')} cal left for dinner and snacks`
              : `${Math.abs(remaining).toLocaleString('en-US')} cal over target — tomorrow is a reset`}
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
          <WaterTracker dateKey={TODAY_KEY} />
        </LedgerCard>

        {/* ── Check-in ── */}
        <SectionHeader label="Daily Check-In" style={styles.sectionHeader} />
        <LedgerCard style={{ padding: 16 }}>
          {todayCheckIn ? (
            <View>
              <View style={styles.checkinDoneRow}>
                <View style={[styles.checkinDoneIcon, { backgroundColor: colors.activeBg, borderColor: colors.activeBorder }]}>
                  <Feather name="check" size={16} color={colors.activeGreen} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.checkinTitle, { color: colors.navyLight }]}>Checked in — feeling {MOOD_LABELS[todayCheckIn.mood].toLowerCase()}</Text>
                  <Text style={[styles.checkinMeta, { color: colors.subtleText }]}>
                    {typeof todayCheckIn.weight === 'number' ? `Weight ${todayCheckIn.weight.toFixed(1)} lbs · ` : ''}
                    {todayCheckIn.sideEffects.length > 0 ? todayCheckIn.sideEffects.join(', ') : 'No side effects'}
                  </Text>
                </View>
              </View>
              <Pressable
                testID="today-checkin-update"
                onPress={() => router.push('/check-in')}
                style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.7 }]}
              >
                <Text style={[styles.linkText, { color: colors.cobalt }]}>Update check-in</Text>
                <Feather name="arrow-right" size={13} color={colors.cobalt} />
              </Pressable>
            </View>
          ) : (
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
      </ScrollView>
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
