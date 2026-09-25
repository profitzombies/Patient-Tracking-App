/**
 * Node stand-in for '@/context/PatientContext' (see
 * tsconfig.onboarding-identity.json `paths`).
 *
 * The identity-step suite needs a patient store that carries an on-file
 * profile without mounting the real PatientProvider (hydration, queues,
 * storage). Only the members the onboarding context and IdentityStep read
 * are provided; setup saves resolve immediately and are recorded.
 */
import React, { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { PatientProfile } from '../../context/PatientAccountContext';

export interface StubPatient {
  profile: PatientProfile | null;
  hydratedFlags: null;
  applyProfile: (profile: PatientProfile) => void;
  saveSetup: (payload: unknown) => Promise<boolean>;
  completeSetup: (payload: unknown) => Promise<boolean>;
  saveOnboardingFlags: (flags: unknown) => void;
}

export const setupSaves: unknown[] = [];

const Ctx = createContext<StubPatient | null>(null);

export function StubPatientProvider({
  initialProfile,
  children,
}: {
  initialProfile: PatientProfile | null;
  children: ReactNode;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const value = useMemo<StubPatient>(
    () => ({
      profile,
      hydratedFlags: null,
      applyProfile: setProfile,
      saveSetup: async payload => {
        setupSaves.push(payload);
        return true;
      },
      completeSetup: async () => true,
      saveOnboardingFlags: () => {},
    }),
    [profile],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePatient(): StubPatient {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePatient must be used within StubPatientProvider');
  return ctx;
}

export function usePatientOptional(): StubPatient | null {
  return useContext(Ctx);
}
