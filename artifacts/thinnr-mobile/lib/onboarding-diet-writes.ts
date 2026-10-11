/**
 * Turns the end-of-onboarding diet answers into patient-store writes.
 *
 * Runs only AFTER completion is server-confirmed: everything here rides the
 * offline write queue (or is a best-effort call whose failure is swallowed),
 * so a slow or failed diet write can never block entry to the app. The
 * caller fires and forgets; the queue retries on its own.
 */
import type { OnboardingAnswers, PreferenceAnswer } from '@/data/onboarding-data';
import { FASTING_PRESETS, fastingWindowFor, type DietSettings } from '@/lib/diet-state';
import type { ActivityLevel, ActivitySource, PreferenceList } from '@/lib/diet-fit';
import type { AllergySeverity, ScreeningAnswers } from '@/lib/diet-state';

/** The slice of the patient store these writes need (keeps suites stub-friendly). */
export interface DietWriteSink {
  queueDietSelection: (input: {
    dietSlug: string;
    answers?: ScreeningAnswers;
    settings?: DietSettings;
    activityLevel?: ActivityLevel | null;
  }) => Promise<boolean>;
  saveDietActivity: (level: ActivityLevel, source: ActivitySource) => Promise<boolean>;
  addDietPreference: (input: {
    list: PreferenceList;
    key?: string;
    label: string;
    severity?: AllergySeverity | null;
  }) => Promise<boolean>;
}

/** Diet settings implied by the onboarding answers (fasting window / Whole30 start). */
export function dietSettingsFor(a: OnboardingAnswers): DietSettings | undefined {
  if (a.dietSlug === 'intermittent_fasting') {
    const preset = FASTING_PRESETS.find(p => p.id === a.fastingPreset) ?? FASTING_PRESETS[0];
    return { fastingWindow: fastingWindowFor(preset, a.fastingStart || preset.defaultStart) };
  }
  if (a.dietSlug === 'whole30' && a.whole30StartDate) {
    return { whole30StartDate: a.whole30StartDate };
  }
  return undefined;
}

const LISTS: Array<{ list: PreferenceList; answers: (a: OnboardingAnswers) => PreferenceAnswer[] }> = [
  { list: 'allergy', answers: a => a.allergies },
  { list: 'sensitivity', answers: a => a.sensitivities },
  { list: 'restriction', answers: a => a.restrictions },
  { list: 'dislike', answers: a => a.dislikes },
];

/**
 * Issues every diet write for a finished run. Resolves once each call has
 * been handed to the store; individual outcomes are deliberately ignored.
 */
export async function dietWritesFor(a: OnboardingAnswers, sink: DietWriteSink): Promise<void> {
  const writes: Promise<unknown>[] = [];
  if (a.dietSlug) {
    writes.push(
      sink.queueDietSelection({
        dietSlug: a.dietSlug,
        answers: a.dietAnswers,
        settings: dietSettingsFor(a),
        activityLevel: a.activityLevel,
      }),
    );
  } else if (a.activityLevel) {
    writes.push(sink.saveDietActivity(a.activityLevel, 'diet_selection'));
  }
  for (const { list, answers } of LISTS) {
    for (const item of answers(a)) {
      writes.push(
        sink.addDietPreference({
          list,
          key: item.key ?? undefined,
          label: item.label,
          severity: list === 'allergy' ? (item.severity ?? 'mild') : null,
        }),
      );
    }
  }
  await Promise.allSettled(writes.map(w => w.catch(() => false)));
}
