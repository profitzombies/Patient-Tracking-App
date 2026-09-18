/**
 * Resolves the live Supabase session to a patient account and provides it
 * through PatientAccountContext. Mounted once in the root layout, above
 * PatientProvider; nothing else should render it.
 *
 * Resolution rules:
 *  - No Supabase config, or no session → demo account (the guided persona).
 *  - Session resolves to kind 'patient' via /api/claim/whoami → real
 *    account: PatientProvider hydrates that patient's live diary.
 *  - Session resolves to any staff or demo-profile kind → demo account: a
 *    provider browsing the patient persona sees the seeded demo, never a
 *    real patient's diary.
 *  - The lookup fails (server unreachable) → the last successful resolution
 *    for this SAME user id, if there is one, so an offline cold start still
 *    opens the patient's cached diary and offline queue; otherwise
 *    'unresolved': seedless and write-blocked behind a retry, because
 *    showing the demo seed to a possibly-real patient would present someone
 *    else's history as theirs.
 *
 * While a session's resolution is in flight the state reports
 * resolving=true and PatientProvider holds hydration, so a real patient
 * never sees a flash of the demo diary.
 *
 * Once a REAL account is resolved the provider also runs the app-presence
 * heartbeat (lib/patient-presence-heartbeat): one ping on resolve and one
 * per debounced return to the foreground, so HQ's active-user figures see
 * a patient who merely opens the app. Demo and staff sessions never ping.
 */
import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabaseConfigured, useSupabaseSession } from '@/lib/supabase';
import {
  fetchAccountRole,
  getSessionAccessToken,
  patientDataApi,
  type AccountRole,
} from '@/lib/patient-data-api';
import {
  clearCachedAccountRole,
  readCachedAccountRole,
  writeCachedAccountRole,
} from '@/lib/account-role-cache';
import { usePatientPresenceHeartbeat } from '@/lib/patient-presence-heartbeat';
import {
  DEMO_ACCOUNT_STATE,
  PatientAccountContext,
  type PatientAccount,
  type PatientAccountState,
} from './PatientAccountContext';

const ACCOUNT_LOOKUP_FAILED = 'Couldn’t load your account. Retry in a moment.';

export function PatientAccountProvider({ children }: { children: ReactNode }) {
  const { session, sessionLoading } = useSupabaseSession();
  const userId = session?.user?.id ?? null;

  const [attempt, setAttempt] = useState(0);
  const [resolved, setResolved] = useState<{
    forUserId: string;
    account: PatientAccount;
    notice: string | null;
  } | null>(null);

  useEffect(() => {
    if (!userId) {
      // Signed out (or never signed in): drop any previous resolution so a
      // later sign-in starts fresh.
      setResolved(null);
      // Only a settled signed-out state forgets the remembered role. While
      // the session is still loading (every cold start) userId is null too,
      // and wiping here would defeat the offline cold start it exists for.
      if (!sessionLoading) void clearCachedAccountRole();
      return;
    }
    let cancelled = false;
    const accountFor = (role: AccountRole): PatientAccount =>
      role.kind === 'patient'
        ? { kind: 'real', patientId: role.patientId, api: patientDataApi }
        : { kind: 'demo' };
    (async () => {
      try {
        const role = await fetchAccountRole();
        if (cancelled) return;
        setResolved({ forUserId: userId, account: accountFor(role), notice: null });
        void writeCachedAccountRole(userId, role);
      } catch {
        // Unreachable server: fall back to what this user resolved to last
        // time (offline cold start), else block behind a retry.
        const remembered = await readCachedAccountRole(userId).catch(() => null);
        if (cancelled) return;
        if (remembered) {
          setResolved({ forUserId: userId, account: accountFor(remembered), notice: null });
          return;
        }
        setResolved({
          forUserId: userId,
          account: { kind: 'unresolved' },
          notice: ACCOUNT_LOOKUP_FAILED,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, attempt, sessionLoading]);

  const retryResolve = useCallback(() => {
    // Clear a failed resolution first so the UI holds (resolving) rather
    // than staying on the failure while the retry runs.
    setResolved(prev => (prev?.account.kind === 'unresolved' ? null : prev));
    setAttempt(a => a + 1);
  }, []);

  const value = useMemo<PatientAccountState>(() => {
    if (!supabaseConfigured) return DEMO_ACCOUNT_STATE;
    if (sessionLoading) {
      return { resolving: true, account: { kind: 'demo' }, accountNotice: null, retryResolve };
    }
    if (!userId) {
      return { resolving: false, account: { kind: 'demo' }, accountNotice: null, retryResolve };
    }
    if (!resolved || resolved.forUserId !== userId) {
      return {
        resolving: true,
        account: { kind: 'demo' },
        accountNotice: null,
        retryResolve,
        getAccessToken: getSessionAccessToken,
      };
    }
    return {
      resolving: false,
      account: resolved.account,
      accountNotice: resolved.notice,
      retryResolve,
      // A live session exists (real, unresolved, or staff browsing the demo
      // persona): expose its bearer supplier. Consumers decide per account
      // kind whether to authenticate a call with it.
      getAccessToken: getSessionAccessToken,
    };
  }, [sessionLoading, userId, resolved, retryResolve]);

  usePatientPresenceHeartbeat(value.account, value.resolving);

  return <PatientAccountContext.Provider value={value}>{children}</PatientAccountContext.Provider>;
}
