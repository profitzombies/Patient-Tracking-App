/**
 * Session persistence suite: a signed-in patient must stay signed in on the
 * same phone through anything that is not a real identity change, so login
 * codes (a paid text message each) stay rare.
 *
 * Runs the REAL lib/supabase.ts and the real @supabase/supabase-js client in
 * Node. GoTrue is a scripted fetch; the phone's storage is the in-memory
 * AsyncStorage stub; the clock is Date.now with an adjustable offset so the
 * client's retry window (30s) and refresh-failure cooldown (60s) pass without
 * waiting for them.
 *
 * Cases:
 *   1. transient 5xx does not sign out — expired access token at cold start,
 *      refresh answers 503: the hook keeps the stored session as stale, no
 *      SIGNED_OUT fires, storage is intact, fetchers fail as network errors
 *      (never "signed out"), and the held session goes live again as soon as
 *      the refresh succeeds — with no code requested in between.
 *   2. same device after 60 days does not — a session untouched for 60 days
 *      refreshes silently.
 *   3. new device requires a code — nothing stored means signed out; only a
 *      code exchange (verifyOtp) produces a session.
 *   4. definitive refusal signs out — GoTrue rejecting the refresh token
 *      (revoked / sign-out-everywhere) clears storage and the hook.
 *   5. explicit sign-out signs out.
 */
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://stubref.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
process.env.EXPO_PUBLIC_DOMAIN = 'thinnr.test';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ── Clock ────────────────────────────────────────────────────────────────────
const realNow = Date.now;
let clockOffsetMs = 0;
Date.now = () => realNow() + clockOffsetMs;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ── Captured stale-session retry timers (the hook's 15s poll) ────────────────
const realSetTimeout = globalThis.setTimeout;
const staleRetries: Array<() => void> = [];
let staleRetryDelay: number | null = null;
(globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms === staleRetryDelay) {
    staleRetries.push(fn);
    return realSetTimeout(() => {}, 0);
  }
  return (realSetTimeout as (...args: unknown[]) => unknown)(fn, ms, ...rest);
}) as typeof setTimeout;

// ── Scripted GoTrue + API ────────────────────────────────────────────────────
type Scripted = { status: number; body: unknown };
type Route = (url: string, init?: RequestInit) => Scripted;
const calls: string[] = [];
let refreshRoute: Route = () => ({ status: 500, body: { error: 'unscripted refresh' } });
let apiRoute: Route = () => ({ status: 200, body: { ok: true } });

const fakeUser = { id: 'user-1', aud: 'authenticated', role: 'authenticated', email: null, phone: '+15555550100', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
function sessionJson(tag: string, expiresInSeconds = 3600) {
  return {
    access_token: `access-${tag}`,
    token_type: 'bearer',
    expires_in: expiresInSeconds,
    expires_at: nowSeconds() + expiresInSeconds,
    refresh_token: `refresh-${tag}`,
    user: fakeUser,
  };
}
let refreshBodies: Array<{ refresh_token?: string }> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
  let out: Scripted;
  if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
    refreshBodies.push(JSON.parse(String(init?.body ?? '{}')));
    out = refreshRoute(url, init);
  } else if (url.includes('/auth/v1/logout')) {
    out = { status: 204, body: null };
  } else if (url.includes('/auth/v1/verify')) {
    out = { status: 200, body: sessionJson('fresh-device') };
  } else if (url.includes('/api/')) {
    out = apiRoute(url, init);
  } else {
    out = { status: 404, body: { error: `unscripted ${url}` } };
  }
  return new Response(out.body === null ? null : JSON.stringify(out.body), {
    status: out.status,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

// supabase-js logs every failed refresh through console.error; those are the
// failures this suite provokes on purpose, so keep them out of the output.
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (args.some(a => !!a && typeof a === 'object' && (a as { __isAuthError?: boolean }).__isAuthError)) return;
  realConsoleError(...args);
};

// ── Harness ─────────────────────────────────────────────────────────────────
let checks = 0;
let failures = 0;
const assert = (label: string, value: boolean) => {
  checks++;
  if (!value) {
    failures++;
    console.error('  FAIL ' + label);
  }
};
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise(resolve => realSetTimeout(resolve, 5));
    });
  }
};

async function main() {
  const lib = await import('../lib/supabase');
  const { STALE_SESSION_RETRY_MS, readStoredSession, resolveSessionAccessToken, sessionStorageKey, sessionStorageKeyFor, supabase, useSupabaseSession } = lib;
  staleRetryDelay = STALE_SESSION_RETRY_MS;
  const dataApi = await import('../lib/patient-data-api');
  const { PatientDataError } = await import('../lib/patient-data-error');
  if (!supabase || !sessionStorageKey) throw new Error('lib/supabase did not configure a client');

  // The storage key must be the library default or every installed phone
  // would come up signed out after this change shipped.
  assert('storage key matches supabase-js default', sessionStorageKey === 'sb-stubref-auth-token');
  assert('storage key derives from the project ref only', sessionStorageKeyFor('https://abc.supabase.co/') === 'sb-abc-auth-token' && sessionStorageKeyFor('http://localhost:54321') === 'sb-localhost-auth-token');

  const authEvents: string[] = [];
  supabase.auth.onAuthStateChange(event => {
    authEvents.push(event);
  });

  let latest: ReturnType<typeof useSupabaseSession> | null = null;
  function Probe() {
    latest = useSupabaseSession();
    return null;
  }
  let tree: ReactTestRenderer | null = null;
  const mount = async () => {
    latest = null;
    await act(async () => {
      tree = create(React.createElement(Probe));
    });
    await settle();
  };
  const unmount = async () => {
    if (tree) await act(async () => tree!.unmount());
    tree = null;
  };
  const seedStoredSession = async (tag: string, expiredForSeconds: number) => {
    const stored = { ...sessionJson(tag, 3600), expires_at: nowSeconds() - expiredForSeconds };
    await AsyncStorage.setItem(sessionStorageKey, JSON.stringify(stored));
  };
  const reset = () => {
    calls.length = 0;
    refreshBodies = [];
    authEvents.length = 0;
    staleRetries.length = 0;
  };
  const refreshCalls = () => calls.filter(c => c.includes('grant_type=refresh_token')).length;

  // ── 1. transient 5xx does not sign out ─────────────────────────────────────
  console.log('case 1: transient 5xx does not sign out');
  reset();
  await seedStoredSession('cold', 2 * 3600);
  refreshRoute = () => {
    // Jump past the client's 30s retry window so one 503 is one attempt.
    clockOffsetMs += 31_000;
    return { status: 503, body: { error: 'service unavailable' } };
  };
  await mount();
  let state = latest as ReturnType<typeof useSupabaseSession> | null;
  assert('1: refresh was attempted with the stored refresh token', refreshCalls() >= 1 && refreshBodies[0]?.refresh_token === 'refresh-cold');
  assert('1: hook holds the stored session as stale', !!state && state.session?.user.id === 'user-1' && state.sessionStale === true && state.sessionLoading === false);
  assert('1: no SIGNED_OUT fired', !authEvents.includes('SIGNED_OUT'));
  assert('1: storage still holds the session', (await readStoredSession())?.refresh_token === 'refresh-cold');
  const resolved = await resolveSessionAccessToken();
  assert('1: token resolution reads stale, not signed out', resolved.kind === 'stale');
  assert('1: lenient getter answers null (no expired bearer is sent)', (await dataApi.getSessionAccessToken()) === null);
  let strictError: unknown = null;
  try {
    await dataApi.requireSessionAccessToken();
  } catch (error) {
    strictError = error;
  }
  assert('1: strict getter throws the reconnecting error', lib.isSessionReconnectingError(strictError) && (strictError as Error).message === lib.SESSION_RECONNECTING_MESSAGE);
  let fetcherError: unknown = null;
  try {
    await dataApi.authedRequest('GET', '/patient-data/state');
  } catch (error) {
    fetcherError = error;
  }
  assert('1: authed fetch fails as a network error, never signedOut', fetcherError instanceof PatientDataError && fetcherError.kind === 'network' && !/signed out/i.test(fetcherError.message));
  assert('1: no API call went out with an expired bearer', !calls.some(c => c.includes('/api/')));
  assert('1: a stale retry is scheduled', staleRetries.length >= 1);

  // Still failing at the next retry: nothing changes, another retry is queued.
  clockOffsetMs += 61_000; // past the client's refresh-failure cooldown
  const scheduledBefore = staleRetries.length;
  await act(async () => {
    staleRetries[scheduledBefore - 1]?.();
  });
  await settle();
  state = latest;
  assert('1: second failure keeps the stale session held', !!state && state.sessionStale === true && state.session?.user.id === 'user-1' && !authEvents.includes('SIGNED_OUT'));
  assert('1: another retry queued after the second failure', staleRetries.length > scheduledBefore);

  // Server back: the next retry lands and the session goes live with no code.
  refreshRoute = () => ({ status: 200, body: sessionJson('recovered') });
  clockOffsetMs += 61_000;
  await act(async () => {
    staleRetries[staleRetries.length - 1]?.();
  });
  await settle();
  state = latest;
  assert('1: recovered session is live', !!state && state.sessionStale === false && state.session?.access_token === 'access-recovered');
  assert('1: TOKEN_REFRESHED fired, never SIGNED_OUT', authEvents.includes('TOKEN_REFRESHED') && !authEvents.includes('SIGNED_OUT'));
  assert('1: no code exchange happened', !calls.some(c => c.includes('/auth/v1/verify') || c.includes('/auth/v1/otp')));
  assert('1: fetchers now carry the new bearer', (await dataApi.getSessionAccessToken()) === 'access-recovered');
  await unmount();

  // ── 2. same device after 60 days does not ──────────────────────────────────
  console.log('case 2: same device after 60 days refreshes silently');
  reset();
  await unmount();
  await AsyncStorage.removeItem(sessionStorageKey);
  await seedStoredSession('sixty', 60 * 24 * 3600);
  refreshRoute = () => ({ status: 200, body: sessionJson('sixty-renewed') });
  await mount();
  state = latest;
  assert('2: session live after a 60-day-old token refreshes', !!state && state.sessionStale === false && state.session?.access_token === 'access-sixty-renewed');
  assert('2: refresh used the stored refresh token', refreshBodies.some(b => b.refresh_token === 'refresh-sixty'));
  assert('2: no code exchange', !calls.some(c => c.includes('/auth/v1/verify') || c.includes('/auth/v1/otp')));
  await unmount();

  // ── 3. new device requires a code ──────────────────────────────────────────
  console.log('case 3: new device requires a code');
  reset();
  await AsyncStorage.removeItem(sessionStorageKey);
  await mount();
  state = latest;
  assert('3: nothing stored reads as signed out (not stale)', !!state && state.session === null && state.sessionStale === false && state.sessionLoading === false);
  assert('3: no refresh attempted without a stored session', refreshCalls() === 0);
  assert('3: token resolution is signedOut', (await resolveSessionAccessToken()).kind === 'signedOut');
  let signedOutError: unknown = null;
  try {
    await dataApi.authedRequest('GET', '/patient-data/state');
  } catch (error) {
    signedOutError = error;
  }
  assert('3: fetchers report signedOut on a new device', signedOutError instanceof PatientDataError && signedOutError.kind === 'signedOut');
  await act(async () => {
    await supabase.auth.verifyOtp({ token_hash: 'hash', type: 'sms' });
  });
  await settle();
  state = latest;
  assert('3: only the code exchange produces a session', calls.some(c => c.includes('/auth/v1/verify')) && !!state && state.session?.access_token === 'access-fresh-device' && state.sessionStale === false);
  assert('3: the new session is persisted for next launch', (await readStoredSession())?.refresh_token === 'refresh-fresh-device');
  await unmount();

  // ── 4. definitive refusal signs out ────────────────────────────────────────
  console.log('case 4: revoked refresh token signs out');
  reset();
  await AsyncStorage.removeItem(sessionStorageKey);
  await seedStoredSession('revoked', 2 * 3600);
  refreshRoute = () => ({ status: 400, body: { error_code: 'refresh_token_not_found', code: 400, msg: 'Invalid Refresh Token: Refresh Token Not Found' } });
  clockOffsetMs += 61_000;
  await mount();
  state = latest;
  assert('4: hook is signed out after a definitive refusal', !!state && state.session === null && state.sessionStale === false);
  assert('4: SIGNED_OUT fired', authEvents.includes('SIGNED_OUT'));
  assert('4: storage cleared', (await readStoredSession()) === null);
  assert('4: fetchers report signedOut', (await resolveSessionAccessToken()).kind === 'signedOut');
  await unmount();

  // ── 5. explicit sign-out ───────────────────────────────────────────────────
  console.log('case 5: explicit sign-out');
  reset();
  await AsyncStorage.setItem(sessionStorageKey, JSON.stringify(sessionJson('live')));
  await mount();
  state = latest;
  assert('5: valid stored session is live without a refresh', !!state && state.session?.access_token === 'access-live' && state.sessionStale === false && refreshCalls() === 0);
  await act(async () => {
    await supabase.auth.signOut();
  });
  await settle();
  state = latest;
  assert('5: sign-out clears the hook and storage', !!state && state.session === null && (await readStoredSession()) === null && authEvents.includes('SIGNED_OUT'));
  await unmount();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
