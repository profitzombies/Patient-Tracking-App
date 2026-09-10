/**
 * Daily Check-In — weight, mood, side effects, and a note for the care team.
 * Saving replaces any earlier check-in for the same day.
 * Heritage language: paper header with serif title, radius-7 form controls,
 * cobalt selection states and primary action.
 */
import React, { useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { OrdinaryTextInput as TextInput } from '@/components/ui/OrdinaryTextInput';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, router, type Href } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { createGuidedPhotoRequest } from '@/lib/guided-photos';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { TodaysMedicationsCard } from '@/components/patient/TodaysMedicationsCard';
import { useAppMode } from '@/context/AppModeContext';
import { usePatient } from '@/context/PatientContext';
import {
  MOOD_LABELS,
  PATIENT_PROFILE,
  SIDE_EFFECT_OPTIONS,
} from '@/data/patient-data';

const MOODS = [1, 2, 3, 4, 5] as const;

export default function CheckInScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const patient = usePatient();
  const { mode, hydrated: modeHydrated } = useAppMode();

  // Canonical today: the demo anchor for the demo persona, the device's
  // local day for a signed-in patient (rolls over at local midnight).
  const todayKey = patient.todayKey;
  const todayLabel = new Date(`${todayKey}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const existing = patient.checkInFor(todayKey);

  // Hands-free guided photo session — the outcome resolves when the
  // session settles, so the announcement lands back on this screen.
  const openGuidedPhotos = () => {
    const outcome = createGuidedPhotoRequest();
    router.push('/guided-photos');
    void outcome.then(result => {
      if (result && result.savedCount > 0) {
        AccessibilityInfo.announceForAccessibility(
          result.savedCount === 1
            ? '1 progress photo saved.'
            : `${result.savedCount} progress photos saved.`,
        );
      }
    });
  };
  const lastWeight = patient.weightSeries.at(-1)?.weight ?? PATIENT_PROFILE.currentWeight;

  const [weightStr, setWeightStr] = useState(
    typeof existing?.weight === 'number' ? existing.weight.toFixed(1) : lastWeight.toFixed(1),
  );
  const [mood, setMood] = useState<1 | 2 | 3 | 4 | 5>(existing?.mood ?? 4);
  const [sideEffects, setSideEffects] = useState<string[]>(existing?.sideEffects ?? []);
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const topPad = Math.max(insets.top, Platform.OS === 'web' ? 24 : 12);
  const bottomPad = Platform.OS === 'web' ? 32 : insets.bottom + 24;

  // Patient-only route: deep links must not bypass the persona flow.
  if (!modeHydrated) return null;
  if (mode !== 'patient') {
    return <Redirect href={mode === 'staff' ? '/' : '/persona'} />;
  }

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/today');
  };

  const toggleSideEffect = (option: string) => {
    setSideEffects(current =>
      current.includes(option) ? current.filter(o => o !== option) : [...current, option],
    );
  };

  const save = async () => {
    if (saving) return;
    const trimmed = weightStr.trim();
    let weight: number | undefined;
    if (trimmed !== '') {
      const parsed = parseFloat(trimmed.replace(',', '.'));
      if (!Number.isFinite(parsed) || parsed < 80 || parsed > 400) {
        setError('Weight should be a number between 80 and 400 lbs (or leave it blank).');
        return;
      }
      weight = Math.round(parsed * 10) / 10;
    }
    setError('');
    setSaving(true);
    try {
      const saved = await patient.addCheckIn({
        dateKey: todayKey,
        weight,
        mood,
        sideEffects,
        notes: notes.trim() || undefined,
      });
      // A failed account write rolled back (and posted a sync notice):
      // keep the filled-in form on screen so a retry is one tap away.
      if (saved) goBack();
      else setError('Your check-in could not be saved — please try again.');
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
          { paddingTop: topPad, backgroundColor: colors.paperCardAlt, borderBottomColor: colors.border },
        ]}
      >
        <Pressable testID="checkin-cancel" onPress={goBack} hitSlop={8}>
          <Text style={[styles.headerAction, { color: colors.cobalt }]}>Cancel</Text>
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.navy }]}>Daily Check-In</Text>
          <Text style={[styles.headerSub, { color: colors.subtleText }]}>{todayLabel}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <KeyboardAwareScrollViewCompat contentContainerStyle={[styles.content, { paddingBottom: bottomPad }]}>
        {existing && (
          <View
            style={[
              styles.updateNote,
              { backgroundColor: colors.sidebarBg, borderColor: colors.border, borderRadius: colors.radiusSm },
            ]}
          >
            <Text style={[styles.updateNoteText, { color: colors.bodyText }]}>
              You already checked in today — saving will update it.
            </Text>
          </View>
        )}

        {/* ── Today's medications (real accounts with a medication list) ── */}
        <TodaysMedicationsCard />

        {/* ── Weight ── */}
        <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>TODAY'S WEIGHT</Text>
          <View style={styles.weightRow}>
            <TextInput
              testID="checkin-weight"
              value={weightStr}
              onChangeText={setWeightStr}
              placeholder={lastWeight.toFixed(1)}
              placeholderTextColor={colors.subtleText}
              keyboardType={Platform.OS === 'web' ? undefined : 'decimal-pad'}
              style={[
                styles.weightInput,
                {
                  borderColor: colors.border,
                  color: colors.navy,
                  backgroundColor: colors.background,
                  borderRadius: colors.radiusSm,
                },
              ]}
            />
            <Text style={[styles.weightUnit, { color: colors.subtleText }]}>lbs</Text>
          </View>
          <Text style={[styles.fieldHint, { color: colors.subtleText }]}>
            Last recorded: {lastWeight.toFixed(1)} lbs · leave blank to skip
          </Text>
        </LedgerCard>

        {/* ── Coach awareness (stall nudge) ──
            Mirrors the coach's proactive outreach while the trigger is
            active: a supportive note beside the weigh-in with a door into
            the same conversation, never a separate nagging channel.
            Stop-on-engagement outranks everything: once the patient has
            answered this episode, the check-in stays silent — even the
            paused/resume row waits until the episode is over. */}
        {patient.nudgeAssessment.active && patient.nudgeEngaged ? null : patient.nudgeOptOut ? (
          <View style={styles.nudgePausedRow}>
            <Text style={[styles.nudgePausedText, { color: colors.subtleText }]}>
              Coach check-ins are paused.
            </Text>
            <Pressable
              testID="checkin-nudge-resume"
              accessibilityRole="button"
              onPress={() => void patient.setNudgeOptOut(false)}
              hitSlop={8}
            >
              <Text style={[styles.nudgeAction, { color: colors.cobalt }]}>Resume</Text>
            </Pressable>
          </View>
        ) : patient.nudgeAssessment.active && !patient.nudgeEngaged ? (
          <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
            <Text style={[styles.fieldLabel, { color: colors.labelText }]}>FROM YOUR COACH</Text>
            <Text style={[styles.nudgeNoteText, { color: colors.bodyText }]}>
              Your weight has been holding steady for about three weeks while a few off-plan
              items found their way into the diary. That happens, and it turns around fast.
              Your coach has a back-on-track plan ready when you are.
            </Text>
            <View style={styles.nudgeActionsRow}>
              <Pressable
                testID="checkin-nudge-open-chat"
                accessibilityRole="button"
                onPress={() => router.push('/coach-history' as Href)}
                style={({ pressed }) => [
                  styles.nudgeChatBtn,
                  { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={[styles.nudgeChatBtnText, { color: colors.primaryForeground }]}>
                  Open Coach Chat
                </Text>
              </Pressable>
              <Pressable
                testID="checkin-nudge-off"
                accessibilityRole="button"
                onPress={() => void patient.setNudgeOptOut(true)}
                hitSlop={8}
              >
                <Text style={[styles.nudgeAction, { color: colors.subtleText }]}>
                  Turn these off
                </Text>
              </Pressable>
            </View>
          </LedgerCard>
        ) : null}

        {/* ── Mood ── */}
        <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>HOW ARE YOU FEELING?</Text>
          <View style={styles.moodRow}>
            {MOODS.map(value => {
              const isSelected = mood === value;
              return (
                <Pressable
                  key={value}
                  testID={`checkin-mood-${value}`}
                  onPress={() => setMood(value)}
                  style={({ pressed }) => [
                    styles.moodCell,
                    {
                      borderRadius: colors.radiusSm,
                      borderColor: isSelected ? colors.cobalt : colors.border,
                      backgroundColor: isSelected ? colors.cobalt : pressed ? colors.accent : colors.card,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.moodValue,
                      { color: isSelected ? colors.primaryForeground : colors.navyLight },
                    ]}
                  >
                    {value}
                  </Text>
                  <Text
                    style={[
                      styles.moodLabel,
                      { color: isSelected ? colors.primaryForeground : colors.subtleText },
                    ]}
                    numberOfLines={1}
                  >
                    {MOOD_LABELS[value]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </LedgerCard>

        {/* ── Side effects ── */}
        <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>ANY SIDE EFFECTS?</Text>
          <View style={styles.chipWrap}>
            {SIDE_EFFECT_OPTIONS.map(option => {
              const isOn = sideEffects.includes(option);
              return (
                <Pressable
                  key={option}
                  testID={`checkin-se-${option.toLowerCase()}`}
                  onPress={() => toggleSideEffect(option)}
                  style={({ pressed }) => [
                    styles.chip,
                    {
                      borderRadius: colors.radiusSm,
                      borderColor: isOn ? colors.cobalt : colors.border,
                      backgroundColor: isOn ? colors.cobalt : pressed ? colors.accent : colors.card,
                    },
                  ]}
                >
                  <Text style={[styles.chipText, { color: isOn ? colors.primaryForeground : colors.bodyText }]}>
                    {option}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.fieldHint, { color: colors.subtleText }]}>
            {sideEffects.length === 0 ? 'None selected — feeling good.' : `${sideEffects.length} selected · your care team will see this`}
          </Text>
        </LedgerCard>

        {/* ── Notes ── */}
        <LedgerCard style={{ padding: 16, marginBottom: 14 }}>
          <Text style={[styles.fieldLabel, { color: colors.labelText }]}>NOTE FOR YOUR CARE TEAM</Text>
          <TextInput
            testID="checkin-notes"
            value={notes}
            onChangeText={setNotes}
            placeholder="Optional — energy, appetite, anything worth flagging..."
            placeholderTextColor={colors.subtleText}
            multiline
            numberOfLines={3}
            style={[
              styles.notesInput,
              {
                borderColor: colors.border,
                color: colors.foreground,
                backgroundColor: colors.background,
                borderRadius: colors.radiusSm,
              },
            ]}
          />
        </LedgerCard>

        {/* ── Guided progress photos ── */}
        <Pressable
          testID="checkin-guided-photos"
          accessibilityRole="button"
          accessibilityLabel="Add progress photos with a guided session"
          onPress={openGuidedPhotos}
          style={({ pressed }) => [
            styles.guidedLink,
            { borderColor: colors.border, backgroundColor: colors.paperCard, borderRadius: colors.radiusSm },
            pressed && { opacity: 0.85 },
          ]}
        >
          <Feather name="camera" size={15} color={colors.cobalt} />
          <Text style={[styles.guidedLinkText, { color: colors.navy }]}>
            Add progress photos — guided session
          </Text>
          <Feather name="chevron-right" size={16} color={colors.subtleText} />
        </Pressable>

        {error ? <Text style={[styles.error, { color: colors.riskText }]}>{error}</Text> : null}

        <Pressable
          testID="checkin-save"
          onPress={save}
          disabled={saving}
          style={({ pressed }) => [
            styles.saveBtn,
            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm },
            (pressed || saving) && { opacity: 0.85 },
          ]}
        >
          <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>
            {existing ? 'Update Check-In' : 'Save Check-In'}
          </Text>
        </Pressable>
      </KeyboardAwareScrollViewCompat>
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
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerAction: {
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
    width: 52,
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'PlayfairDisplay_700Bold',
    letterSpacing: 0.2,
  },
  headerSub: {
    fontSize: 10,
    marginTop: 2,
    fontFamily: 'Inter_400Regular',
  },
  headerSpacer: {
    width: 52,
  },
  content: {
    padding: 16,
  },
  updateNote: {
    borderWidth: 1,
    padding: 10,
    marginBottom: 14,
  },
  updateNoteText: {
    fontSize: 11.5,
    fontFamily: 'Inter_400Regular',
  },
  fieldLabel: {
    fontSize: 10,
    letterSpacing: 1.4,
    fontFamily: 'Inter_700Bold',
  },
  weightRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  weightInput: {
    borderWidth: 1,
    paddingHorizontal: 12,
    height: 48,
    fontSize: 22,
    fontFamily: 'PlayfairDisplay_600SemiBold',
    width: 140,
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  weightUnit: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  fieldHint: {
    fontSize: 10.5,
    marginTop: 8,
    fontFamily: 'Inter_400Regular',
  },
  nudgePausedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
    marginTop: -4,
    marginBottom: 14,
  },
  nudgePausedText: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
  },
  nudgeAction: {
    fontSize: 11.5,
    fontFamily: 'Inter_600SemiBold',
  },
  nudgeNoteText: {
    fontSize: 12.5,
    lineHeight: 19,
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
  },
  nudgeActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  nudgeChatBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  nudgeChatBtnText: {
    fontSize: 12.5,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
  moodRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 10,
  },
  moodCell: {
    flex: 1,
    borderWidth: 1,
    alignItems: 'center',
    paddingVertical: 10,
    gap: 2,
  },
  moodValue: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
  },
  moodLabel: {
    fontSize: 8.5,
    fontFamily: 'Inter_600SemiBold',
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  chip: {
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipText: {
    fontSize: 12,
    fontFamily: 'Inter_600SemiBold',
  },
  notesInput: {
    borderWidth: 1,
    padding: 12,
    marginTop: 10,
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    minHeight: 84,
    textAlignVertical: 'top',
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}),
  },
  guidedLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 14,
  },
  guidedLinkText: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  error: {
    fontSize: 11.5,
    marginBottom: 10,
    fontFamily: 'Inter_400Regular',
  },
  saveBtn: {
    paddingVertical: 13,
    alignItems: 'center',
  },
  saveBtnText: {
    fontSize: 13.5,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 0.2,
  },
});
