/**
 * Data seam for a billing screen. A real account loads through the authed
 * client, re-reads on foreground, and surfaces load failures as errors
 * (never as an empty, healthy-looking screen). Until the account resolves,
 * and while signed out, the screen stays in its loading state and no
 * request is made.
 *
 * Two kinds of re-read:
 *  - `reload()` is the blocking path (first load, Retry): it clears the error
 *    and shows the loading state.
 *  - `refresh()` is the pull-to-refresh / header Refresh path: the last good
 *    record stays on screen, `refreshing` flips for the spinner, and a failed
 *    read resolves with a message for a non-blocking notice instead of
 *    replacing the screen.
 *
 * Screens that write elsewhere (checkout) mark a resource stale through
 * `invalidateBillingResources`; any mounted live resource under that name
 * re-reads at once, and later mounts always start with a fresh read.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { errorMessage } from '@/lib/patient-billing-core';

export type BillingResourceName = 'orders' | 'order' | 'subscriptions' | 'subscription';

export interface BillingResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** True while a non-blocking refresh is in flight. */
  refreshing: boolean;
  /** Real accounts only; resolves to the fresh record or null when the read failed. */
  reload: () => Promise<T | null>;
  /** Keeps the current record visible; resolves to a failure message, or null when the read landed. */
  refresh: () => Promise<string | null>;
  setData: (next: T | null | ((current: T | null) => T | null)) => void;
  setError: (message: string | null) => void;
}

type Listener = () => void;
const listeners = new Map<BillingResourceName, Set<Listener>>();

/** Ask every mounted live resource under these names to re-read now. */
export function invalidateBillingResources(names: readonly BillingResourceName[]): void {
  for (const name of names) {
    for (const listener of listeners.get(name) ?? []) listener();
  }
}

function subscribe(name: BillingResourceName, listener: Listener): () => void {
  const set = listeners.get(name) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(name, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(name);
  };
}

export function useBillingResource<T>(
  load: () => Promise<T>,
  name?: BillingResourceName,
): BillingResource<T> {
  const { account, resolving } = usePatientAccount();
  const live = account.kind === 'real';
  // Signed out there is nothing to read: the root layout is already
  // redirecting to sign-in, so hold the loading frame (no rows, no refresh
  // controls) rather than a healthy-looking empty list. An 'unresolved'
  // account leaves the screen on its own account notice.
  const holding = resolving || account.kind === 'signed-out';
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(live || holding);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async (): Promise<T | null> => {
    if (!live) return null;
    setLoading(true);
    setError(null);
    try {
      const result = await loader.current();
      if (mounted.current) setData(result);
      return result;
    } catch (caught) {
      if (mounted.current) setError(errorMessage(caught));
      return null;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [live]);

  const refresh = useCallback(async (): Promise<string | null> => {
    if (!live) return null;
    setRefreshing(true);
    try {
      const result = await loader.current();
      if (mounted.current) {
        setData(result);
        setError(null);
      }
      return null;
    } catch (caught) {
      return errorMessage(caught);
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [live]);

  useEffect(() => {
    mounted.current = true;
    if (live) {
      setData(null);
      void reload();
    } else {
      setData(null);
      setLoading(holding);
      setError(null);
    }
    return () => { mounted.current = false; };
  }, [live, holding, reload]);

  useEffect(() => {
    if (!live) return;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void reload();
    });
    return () => listener.remove();
  }, [live, reload]);

  useEffect(() => {
    if (!live || !name) return;
    return subscribe(name, () => { void refresh(); });
  }, [live, name, refresh]);

  return { data, loading, error, refreshing, reload, refresh, setData, setError };
}
