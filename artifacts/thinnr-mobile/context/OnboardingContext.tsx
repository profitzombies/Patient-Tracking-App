/**
 * State for the new-patient onboarding flow.
 *
 * The DEMO persona's run is a repeatable in-memory simulation: nothing
 * persists, nothing touches Emma's seeded patient state or any storage key,
 * and resetting happens when the user starts a new run from the patient
 * entry screen — exactly as before accounts existed.
 *
 * A REAL signed-in patient gets the same screens, but every legitimate
 * advance saves the answers gathered so far to the account (a partial flag
 * merge), and finishing the run marks onboarding complete and derives the
 * notification preferences — so the answers survive reload and reinstall.
 * Saves go through the patient store's gated flag queue: they wait for the
 * account's server truth (never racing hydration), newer answers coalesce
 * over older ones while a push is in flight, and a failed push surfaces a
 * retryable sync notice instead of being dropped. Intermediate steps stay
 * non-blocking; final completion waits for server confirmation before Today
 * is allowed to open.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { router, type Href } from 'expo-router';
import {
  DEFAULT_ANSWERS,
  formatUsPhone,
  PREFERENCE_ANSWER_KEYS,
  stepOrderIndex,
  visibleSteps,
  type OnboardingAnswers,
  type PreferenceAnswer,
  type StepKey,
} from '@/data/onboarding-data';
import { dietWritesFor } from '@/lib/onboarding-diet-writes';
import {
  usePatientAccount,
  type PatientFlagsWrite,
  type PatientProfile,
  type PatientSetupWrite,
} from './PatientAccountContext';
// Aliased (not relative) so Node suites can substitute a patient-store stub.
import { usePatientOptional } from '@/context/PatientContext';

interface OnboardingContextValue {
  /** True while a run is live (guards deep links; cleared after completion). */
  begun: boolean;
  answers: OnboardingAnswers;
  /** Furthest step (in flow order) the user has legitimately reached. */
  furthest: StepKey;
  saving: boolean;
  saveError: string | null;
  patch: (partial: Partial<OnboardingAnswers>) => void;
  /** Fresh answers + mark the run as begun. */
  reset: () => void;
  /** Record that the user advanced to `key` through the flow. */
  advance: (key: StepKey) => Promise<boolean>;
  /** End the run after completion so stale history redirects to a fresh start. */
  endRun: () => Promise<boolean>;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

function freshAnswers(): OnboardingAnswers {
  return {
    ...DEFAULT_ANSWERS,
    dietAnswers: { ...DEFAULT_ANSWERS.dietAnswers },
    allergies: [...DEFAULT_ANSWERS.allergies],
    sensitivities: [...DEFAULT_ANSWERS.sensitivities],
    restrictions: [...DEFAULT_ANSWERS.restrictions],
    dislikes: [...DEFAULT_ANSWERS.dislikes],
  };
}

function isPreferenceAnswer(value: unknown): value is PreferenceAnswer {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.key === null || typeof v.key === 'string') && typeof v.label === 'string';
}

/**
 * Overlay a real account's on-file profile onto `base`: identity (name,
 * email, phone — the phone shown in the same US mask the step types in) plus
 * the body/program facts the account already knows.
 */
function withProfile(base: OnboardingAnswers, p: PatientProfile): OnboardingAnswers {
  const birth = p.dateOfBirth?.split('-') ?? [];
  return {
    ...base,
    name: [p.firstName, p.lastName].filter(Boolean).join(' '),
    email: p.email ?? '',
    phone: formatUsPhone(p.phone),
    heightUnit: 'imperial',
    heightFt: p.heightInches ? Math.floor(p.heightInches / 12) : base.heightFt,
    heightIn: p.heightInches ? Math.round(p.heightInches % 12) : base.heightIn,
    currentWeight: p.currentWeight === null ? '' : String(p.currentWeight),
    goalWeight: p.goalWeight === null ? '' : String(p.goalWeight),
    gender: p.gender ?? base.gender,
    birthYear: birth[0] ?? '',
    birthMonth: birth[1] ? Number(birth[1]) : null,
    birthDay: birth[2] ?? '',
    program:
      p.programId === 'thinnr' || p.programId === 'glp1' || p.programId === 'none'
        ? p.programId
        : null,
    programStartDate: p.programStartDate ?? '',
  };
}

/**
 * Rebuild answers from the account's stored copy. Only known answer keys
 * apply (defaults fill the rest), and stored notification prefs — the
 * finished run's derived truth — override their answer keys when present.
 */
function restoredAnswers(
  raw: Record<string, unknown>,
  prefs: Record<string, unknown> | null,
): OnboardingAnswers {
  const base = freshAnswers() as unknown as Record<string, unknown>;
  const source: Record<string, unknown> = prefs ? { ...raw, ...prefs } : raw;
  for (const key of Object.keys(base)) {
    if (!(key in source)) continue;
    if ((PREFERENCE_ANSWER_KEYS as readonly string[]).includes(key)) {
      const items = source[key];
      if (Array.isArray(items)) base[key] = items.filter(isPreferenceAnswer);
    } else if (key === 'dietAnswers') {
      const answers = source[key];
      if (answers && typeof answers === 'object' && !Array.isArray(answers)) base[key] = answers;
    } else {
      base[key] = source[key];
    }
  }
  return base as unknown as OnboardingAnswers;
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { account } = usePatientAccount();
  const [begun, setBegun] = useState(false);
  const [furthest, setFurthest] = useState<StepKey>('welcome');
  const [answers, setAnswers] = useState<OnboardingAnswers>(freshAnswers);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Mirrors `answers` synchronously: a screen patches and advances in the
  // same tick, so the save that rides the advance must see the just-patched
  // values, not the state from the previous render.
  const answersRef = useRef(answers);
  const accountRef = useRef(account);
  accountRef.current = account;

  // The patient store owns the actual write (gated on server truth, with a
  // retryable notice on failure). Optional so the standalone Node suite
  // mounts — OnboardingProvider without PatientProvider — still work; in
  // the app the root layout always nests this provider inside it.
  const patient = usePatientOptional();
  const profileRef = useRef<PatientProfile | null>(patient?.profile ?? null);
  profileRef.current = patient?.profile ?? null;
  const saveFlagsRef = useRef<((flags: Partial<PatientFlagsWrite>) => void) | null>(null);
  saveFlagsRef.current = patient?.saveOnboardingFlags ?? null;

  const pushFlags = useCallback((flags: Partial<PatientFlagsWrite>) => {
    if (accountRef.current.kind !== 'real') return;
    saveFlagsRef.current?.(flags);
  }, []);

  // A signed-in patient's saved answers come back with account hydration
  // (reload, reinstall, new device). Reconcile once per account key: a key
  // change first resets to fresh answers so one account's answers never
  // show under another (or under the demo persona), then the account's
  // stored answers apply. Never touches a live run, and the demo persona —
  // which has no hydration — behaves exactly as before accounts existed.
  const hydratedFlags = patient?.hydratedFlags ?? null;
  const accountId = account.kind === 'real' ? account.patientId : null;
  const reconcileKeyRef = useRef<string | null>(null);
  const appliedServerRef = useRef(false);
  useEffect(() => {
    const key = accountId ?? 'demo';
    if (reconcileKeyRef.current !== key) {
      const firstMount = reconcileKeyRef.current === null;
      reconcileKeyRef.current = key;
      appliedServerRef.current = false;
      if (!firstMount && !begun) {
        answersRef.current = freshAnswers();
        setAnswers(answersRef.current);
        setFurthest('welcome');
      }
    }
    if (!accountId || !hydratedFlags || appliedServerRef.current) return;
    appliedServerRef.current = true;
    if (begun || !hydratedFlags.onboardingAnswers) return;
    answersRef.current = restoredAnswers(
      hydratedFlags.onboardingAnswers,
      hydratedFlags.notificationPrefs,
    );
    setAnswers(answersRef.current);
  }, [accountId, hydratedFlags, begun]);

  useEffect(() => {
    if (!accountId || begun || !patient?.profile) return;
    answersRef.current = withProfile(answersRef.current, patient.profile);
    setAnswers(answersRef.current);
  }, [accountId, begun, patient?.profile]);

  const patch = useCallback((partial: Partial<OnboardingAnswers>) => {
    answersRef.current = { ...answersRef.current, ...partial };
    setAnswers(answersRef.current);
    setSaveError(null);
  }, []);

  // A fresh start (the welcome screen) must not wipe what a real account
  // already has on file — otherwise "Confirm your details" opens empty and the
  // prefill effect above never re-runs once the run has begun.
  const reset = useCallback(() => {
    const profile = profileRef.current;
    answersRef.current =
      accountRef.current.kind === 'real' && profile
        ? withProfile(freshAnswers(), profile)
        : freshAnswers();
    setAnswers(answersRef.current);
    setFurthest('welcome');
    setBegun(true);
    setSaveError(null);
  }, []);

  const setupPayload = useCallback(() => {
    const a = answersRef.current;
    const birthDate =
      a.birthMonth && a.birthDay && a.birthYear
        ? `${a.birthYear.padStart(4, '0')}-${String(a.birthMonth).padStart(2, '0')}-${a.birthDay.padStart(2, '0')}`
        : null;
    const heightInches =
      a.heightUnit === 'metric'
        ? Math.round((a.heightCm / 2.54) * 10) / 10
        : a.heightFt * 12 + a.heightIn;
    const nameParts = a.name.trim().split(/\s+/).filter(Boolean);
    const inPounds = (raw: string) => {
      const value = Number(raw);
      if (!value) return undefined;
      return a.heightUnit === 'metric' ? Math.round(value * 2.20462 * 10) / 10 : value;
    };
    return {
      profile: {
        ...(nameParts[0] ? { firstName: nameParts[0] } : {}),
        ...(nameParts[1] ? { lastName: nameParts.slice(1).join(' ') } : {}),
        ...(birthDate ? { dateOfBirth: birthDate } : {}),
        // Gender reaches the server profile so the diet picker can ask the
        // female-only pregnancy question and the target calculator has BMR
        // inputs — without it every patient looks genderless to the server.
        ...(a.gender ? { gender: a.gender } : {}),
        ...(heightInches >= 24 && heightInches <= 96 ? { heightInches } : {}),
        ...(inPounds(a.currentWeight)
          ? { startingWeight: inPounds(a.currentWeight), currentWeight: inPounds(a.currentWeight) }
          : {}),
        ...(inPounds(a.goalWeight) ? { goalWeight: inPounds(a.goalWeight) } : {}),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        ...(a.program ? { programId: a.program } : {}),
        ...(a.programStartDate ? { programStartDate: a.programStartDate } : {}),
      },
      onboardingAnswers: a,
    };
  }, []);

  const advance = useCallback(
    async (key: StepKey): Promise<boolean> => {
      if (accountRef.current.kind === 'real') {
        setSaving(true);
        const saved = await (patient?.saveSetup(setupPayload()) ?? Promise.resolve(false));
        setSaving(false);
        if (!saved) {
          setSaveError('That step didn’t save. Check your connection and try again.');
          return false;
        }
      } else {
        pushFlags({ onboardingAnswers: answersRef.current });
      }
      setFurthest(prev => (stepOrderIndex(key) > stepOrderIndex(prev) ? key : prev));
      return true;
    },
    [patient, pushFlags, setupPayload],
  );

  const endRun = useCallback(async (): Promise<boolean> => {
    const final = answersRef.current;
    const payload = {
      profile: setupPayload().profile as PatientSetupWrite,
      onboardingAnswers: final,
      notificationPrefs: {
        notifications: final.notifications,
        reminderMorning: final.reminderMorning,
        reminderAfternoon: final.reminderAfternoon,
        reminderEvening: final.reminderEvening,
        injectionDay: final.injectionDay,
        injectionTime: final.injectionTime,
      },
    };
    if (accountRef.current.kind !== 'real') {
      setBegun(false);
      return true;
    }
    const saved = await (patient?.completeSetup(payload) ?? Promise.resolve(false));
    if (saved) {
      setBegun(false);
      // Diet + list answers ride the offline write queue AFTER completion is
      // confirmed: a failed or slow diet write must never block entry to the
      // app, and the queue retries it on its own.
      if (patient) void dietWritesFor(final, patient);
    }
    return saved;
  }, [patient, setupPayload]);

  const value = useMemo<OnboardingContextValue>(
    () => ({ begun, answers, furthest, saving, saveError, patch, reset, advance, endRun }),
    [begun, answers, furthest, saving, saveError, patch, reset, advance, endRun],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

export function useOnboarding() {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used within OnboardingProvider');
  return ctx;
}

/**
 * Position of a step within the currently visible flow (conditional steps
 * collapse based on answers), plus navigation helpers.
 */
export function useOnboardingFlow(current: StepKey) {
  const { answers, advance, saving, saveError } = useOnboarding();
  const { account } = usePatientAccount();
  const steps = visibleSteps(answers, account.kind === 'real');
  const index = steps.indexOf(current);

  const goNext = useCallback(() => {
    const next = steps[index + 1];
    if (next) {
      if (account.kind !== 'real') {
        void advance(next);
        router.push(`/onboarding/${next}` as Href);
        return;
      }
      void (async () => {
        const saved = await advance(next);
        if (saved) router.push(`/onboarding/${next}` as Href);
      })();
    }
  }, [steps, index, advance, account.kind]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/patient-welcome' as Href);
  }, []);

  // The step counter and progress bar ride the maximal possible path so the
  // total never changes mid-flow: answers that hide steps make the counter
  // jump forward past them ("Step 12 of 21" → "Step 14 of 21") instead of
  // renumbering everything behind you ("of 16" suddenly becoming "of 20").
  const maxPath = visibleSteps(
    { ...answers, program: 'glp1', started: 'no' },
    account.kind === 'real',
  );
  const displayIndex = maxPath.indexOf(current);
  const stepNumber = (displayIndex === -1 ? index : displayIndex) + 1;
  const stepCount = maxPath.length;
  return {
    stepNumber,
    stepCount,
    progress: stepCount > 0 ? (stepNumber / stepCount) * 100 : 0,
    goNext,
    goBack,
    saving,
    saveError,
  };
}
