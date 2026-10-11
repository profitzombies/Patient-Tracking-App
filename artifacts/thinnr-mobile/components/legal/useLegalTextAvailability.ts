/**
 * Whether the full legal text for `requiredVersion` is readable right now.
 *
 * The consent screen refuses to record agreement until this says `current`:
 * a patient must be able to open the exact text behind the version the
 * server will store. Bundled copy of that version → current at once, no
 * network. Otherwise the API is asked (and the shared cache keeps the result
 * for the reader sheet); a stale or failed answer is `unavailable` with a
 * retry.
 */
import { useCallback, useEffect, useState } from 'react';
import { loadLegalDocuments } from '@/lib/legal-documents';

export type LegalTextAvailability = 'current' | 'loading' | 'unavailable';

export function useLegalTextAvailability(requiredVersion: string | null): {
  availability: LegalTextAvailability;
  retry: () => void;
} {
  const [availability, setAvailability] = useState<LegalTextAvailability>('loading');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (requiredVersion === null) {
      setAvailability('current');
      return;
    }
    let active = true;
    setAvailability('loading');
    loadLegalDocuments(requiredVersion).then(result => {
      if (active) setAvailability(result.current ? 'current' : 'unavailable');
    });
    return () => { active = false; };
  }, [requiredVersion, attempt]);

  const retry = useCallback(() => setAttempt(n => n + 1), []);
  return { availability, retry };
}
