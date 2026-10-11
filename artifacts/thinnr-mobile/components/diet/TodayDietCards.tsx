/**
 * Today-screen diet surfaces: the provider-change / pregnancy notices, the
 * one-time "set up your diet" prompt for accounts that finished onboarding
 * before the diet steps existed, the intermittent-fasting eating-window
 * timer, and the Whole30 day counter with its day-31 "pick what's next"
 * prompt. RN primitives only (Node suites mount them).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import { GhostButton, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import { JUST_TRACKING_SLUG } from '@/lib/diet-fit';
import {
  INTERMITTENT_FASTING_SLUG,
  WHOLE30_LENGTH_DAYS,
  WHOLE30_SLUG,
  eatingWindowStatus,
  formatClock,
  formatDuration,
  whole30Status,
  type DietState,
} from '@/lib/diet-state';
import { DietNoticeList } from './DietNoticeList';
import { useDietNotices } from '@/hooks/useDietNotices';

/** Minutes since local midnight on the device clock. */
export function localMinutesNow(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** Marker stored in onboardingAnswers once the existing-account prompt has been answered. */
export const DIET_PROMPT_SEEN_KEY = 'dietPromptSeen';

/**
 * Whether a signed-in account should see the one-time diet prompt: finished
 * onboarding before the diet steps existed (no `allergiesNone` answer on
 * file), has not dismissed the prompt, and still has no diet or allergy
 * answer in the diet slice.
 */
export function needsDietPrompt(input: {
  onboardingComplete: boolean;
  onboardingAnswers: Record<string, unknown> | null;
  diet: DietState | null;
}): boolean {
  if (!input.onboardingComplete || !input.diet) return false;
  const answers = input.onboardingAnswers ?? {};
  if (answers[DIET_PROMPT_SEEN_KEY] === true) return false;
  if ('allergiesNone' in answers) return false;
  if (input.diet.currentDiet) return false;
  if (input.diet.preferences.some(p => p.list === 'allergy')) return false;
  return true;
}

export function ExistingAccountDietPrompt({ onOpenPreferences }: { onOpenPreferences: () => void }) {
  const colors = useColors();
  const patient = usePatient();
  const { account } = usePatientAccount();
  const [answered, setAnswered] = useState(false);
  if (account.kind !== 'real' || answered) return null;
  const flags = patient.hydratedFlags;
  if (!flags || !needsDietPrompt({ onboardingComplete: flags.onboardingComplete, onboardingAnswers: flags.onboardingAnswers, diet: patient.diet })) {
    return null;
  }
  const markSeen = () => {
    setAnswered(true);
    patient.saveOnboardingFlags({ onboardingAnswers: { ...(flags.onboardingAnswers ?? {}), [DIET_PROMPT_SEEN_KEY]: true } });
  };
  const locked = patient.diet?.phase.dietPickerLocked === true;
  return (
    <LedgerCard accentTop style={styles.card} testID="today-diet-prompt">
      <Text style={[styles.title, { color: colors.navy }]}>New: your diet and food preferences</Text>
      <Text style={[styles.body, { color: colors.bodyText }]}>
        {locked
          ? 'Tell us your allergies, sensitivities, restrictions and dislikes so "Fits your diet" badges can warn you. The diet picker opens when your protocol finishes.'
          : 'Pick a diet framework (or just track) and tell us your allergies, sensitivities, restrictions and dislikes. Foods then show whether they fit.'}
      </Text>
      <View style={styles.actions}>
        <PrimaryButton
          testID="today-diet-prompt-open"
          label="Set it up"
          onPress={() => {
            markSeen();
            onOpenPreferences();
          }}
          style={styles.grow}
        />
        <GhostButton testID="today-diet-prompt-skip" label="Not now" onPress={markSeen} style={styles.grow} />
      </View>
    </LedgerCard>
  );
}

export function EatingWindowCard({ diet, now }: { diet: DietState; now?: () => number }) {
  const colors = useColors();
  const window = diet.currentDiet?.dietSlug === INTERMITTENT_FASTING_SLUG ? diet.currentDiet.settings.fastingWindow ?? null : null;
  const read = now ?? localMinutesNow;
  const [minutes, setMinutes] = useState(() => read());
  useEffect(() => {
    if (!window) return;
    setMinutes(read());
    const id = setInterval(() => setMinutes(read()), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window?.eatingStart, window?.eatingEnd]);
  if (!window) return null;
  const status = eatingWindowStatus(window, minutes);
  return (
    <LedgerCard style={styles.card} testID="today-eating-window">
      <Text style={[styles.kicker, { color: colors.labelText }]}>EATING WINDOW</Text>
      <Text testID="today-eating-window-state" style={[styles.title, { color: status.eating ? colors.activeGreen : colors.navy }]}>
        {status.eating ? 'Window open' : 'Fasting'}
      </Text>
      <Text testID="today-eating-window-remaining" style={[styles.body, { color: colors.bodyText }]}>
        {status.eating
          ? `${formatDuration(status.minutesRemaining)} left · closes ${formatClock(status.nextChangeAt)}`
          : `${formatDuration(status.minutesRemaining)} until it opens at ${formatClock(status.nextChangeAt)}`}
      </Text>
      <Text style={[styles.meta, { color: colors.subtleText }]}>
        {formatClock(window.eatingStart)} – {formatClock(window.eatingEnd)} daily
      </Text>
    </LedgerCard>
  );
}

export function Whole30Card({ diet, onPickDiet }: { diet: DietState; onPickDiet: () => void }) {
  const colors = useColors();
  const patient = usePatient();
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const start = diet.currentDiet?.dietSlug === WHOLE30_SLUG ? diet.currentDiet.settings.whole30StartDate ?? null : null;
  if (!start) return null;
  const status = whole30Status(start, diet.dateKey);

  const justTrack = async () => {
    setSwitching(true);
    setFailed(false);
    const outcome = await patient.selectDiet({ dietSlug: JUST_TRACKING_SLUG });
    setSwitching(false);
    if (outcome.kind !== 'active') setFailed(true);
  };

  if (status.finished) {
    return (
      <LedgerCard accentTop style={styles.card} testID="today-whole30-finished">
        <Text style={[styles.kicker, { color: colors.labelText }]}>WHOLE30</Text>
        <Text style={[styles.title, { color: colors.navy }]}>Your 30 days are done</Text>
        <Text style={[styles.body, { color: colors.bodyText }]}>
          Nice work. Pick what comes next — another framework, or just keep tracking what you eat.
        </Text>
        {failed ? <Text testID="today-whole30-failed" style={[styles.meta, { color: colors.riskText }]}>That didn’t save. Please try again.</Text> : null}
        <View style={styles.actions}>
          <PrimaryButton testID="today-whole30-pick" label="Pick a new diet" onPress={onPickDiet} disabled={switching} style={styles.grow} />
          <GhostButton testID="today-whole30-just-track" label={switching ? 'Saving…' : 'Just track'} onPress={() => void justTrack()} disabled={switching} style={styles.grow} />
        </View>
      </LedgerCard>
    );
  }
  return (
    <LedgerCard style={styles.card} testID="today-whole30">
      <Text style={[styles.kicker, { color: colors.labelText }]}>WHOLE30</Text>
      <Text testID="today-whole30-day" style={[styles.title, { color: colors.navy }]}>
        {status.day < 1 ? `Starts in ${1 - status.day} day${1 - status.day === 1 ? '' : 's'}` : `Day ${status.day} of ${WHOLE30_LENGTH_DAYS}`}
      </Text>
      <View style={[styles.track, { backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}>
        <View
          style={[
            styles.fill,
            { backgroundColor: colors.cobalt, borderRadius: colors.radiusSm, width: `${Math.min(100, Math.max(0, (status.day / WHOLE30_LENGTH_DAYS) * 100))}%` },
          ]}
        />
      </View>
      <Text style={[styles.meta, { color: colors.subtleText }]}>
        {status.day < 1 ? 'Your 30 days begin on the start day you picked.' : `${status.daysLeft} day${status.daysLeft === 1 ? '' : 's'} to go`}
      </Text>
    </LedgerCard>
  );
}

/** Everything diet-related that sits at the top of Today's body. */
export function TodayDietCards({ onOpenPreferences, onPickDiet }: { onOpenPreferences: () => void; onPickDiet: () => void }) {
  const { diet, dietStatus, hydratedFlags: flags } = usePatient();
  const { notices } = useDietNotices();
  const { account } = usePatientAccount();
  const showPrompt =
    account.kind === 'real' &&
    flags !== null &&
    needsDietPrompt({ onboardingComplete: flags.onboardingComplete, onboardingAnswers: flags.onboardingAnswers, diet });
  const live = dietStatus === 'live' && diet ? diet : null;
  const fasting = live?.currentDiet?.dietSlug === INTERMITTENT_FASTING_SLUG && live.currentDiet.settings.fastingWindow;
  const whole30 = live?.currentDiet?.dietSlug === WHOLE30_SLUG && live.currentDiet.settings.whole30StartDate;
  if (notices.length === 0 && !showPrompt && !fasting && !whole30) return null;
  return (
    <View style={styles.stack}>
      <DietNoticeList linkToPreferences />
      {showPrompt ? <ExistingAccountDietPrompt onOpenPreferences={onOpenPreferences} /> : null}
      {live ? (
        <>
          <EatingWindowCard diet={live} />
          <Whole30Card diet={live} onPickDiet={onPickDiet} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12, marginBottom: 16 },
  card: { padding: 14, gap: 6 },
  kicker: { fontFamily: fonts.sansMedium, fontSize: 10, letterSpacing: 0.8 },
  title: { fontFamily: 'PlayfairDisplay_600SemiBold', fontSize: 18 },
  body: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  meta: { fontFamily: fonts.sans, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 6 },
  grow: { flex: 1 },
  track: { height: 8, overflow: 'hidden', marginTop: 4 },
  fill: { height: 8 },
});
