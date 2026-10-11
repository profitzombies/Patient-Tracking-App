/**
 * The in-app diet picker (post-onboarding): the catalog cards, the per-diet
 * safety questions, fasting / Whole30 settings, activity level, ONE
 * confirmation when the diet actually changes, and the server's answer —
 * active, parked for care-team review, locked, or rejected. The protocol
 * lock shows the protocol as the active plan and explains when the picker
 * unlocks. RN primitives only so Node suites can mount it.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { GhostButton, InfoCard, NoteText, PrimaryButton } from '@/components/onboarding/OnboardingFields';
import {
  DIET_BY_SLUG,
  GLP1_COMPANION_SLUG,
  JUST_TRACKING_SLUG,
  PROTOCOL_LENGTH_DAYS,
  questionsForDiet,
  unansweredQuestions,
  type ActivityLevel,
  type ScreeningAnswer,
  type ScreeningQuestion,
} from '@/lib/diet-fit';
import {
  FASTING_PRESETS,
  INTERMITTENT_FASTING_SLUG,
  WHOLE30_SLUG,
  fastingWindowFor,
  presetForWindow,
  type DietSettings,
  type ScreeningAnswers,
} from '@/lib/diet-state';
import type { DietSelectionOutcome } from '@/context/PatientAccountContext';
import { DietCardList } from './DietCardList';
import {
  ActivityLevelPicker,
  FastingWindowFields,
  ScreeningQuestionRows,
  SectionLabel,
  Whole30StartFields,
} from './DietChoiceFields';

interface DietPickerProps {
  /** Called once the pick is settled (active) or the patient leaves a review notice. */
  onDone: () => void;
  testIDPrefix?: string;
}

type Notice =
  | { kind: 'pending_review'; message: string; suggestedSlug: string | null }
  | { kind: 'locked'; message: string }
  | { kind: 'error'; message: string };

export function DietPicker({ onDone, testIDPrefix = 'picker' }: DietPickerProps) {
  const colors = useColors();
  const patient = usePatient();
  const { diet, dietStatus, todayKey, profile } = patient;
  const currentSlug = diet?.currentDiet?.dietSlug ?? null;
  const currentSettings = diet?.currentDiet?.settings ?? {};
  const gender = profile?.gender ?? null;

  const [slug, setSlug] = useState<string | null>(currentSlug);
  const [answers, setAnswers] = useState<ScreeningAnswers>(() => ({ ...(diet?.screening.answers ?? {}) }));
  const [fastingPreset, setFastingPreset] = useState<string | null>(
    () => presetForWindow(currentSettings.fastingWindow)?.id ?? null,
  );
  const [fastingStart, setFastingStart] = useState<string>(
    () => currentSettings.fastingWindow?.eatingStart ?? FASTING_PRESETS[0].defaultStart,
  );
  const [whole30Start, setWhole30Start] = useState<string>(() => currentSettings.whole30StartDate ?? todayKey);
  const [activity, setActivity] = useState<ActivityLevel | null>(diet?.activityLevel?.level ?? null);
  // The diet slice can land after the first render: adopt the recorded
  // activity level once, so a remount never makes the patient re-answer it.
  const recordedActivity = diet?.activityLevel?.level ?? null;
  useEffect(() => {
    if (recordedActivity) setActivity(current => current ?? recordedActivity);
  }, [recordedActivity]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const entry = slug ? DIET_BY_SLUG.get(slug) ?? null : null;
  const questions = useMemo<ScreeningQuestion[]>(() => (entry ? questionsForDiet(entry, gender) : []), [entry, gender]);
  const open = useMemo(
    () => (entry && entry.slug !== JUST_TRACKING_SLUG
      ? unansweredQuestions(entry, { phase: 'maintenance', programId: diet?.programId ?? null, gender, answers, actor: 'patient' })
      : []),
    [answers, diet?.programId, entry, gender],
  );
  const locked = diet?.phase.dietPickerLocked === true;
  const suggested = diet?.suggestedDefaultSlug === GLP1_COMPANION_SLUG ? GLP1_COMPANION_SLUG : null;
  const dietChanged = slug !== null && slug !== currentSlug;

  const settings = (): DietSettings | undefined => {
    if (slug === INTERMITTENT_FASTING_SLUG) {
      const preset = FASTING_PRESETS.find(p => p.id === fastingPreset) ?? FASTING_PRESETS[0];
      return { fastingWindow: fastingWindowFor(preset, fastingStart) };
    }
    if (slug === WHOLE30_SLUG) return { whole30StartDate: whole30Start || todayKey };
    return undefined;
  };

  const blocker = !slug
    ? 'Pick a diet or "just tracking" first.'
    : open.length > 0
      ? 'Answer the safety question first.'
      : !activity
        ? 'Tell us how active you are.'
        : null;

  const commit = async () => {
    if (!slug || busy) return;
    setBusy(true);
    setNotice(null);
    setConfirming(false);
    let outcome: DietSelectionOutcome;
    if (!dietChanged) {
      // Same diet: only settings / answers / activity changed — no confirmation.
      const nextSettings = settings();
      const ok = await Promise.all([
        nextSettings ? patient.saveDietSettings(nextSettings) : Promise.resolve(true),
        Object.keys(answers).length > 0 ? patient.saveDietScreening(answers) : Promise.resolve(true),
        activity && activity !== diet?.activityLevel?.level
          ? patient.saveDietActivity(activity, 'diet_selection')
          : Promise.resolve(true),
      ]);
      outcome = ok.every(Boolean)
        ? { kind: 'active', previousDietSlug: currentSlug, oversightRecommended: false }
        : { kind: 'rejected', message: 'Those changes didn’t save. Please try again.' };
    } else {
      outcome = await patient.selectDiet({ dietSlug: slug, answers, settings: settings(), activityLevel: activity });
    }
    setBusy(false);
    if (outcome.kind === 'active') {
      onDone();
      return;
    }
    if (outcome.kind === 'pending_review') {
      setNotice({ kind: 'pending_review', message: outcome.message, suggestedSlug: outcome.suggestedSlug });
      return;
    }
    if (outcome.kind === 'locked') {
      setNotice({ kind: 'locked', message: outcome.message });
      return;
    }
    setNotice({ kind: 'error', message: outcome.message });
  };

  if (dietStatus === 'loading' || dietStatus === 'idle') {
    return <Text testID={`${testIDPrefix}-loading`} style={[styles.sub, { color: colors.subtleText }]}>Loading your plan…</Text>;
  }
  if (dietStatus === 'error' || !diet) {
    return (
      <View style={styles.block}>
        <Text testID={`${testIDPrefix}-error`} style={[styles.sub, { color: colors.riskText }]}>
          Couldn’t load your plan right now.
        </Text>
        <GhostButton label="Try again" onPress={() => void patient.refreshDiet()} testID={`${testIDPrefix}-retry`} />
      </View>
    );
  }

  if (locked) {
    return (
      <View testID={`${testIDPrefix}-locked`} style={styles.block}>
        <InfoCard
          label="Active plan"
          body={`THINNR protocol · day ${diet.phase.programDay} of ${PROTOCOL_LENGTH_DAYS}. Your Approved Foods list is what fits right now.`}
        />
        <NoteText text="When the protocol finishes you move into maintenance and can pick any diet here, or keep just tracking." />
        <ActivitySection value={activity} onChange={setActivity} testIDPrefix={testIDPrefix} />
        <PrimaryButton
          testID={`${testIDPrefix}-save-activity`}
          label={busy ? 'Saving…' : 'Save'}
          disabled={busy || !activity}
          onPress={() => {
            if (!activity) return;
            setBusy(true);
            void patient.saveDietActivity(activity, 'settings').then(() => {
              setBusy(false);
              onDone();
            });
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.block}>
      {diet.pendingBlock && diet.pendingBlock.status === 'pending' ? (
        <ReviewCard
          testID={`${testIDPrefix}-pending-block`}
          body={`Your pick of ${DIET_BY_SLUG.get(diet.pendingBlock.dietSlug)?.name ?? 'a diet'} is with your care team. You can choose something else in the meantime.`}
        />
      ) : null}
      <DietCardList
        testIDPrefix={`${testIDPrefix}-diet`}
        value={slug}
        currentSlug={currentSlug}
        suggestedSlug={suggested}
        onSelect={next => {
          if (next === slug) return;
          setSlug(next);
          setNotice(null);
          setConfirming(false);
          if (next === INTERMITTENT_FASTING_SLUG && !fastingPreset) setFastingPreset(FASTING_PRESETS[0].id);
        }}
      />
      {entry && entry.slug !== JUST_TRACKING_SLUG ? (
        <ScreeningQuestionRows
          testIDPrefix={`${testIDPrefix}-screen`}
          questions={questions}
          answers={answers}
          onAnswer={(q: ScreeningQuestion, a: ScreeningAnswer) => setAnswers(prev => ({ ...prev, [q]: a }))}
        />
      ) : null}
      {entry?.slug === INTERMITTENT_FASTING_SLUG ? (
        <FastingWindowFields
          testIDPrefix={`${testIDPrefix}-fasting`}
          presetId={fastingPreset}
          eatingStart={fastingStart}
          onChange={next => {
            setFastingPreset(next.presetId);
            setFastingStart(next.eatingStart);
          }}
        />
      ) : null}
      {entry?.slug === WHOLE30_SLUG ? (
        <Whole30StartFields
          testIDPrefix={`${testIDPrefix}-whole30`}
          todayKey={todayKey}
          startDate={whole30Start}
          onChange={setWhole30Start}
        />
      ) : null}

      <ActivitySection value={activity} onChange={setActivity} testIDPrefix={testIDPrefix} />

      {notice ? (
        <ReviewCard
          testID={`${testIDPrefix}-notice-${notice.kind}`}
          body={notice.kind === 'pending_review'
            ? `Your care team has been asked to review. ${notice.message} You can pick something else meanwhile.`
            : notice.message}
          danger={notice.kind === 'error'}
        />
      ) : null}

      {confirming && dietChanged && entry ? (
        <View testID={`${testIDPrefix}-confirm`} style={[styles.confirm, { borderColor: colors.cobalt, backgroundColor: colors.accent, borderRadius: colors.radiusSm }]}>
          <Text style={[styles.confirmTitle, { color: colors.navy }]}>
            {currentSlug ? `Switch to ${entry.name}?` : `Start ${entry.name}?`}
          </Text>
          <Text style={[styles.sub, { color: colors.bodyText }]}>
            {currentSlug
              ? `${DIET_BY_SLUG.get(currentSlug)?.name ?? 'Your current plan'} ends today and food badges follow the new plan from now on. Your targets don’t change.`
              : 'Food badges follow this plan from now on. Your targets don’t change.'}
          </Text>
          <View style={styles.row}>
            <PrimaryButton testID={`${testIDPrefix}-confirm-yes`} label={busy ? 'Saving…' : 'Yes, switch'} disabled={busy} onPress={() => void commit()} style={styles.grow} />
            <GhostButton testID={`${testIDPrefix}-confirm-no`} label="Keep current" disabled={busy} onPress={() => setConfirming(false)} style={styles.grow} />
          </View>
        </View>
      ) : (
        <PrimaryButton
          testID={`${testIDPrefix}-save`}
          label={busy ? 'Saving…' : dietChanged ? 'Use this diet' : 'Save changes'}
          disabled={busy || blocker !== null}
          onDisabledPress={() => setNotice(blocker ? { kind: 'error', message: blocker } : null)}
          onPress={() => {
            if (dietChanged) setConfirming(true);
            else void commit();
          }}
        />
      )}
    </View>
  );
}

function ActivitySection({ value, onChange, testIDPrefix }: { value: ActivityLevel | null; onChange: (l: ActivityLevel) => void; testIDPrefix: string }) {
  const colors = useColors();
  return (
    <View style={styles.block}>
      <SectionLabel text="How active are you?" />
      <Text style={[styles.sub, { color: colors.bodyText }]}>This sets your daily targets. We ask again at each weekly check-in.</Text>
      <ActivityLevelPicker testIDPrefix={`${testIDPrefix}-activity`} value={value} onChange={onChange} />
    </View>
  );
}

export function ReviewCard({ body, testID, danger = false }: { body: string; testID?: string; danger?: boolean }) {
  const colors = useColors();
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[styles.review, { borderColor: danger ? colors.riskText : colors.cobaltMuted, backgroundColor: colors.card, borderRadius: colors.radiusSm }]}
    >
      <Text style={[styles.sub, { color: danger ? colors.riskText : colors.navy }]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: 12 },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  sub: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
  confirm: { borderWidth: 1, padding: 14, gap: 10 },
  confirmTitle: { fontFamily: fonts.sansSemiBold, fontSize: 16 },
  review: { borderWidth: 1, padding: 12 },
});
