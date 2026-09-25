/**
 * What a just-finished signup already knows about the new account.
 *
 * Account creation answers with the patient id and the account's privacy
 * state, so the app can open the consent page the moment the session lands
 * instead of waiting on the account lookup and the full data hydration.
 *
 * The seed only ever NARROWS access: it describes an account with no
 * consent on record, which the entry gate parks on /consent. Everything
 * past consent (onboarding, protected screens) still waits for server
 * truth — the seed is consumed by the first hydration and never reused,
 * and the normal account lookup still runs and overrides it.
 */
import type { PrivacyState } from '@/lib/patient-privacy';

export interface SignupSeed {
  patientId: string;
  privacy: PrivacyState;
}

/** A seed older than this is stale (an abandoned sign-in) and ignored. */
export const SIGNUP_SEED_TTL_MS = 2 * 60_000;

let current: (SignupSeed & { at: number; userId: string | null }) | null = null;

/** Set just before the new session is created; replaced by any later signup. */
export function setSignupSeed(seed: SignupSeed, now = Date.now()): void {
  current = { ...seed, at: now, userId: null };
}

export function clearSignupSeed(): void {
  current = null;
}

function fresh(now: number): (SignupSeed & { at: number; userId: string | null }) | null {
  if (current && now - current.at > SIGNUP_SEED_TTL_MS) current = null;
  return current;
}

/**
 * The seeded patient id for the account lookup, if a signup just finished.
 * The first session that asks owns the seed; any other login gets nothing.
 * Read-only otherwise: the hydration below still needs the seed.
 */
export function peekSignupSeed(userId: string, now = Date.now()): SignupSeed | null {
  const seed = fresh(now);
  if (!seed) return null;
  if (seed.userId === null) seed.userId = userId;
  if (seed.userId !== userId) return null;
  return { patientId: seed.patientId, privacy: seed.privacy };
}

/**
 * One-shot: hand the seed to the first hydration of the same patient and
 * forget it, so every later hydration (consent landing, a retry, a cold
 * start) reads the server. A seed for an account that already has consent
 * is never used — there is nothing to narrow.
 */
export function takeSignupSeed(patientId: string, now = Date.now()): SignupSeed | null {
  const seed = fresh(now);
  if (!seed || seed.patientId !== patientId) return null;
  current = null;
  if (seed.privacy.consent.satisfied || seed.privacy.deletion) return null;
  return { patientId: seed.patientId, privacy: seed.privacy };
}
