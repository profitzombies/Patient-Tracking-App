import type { PatientProfile } from '@/context/PatientAccountContext';

export const MALFORMED_PROFILE_MESSAGE = 'The live patient data response was malformed.';

export function parsePatientProfile(raw: unknown): PatientProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(MALFORMED_PROFILE_MESSAGE);
  }
  const p = raw as Record<string, unknown>;
  if (
    typeof p.firstName !== 'string' ||
    typeof p.lastName !== 'string' ||
    (p.email !== null && typeof p.email !== 'string') ||
    (p.phone !== null && typeof p.phone !== 'string') ||
    (p.dateOfBirth !== null && typeof p.dateOfBirth !== 'string') ||
    (p.heightInches !== null && typeof p.heightInches !== 'number') ||
    (p.startingWeight !== null && typeof p.startingWeight !== 'number') ||
    (p.currentWeight !== null && typeof p.currentWeight !== 'number') ||
    (p.goalWeight !== null && typeof p.goalWeight !== 'number') ||
    (p.timezone !== null && typeof p.timezone !== 'string') ||
    (p.programId !== null && typeof p.programId !== 'string') ||
    (p.programStartDate !== null && typeof p.programStartDate !== 'string') ||
    typeof p.setupComplete !== 'boolean'
  ) {
    throw new Error(MALFORMED_PROFILE_MESSAGE);
  }
  return {
    ...(p as unknown as PatientProfile),
    emailVerified: p.emailVerified === true,
    phoneVerified: p.phoneVerified === true,
  };
}