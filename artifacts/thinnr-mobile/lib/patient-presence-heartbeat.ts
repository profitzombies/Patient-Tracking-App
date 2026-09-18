/**
 * App-presence heartbeat for real patient accounts.
 *
 * HQ counts a patient as an active app user on any day the app was opened,
 * so the account layer pings the server once when a real patient account
 * resolves and again each time the app returns to the foreground. Rules:
 *
 *  - Only `kind: 'real'` accounts ping. Demo, staff browsing the persona,
 *    and unresolved accounts never touch the network from here.
 *  - Foreground pings are debounced (HEARTBEAT_DEBOUNCE_MS) so bouncing in
 *    and out of the app does not spam the server; the server throttles too.
 *  - Every ping is fenced by the account epoch it was started under: a
 *    sign-out or account switch during the bearer lookup drops the ping
 *    rather than sending it under the wrong session. The bearer is read at
 *    ping time (not captured once) because sessions refresh hourly.
 *  - Failures are swallowed. Presence is best effort; the next authenticated
 *    request records it server-side anyway.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { getSessionAccessToken, sendPresenceHeartbeat } from '@/lib/patient-data-api';
import type { PatientAccount } from '@/context/PatientAccountContext';

export const HEARTBEAT_DEBOUNCE_MS = 60_000;

export interface HeartbeatDeps {
  getAccessToken?: () => Promise<string | null>;
  send?: (accessToken: string) => Promise<void>;
  now?: () => number;
}

/**
 * Returns the ping function for one account epoch. Exported for the
 * hermetic suite; the hook below is what the provider uses.
 */
export function createHeartbeat(deps: HeartbeatDeps = {}) {
  const getToken = deps.getAccessToken ?? getSessionAccessToken;
  const send = deps.send ?? sendPresenceHeartbeat;
  const now = deps.now ?? (() => Date.now());
  let cancelled = false;
  let lastSentAt = -Infinity;
  let inFlight: Promise<void> | null = null;
  const ping = (force: boolean): Promise<void> => {
    if (cancelled) return Promise.resolve();
    if (!force && now() - lastSentAt < HEARTBEAT_DEBOUNCE_MS) return Promise.resolve();
    if (inFlight) return inFlight;
    lastSentAt = now();
    inFlight = (async () => {
      try {
        const token = await getToken();
        if (cancelled || !token) return;
        await send(token);
      } catch {
        // Best effort: the next authenticated request records presence.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
  return {
    ping,
    cancel() {
      cancelled = true;
    },
  };
}

/** Ping on resolve and on every debounced return to the foreground. */
export function usePatientPresenceHeartbeat(account: PatientAccount, resolving: boolean, deps?: HeartbeatDeps) {
  const patientId = !resolving && account.kind === 'real' ? account.patientId : null;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    if (!patientId) return;
    const heartbeat = createHeartbeat(depsRef.current);
    void heartbeat.ping(true);
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void heartbeat.ping(false);
    });
    return () => {
      heartbeat.cancel();
      subscription.remove();
    };
  }, [patientId]);
}
