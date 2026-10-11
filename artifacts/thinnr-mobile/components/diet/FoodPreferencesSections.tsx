/**
 * The four preference lists plus the safety answers on Food preferences.
 * Every edit is instant: the context projects it locally and the offline
 * queue carries it to the server, so the rows reflect the queued state.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { fonts } from '@/constants/colors';
import { usePatient } from '@/context/PatientContext';
import { LedgerCard } from '@/components/ui/LedgerPrimitives';
import {
  ALLERGEN_KEYS,
  ALLERGEN_LABELS,
  DIET_BY_SLUG,
  RESTRICTIONS,
  SCREENING_PROMPTS,
  SENSITIVITIES,
  questionsForDiet,
  type PreferenceList,
  type ScreeningAnswer,
  type ScreeningQuestion,
} from '@/lib/diet-fit';
import type { DietState } from '@/lib/diet-state';
import { PreferenceListEditor, type EditorItem } from './PreferenceListEditor';
import { ScreeningQuestionRows, SectionLabel } from './DietChoiceFields';

const ALLERGEN_OPTIONS = ALLERGEN_KEYS.map(key => ({ key, label: ALLERGEN_LABELS[key] }));
const SENSITIVITY_OPTIONS = SENSITIVITIES.map(s => ({ key: s.key, label: s.label }));
const RESTRICTION_OPTIONS = RESTRICTIONS.map(r => ({ key: r.key, label: r.label }));

const SECTIONS: Array<{
  list: PreferenceList;
  title: string;
  note: string;
  options: ReadonlyArray<{ key: string; label: string }>;
  hideOptions?: boolean;
  placeholder: string;
}> = [
  { list: 'allergy', title: 'Allergies', note: 'Kept out of every suggestion. Mark how serious each one is.', options: ALLERGEN_OPTIONS, placeholder: 'Another allergy…' },
  { list: 'sensitivity', title: 'Sensitivities', note: 'Foods that don’t agree with you, without being an allergy.', options: SENSITIVITY_OPTIONS, placeholder: 'Another sensitivity…' },
  { list: 'restriction', title: 'Restrictions', note: 'Religious, ethical or personal eating rules.', options: RESTRICTION_OPTIONS, placeholder: 'Another rule…' },
  { list: 'dislike', title: 'Dislikes', note: 'Left out of recipe ideas.', options: [], hideOptions: true, placeholder: 'e.g. cilantro, mushrooms…' },
];

const ANSWER_LABELS: Record<ScreeningAnswer, string> = { yes: 'Yes', no: 'No', skipped: 'Preferred not to say' };

export function itemsForList(diet: DietState, list: PreferenceList): EditorItem[] {
  return diet.preferences
    .filter(p => p.list === list)
    .map(p => ({ id: p.id, key: p.isCustom ? null : p.key, label: p.label, severity: p.severity }));
}

export function FoodPreferencesSections({ diet }: { diet: DietState }) {
  const colors = useColors();
  const patient = usePatient();
  const entry = diet.currentDiet ? DIET_BY_SLUG.get(diet.currentDiet.dietSlug) ?? null : null;
  const asked = entry ? questionsForDiet(entry, patient.profile?.gender ?? null) : [];
  const answered = (Object.keys(diet.screening.answers) as ScreeningQuestion[]).filter(q => diet.screening.answers[q]);
  const questions = Array.from(new Set<ScreeningQuestion>([...asked, ...answered]));

  return (
    <>
      {SECTIONS.map(section => {
        const items = itemsForList(diet, section.list);
        return (
          <LedgerCard key={section.list} style={styles.card} testID={`prefs-section-${section.list}`}>
            <SectionLabel text={section.title} />
            <Text style={[styles.note, { color: colors.subtleText }]}>{section.note}</Text>
            {section.list === 'allergy' && items.length === 0 ? (
              <Text testID="prefs-allergy-none" style={[styles.note, { color: colors.bodyText }]}>No food allergies on file.</Text>
            ) : null}
            <PreferenceListEditor
              testIDPrefix={`prefs-${section.list}`}
              options={section.options}
              hideOptions={section.hideOptions}
              items={items}
              customPlaceholder={section.placeholder}
              onAdd={item => {
                void patient.addDietPreference({
                  list: section.list,
                  ...(item.key ? { key: item.key } : {}),
                  label: item.label,
                  ...(section.list === 'allergy' ? { severity: 'mild' as const } : {}),
                });
              }}
              onRemove={item => void patient.removeDietPreference(item.id)}
              onSeverity={section.list === 'allergy' ? (item, severity) => void patient.updateDietPreferenceSeverity(item.id, severity) : undefined}
            />
          </LedgerCard>
        );
      })}

      <LedgerCard style={styles.card} testID="prefs-section-screening">
        <SectionLabel text="Safety answers" />
        {questions.length === 0 ? (
          <Text testID="prefs-screening-empty" style={[styles.note, { color: colors.bodyText }]}>
            {entry ? `${entry.name} doesn’t ask any safety questions.` : 'Your diet will ask any safety questions it needs when you pick one.'}
          </Text>
        ) : (
          <>
            <View style={styles.answers}>
              {questions.map(q => (
                <View key={q} style={styles.answerRow}>
                  <Text style={[styles.note, { color: colors.bodyText, flex: 1 }]}>{SCREENING_PROMPTS[q]}</Text>
                  <Text testID={`prefs-answer-${q}`} style={[styles.answer, { color: colors.navy }]}>
                    {diet.screening.answers[q] ? ANSWER_LABELS[diet.screening.answers[q]!] : 'Not answered'}
                  </Text>
                </View>
              ))}
            </View>
            <Text style={[styles.note, { color: colors.subtleText }]}>Changed your mind? Update an answer below.</Text>
            <ScreeningQuestionRows
              testIDPrefix="prefs-screen"
              questions={questions}
              answers={diet.screening.answers}
              onAnswer={(q, a) => void patient.saveDietScreening({ [q]: a })}
            />
          </>
        )}
      </LedgerCard>
    </>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 8 },
  note: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16 },
  answers: { gap: 6 },
  answerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  answer: { fontFamily: fonts.sansSemiBold, fontSize: 12 },
});
