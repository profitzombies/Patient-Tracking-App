/**
 * Demo-or-live data seam for a billing screen. The demo persona renders a
 * fixed dataset and never touches the network; a real account loads through
 * the authed client, re-reads on foreground, and surfaces load failures as
 * errors (never as an empty, healthy-looking screen).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { errorMessage } from '@/lib/patient-billing-core';

export interface BillingResource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  demo: boolean;
  /** Real accounts only; resolves to the fresh record or null when the read failed. */
  reload: () => Promise<T | null>;
  setData: (next: T | null | ((current: T | null) => T | null)) => void;
  setError: (message: string | null) => void;
}

export function useBillingResource<T>(load: () => Promise<T>, demoValue: () => T | null): BillingResource<T> {
  const { account } = usePatientAccount();
  const demo = account.kind === 'demo';
  const live = account.kind === 'real';
  const [data, setData] = useState<T | null>(() => (demo ? demoValue() : null));
  const [loading, setLoading] = useState(live);
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

  useEffect(() => {
    mounted.current = true;
    if (live) {
      setData(null);
      void reload();
    } else if (demo) {
      setData(demoValue());
      setLoading(false);
      setError(null);
    }
    return () => { mounted.current = false; };
    // demoValue is a pure selector over a fixed dataset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, demo, reload]);

  useEffect(() => {
    if (!live) return;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') void reload();
    });
    return () => listener.remove();
  }, [live, reload]);

  return { data, loading, error, demo, reload, setData, setError };
}
