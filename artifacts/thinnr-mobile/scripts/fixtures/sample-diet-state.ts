/**
 * A fixed diet snapshot for hermetic suites: derived from the fixed anchor
 * day and a chosen protocol start so every assertion is byte-identical run
 * to run. Never imported by app code.
 */
import { derivePhase, JUST_TRACKING_SLUG } from '@/lib/diet-fit';
import type { DietSelection, DietState } from '@/lib/diet-state';

export function sampleDietState(todayKey: string, episodeStartedOn: string): DietState {
  const phase = derivePhase({ episodeStartedOn, todayKey, programId: 'thinnr' });
  const locked = phase.dietPickerLocked;
  const selection: DietSelection | null = locked
    ? null
    : {
        id: 'sample-selection',
        dietSlug: 'mediterranean',
        status: 'active',
        selectedByRole: 'patient',
        settings: {},
        startedAt: `${todayKey}T12:00:00.000Z`,
        endedAt: null,
      };
  return {
    dateKey: todayKey,
    programId: 'thinnr',
    phase: { ...phase, episodeId: 'sample-episode', episodeNumber: 1, episodeStartedOn },
    currentDiet: selection,
    effectiveDietSlug: locked ? null : selection?.dietSlug ?? null,
    pendingSelection: null,
    pendingBlock: null,
    suggestedDefaultSlug: JUST_TRACKING_SLUG,
    screening: { answers: {}, pregnancyConflict: false },
    preferences: [
      {
        id: 'sample-pref-peanut',
        list: 'allergy',
        key: 'peanut',
        label: 'Peanuts',
        isCustom: false,
        severity: 'severe',
        enteredByRole: 'patient',
        enteredByName: null,
        createdAt: `${episodeStartedOn}T12:00:00.000Z`,
      },
      {
        id: 'sample-pref-cilantro',
        list: 'dislike',
        key: 'custom:cilantro',
        label: 'Cilantro',
        isCustom: true,
        severity: null,
        enteredByRole: 'patient',
        enteredByName: null,
        createdAt: `${episodeStartedOn}T12:00:00.000Z`,
      },
    ],
    activityLevel: { level: 'light', source: 'diet_selection', recordedOn: episodeStartedOn },
  };
}
