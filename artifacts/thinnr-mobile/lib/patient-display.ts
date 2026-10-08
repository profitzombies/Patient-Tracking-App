/**
 * What patient screens show about the person using them.
 *
 * The guided demo is Emma Smith: her seeded profile fills every gap. A real
 * account never borrows Emma's numbers — a value the account doesn't have
 * yet stays null, and screens render it as a dash or leave the line out.
 */
import type { PatientProfile } from '@/context/PatientAccountContext';
import { PATIENT_PROFILE } from '@/data/patient-data';

type WeightProfile = Pick<PatientProfile, 'startingWeight' | 'currentWeight' | 'goalWeight'>;
type NameProfile = Pick<PatientProfile, 'firstName' | 'lastName'>;

export interface PatientWeightFacts {
  starting: number | null;
  current: number | null;
  goal: number | null;
  /** starting − current (positive = lost); null when either side is unknown. */
  lost: number | null;
}

export function patientWeightFacts(input: {
  real: boolean;
  profile: WeightProfile | null | undefined;
  /** Newest logged weigh-in, when there is one. */
  latestLogged: number | undefined;
}): PatientWeightFacts {
  if (!input.real) {
    const current = input.latestLogged ?? PATIENT_PROFILE.currentWeight;
    return {
      starting: PATIENT_PROFILE.startingWeight,
      current,
      goal: PATIENT_PROFILE.goalWeight,
      lost: PATIENT_PROFILE.startingWeight - current,
    };
  }
  const starting = input.profile?.startingWeight ?? null;
  const current = input.latestLogged ?? input.profile?.currentWeight ?? null;
  const goal = input.profile?.goalWeight ?? null;
  return { starting, current, goal, lost: starting !== null && current !== null ? starting - current : null };
}

/** A weight for display, or an em dash when the account has none yet. */
export function formatWeight(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits);
}

/** Avatar letters: Emma's "ES" in the demo, the account's own initials otherwise ('' if unnamed). */
export function patientInitials(real: boolean, profile: NameProfile | null | undefined): string {
  if (!real) return 'ES';
  return [profile?.firstName, profile?.lastName]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .slice(0, 2)
    .map(part => part.trim()[0])
    .join('')
    .toUpperCase();
}

/** First name for greetings: Emma in the demo, the account's own name (or '') otherwise. */
export function patientFirstName(
  real: boolean,
  entryFirstName: string | null | undefined,
  profile: NameProfile | null | undefined,
): string {
  if (entryFirstName) return entryFirstName;
  if (!real) return PATIENT_PROFILE.name.split(' ')[0];
  return profile?.firstName?.trim() ?? '';
}
