/**
 * End-of-onboarding diet steps, in the slot the old single diet step held:
 * diet → allergies & sensitivities (required, "None" is one tap) →
 * restrictions → dislikes. Answers stay local to the run; the writes ride
 * the offline queue only after completion is server-confirmed.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { useOnboarding } from '@/context/OnboardingContext';
import {
  ALLERGIES_STEP_HINT,
  allergiesStepComplete,
  DIET_STEP_HINTS,
  dietPickerLockedFor,
  dietStepBlocker,
  samePreference,
  type OnboardingAnswers,
  type PreferenceAnswer,
  type PreferenceAnswerKey,
} from '@/data/onboarding-data';
import { TODAY_KEY } from '@/data/patient-data';
import { localTodayKey } from '@/lib/live-patient-entry';
import {
  ALLERGEN_KEYS,
  ALLERGEN_LABELS,
  DIET_BY_SLUG,
  GLP1_COMPANION_SLUG,
  JUST_TRACKING_SLUG,
  PROTOCOL_LENGTH_DAYS,
  questionsForDiet,
  RESTRICTIONS,
  SENSITIVITIES,
  suggestedDefaultSlug,
} from '@/lib/diet-fit';
import { INTERMITTENT_FASTING_SLUG, WHOLE30_SLUG } from '@/lib/diet-state';
import { OnboardingFrame } from './OnboardingFrame';
import { CheckRow, InfoCard, NoteText } from './OnboardingFields';
import { DietCardList } from '@/components/diet/DietCardList';
import {
  ActivityLevelPicker,
  FastingWindowFields,
  ScreeningQuestionRows,
  SectionLabel,
  Whole30StartFields,
} from '@/components/diet/DietChoiceFields';
import { PreferenceListEditor, type EditorItem } from '@/components/diet/PreferenceListEditor';

function useTodayKey(): string {
  const { account } = usePatientAccount();
  return account.kind === 'real' ? localTodayKey() : TODAY_KEY;
}

// ─── Diet ────────────────────────────────────────────────────────────────────

export function DietStep() {
  const colors = useColors();
  const { answers, patch } = useOnboarding();
  const todayKey = useTodayKey();
  const locked = dietPickerLockedFor(answers, todayKey);
  const blocker = dietStepBlocker(answers, locked);
  const entry = answers.dietSlug ? DIET_BY_SLUG.get(answers.dietSlug) ?? null : null;
  const questions = useMemo(() => (entry ? openDietQuestionsAll(answers) : []), [answers, entry]);
  const suggested = suggestedDefaultSlug(answers.program);

  return (
    <OnboardingFrame
      stepKey="diet"
      title={locked ? 'Your plan right now' : 'Pick a way of eating'}
      coach={
        locked
          ? 'The THINNR protocol is your plan for now — the diet picker unlocks when it finishes.'
          : answers.program === 'glp1'
            ? 'GLP-1 patients do well with the companion plan, but any of these work — or just track.'
            : 'Choose one framework, or just track what you eat. You can change it anytime.'
      }
      nextDisabled={blocker !== null}
      nextBlockedHint={blocker ? DIET_STEP_HINTS[blocker] : undefined}
    >
      {locked ? (
        <View testID="ob-diet-locked" style={styles.block}>
          <InfoCard
            label="Active plan"
            body={`THINNR protocol · ${PROTOCOL_LENGTH_DAYS} days. Your Approved Foods list is what fits right now.`}
          />
          <NoteText text="When the protocol finishes you move into maintenance and can pick any diet here, or keep just tracking." />
        </View>
      ) : (
        <View style={styles.block}>
          <DietCardList
            testIDPrefix="ob-diet"
            value={answers.dietSlug}
            suggestedSlug={suggested === GLP1_COMPANION_SLUG ? GLP1_COMPANION_SLUG : null}
            onSelect={slug => {
              if (slug === answers.dietSlug) return;
              patch({
                dietSlug: slug,
                fastingPreset: slug === INTERMITTENT_FASTING_SLUG ? answers.fastingPreset ?? '16:8' : null,
                whole30StartDate: slug === WHOLE30_SLUG ? answers.whole30StartDate || todayKey : '',
              });
            }}
          />
          {entry && entry.slug !== JUST_TRACKING_SLUG ? (
            <ScreeningQuestionRows
              testIDPrefix="ob-screen"
              questions={questions}
              answers={answers.dietAnswers}
              onAnswer={(q, a) => patch({ dietAnswers: { ...answers.dietAnswers, [q]: a } })}
            />
          ) : null}
          {entry?.slug === INTERMITTENT_FASTING_SLUG ? (
            <FastingWindowFields
              testIDPrefix="ob-fasting"
              presetId={answers.fastingPreset}
              eatingStart={answers.fastingStart}
              onChange={next => patch({ fastingPreset: next.presetId, fastingStart: next.eatingStart })}
            />
          ) : null}
          {entry?.slug === WHOLE30_SLUG ? (
            <Whole30StartFields
              testIDPrefix="ob-whole30"
              todayKey={todayKey}
              startDate={answers.whole30StartDate}
              onChange={whole30StartDate => patch({ whole30StartDate })}
            />
          ) : null}
        </View>
      )}

      <View style={styles.block}>
        <SectionLabel text="How active are you?" />
        <Text style={[styles.sub, { color: colors.bodyText }]}>
          This sets your daily targets. We ask again at each weekly check-in.
        </Text>
        <ActivityLevelPicker
          testIDPrefix="ob-activity"
          value={answers.activityLevel}
          onChange={activityLevel => patch({ activityLevel })}
        />
      </View>
    </OnboardingFrame>
  );
}

/** Every question the chosen diet asks (answered or not), for rendering. */
function openDietQuestionsAll(a: OnboardingAnswers) {
  const entry = a.dietSlug ? DIET_BY_SLUG.get(a.dietSlug) : null;
  return entry ? questionsForDiet(entry, a.gender) : [];
}

// ─── List steps (shared plumbing) ───────────────────────────────────────────

function itemsOf(list: PreferenceAnswer[]): EditorItem[] {
  return list.map(p => ({ id: p.key ?? `custom:${p.label.toLowerCase()}`, key: p.key, label: p.label, severity: p.severity ?? null }));
}

function useListEditing(field: PreferenceAnswerKey) {
  const { answers, patch } = useOnboarding();
  const list = answers[field];
  return {
    items: itemsOf(list),
    add: (item: { key: string | null; label: string }) => {
      const next: PreferenceAnswer = field === 'allergies' ? { ...item, severity: 'mild' } : item;
      if (list.some(p => samePreference(p, next))) return;
      patch({ [field]: [...list, next], ...(field === 'allergies' ? { allergiesNone: false } : {}) } as Partial<OnboardingAnswers>);
    },
    remove: (item: EditorItem) => {
      patch({ [field]: list.filter(p => !samePreference(p, { key: item.key, label: item.label })) } as Partial<OnboardingAnswers>);
    },
    severity: (item: EditorItem, severity: 'mild' | 'severe') => {
      patch({
        [field]: list.map(p => (samePreference(p, { key: item.key, label: item.label }) ? { ...p, severity } : p)),
      } as Partial<OnboardingAnswers>);
    },
  };
}

const ALLERGEN_OPTIONS = ALLERGEN_KEYS.map(key => ({ key, label: ALLERGEN_LABELS[key] }));
const SENSITIVITY_OPTIONS = SENSITIVITIES.map(s => ({ key: s.key, label: s.label }));
const RESTRICTION_OPTIONS = RESTRICTIONS.map(r => ({ key: r.key, label: r.label }));

// ─── Allergies & sensitivities ──────────────────────────────────────────────

export function AllergiesStep() {
  const { answers, patch } = useOnboarding();
  const allergies = useListEditing('allergies');
  const sensitivities = useListEditing('sensitivities');
  const complete = allergiesStepComplete(answers);

  return (
    <OnboardingFrame
      stepKey="allergies"
      title="Any food allergies?"
      coach="We keep these foods out of your suggestions. Tell us how serious each one is."
      nextDisabled={!complete}
      nextBlockedHint={ALLERGIES_STEP_HINT}
    >
      <CheckRow
        testID="ob-allergies-none"
        label="None"
        sub="No food allergies"
        checked={answers.allergiesNone}
        onPress={() => patch(answers.allergiesNone ? { allergiesNone: false } : { allergiesNone: true, allergies: [] })}
      />
      {!answers.allergiesNone ? (
        <PreferenceListEditor
          testIDPrefix="ob-allergy"
          options={ALLERGEN_OPTIONS}
          items={allergies.items}
          onAdd={allergies.add}
          onRemove={allergies.remove}
          onSeverity={allergies.severity}
          customPlaceholder="Another allergy…"
        />
      ) : null}
      <View style={styles.block}>
        <SectionLabel text="Sensitivities (optional)" />
        <NoteText text="Foods that don’t agree with you, without being an allergy." />
        <PreferenceListEditor
          testIDPrefix="ob-sensitivity"
          options={SENSITIVITY_OPTIONS}
          items={sensitivities.items}
          onAdd={sensitivities.add}
          onRemove={sensitivities.remove}
          customPlaceholder="Another sensitivity…"
        />
      </View>
    </OnboardingFrame>
  );
}

// ─── Restrictions ───────────────────────────────────────────────────────────

export function RestrictionsStep() {
  const restrictions = useListEditing('restrictions');
  return (
    <OnboardingFrame
      stepKey="restrictions"
      title="Any eating rules you follow?"
      coach="Religious, ethical or personal — optional. Skip if none apply."
      nextLabel={restrictions.items.length === 0 ? 'Skip' : 'Next'}
    >
      <PreferenceListEditor
        testIDPrefix="ob-restriction"
        options={RESTRICTION_OPTIONS}
        items={restrictions.items}
        onAdd={restrictions.add}
        onRemove={restrictions.remove}
        customPlaceholder="Another rule…"
      />
    </OnboardingFrame>
  );
}

// ─── Dislikes ───────────────────────────────────────────────────────────────

export function DislikesStep() {
  const dislikes = useListEditing('dislikes');
  return (
    <OnboardingFrame
      stepKey="dislikes"
      title="Anything you just don’t like?"
      coach="Last one — we’ll keep these out of recipe ideas. Optional."
      nextLabel={dislikes.items.length === 0 ? 'Skip' : 'Next'}
    >
      <PreferenceListEditor
        testIDPrefix="ob-dislike"
        hideOptions
        options={[]}
        items={dislikes.items}
        onAdd={dislikes.add}
        onRemove={dislikes.remove}
        customPlaceholder="e.g. cilantro, mushrooms…"
      />
      <NoteText text="Type a food and tap Add. You can edit all of these later under Food preferences." />
    </OnboardingFrame>
  );
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  sub: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18 },
});
