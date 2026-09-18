import { useMemo } from 'react';
import { useSession } from '@/contexts/session';
import { useScopedPatients } from '@/data/scoped-data';
import { buildDemoAttentionItems } from '@/data/attention-demo';
import { useLiveRoster } from '@/hooks/use-live-roster';
import { patientsBadge, type PatientsBadge } from '@/lib/patients-badge';

/**
 * Counts behind the Patients menu badge and the header quick-search.
 *
 * Live scopes read the roster summary from the SAME cached roster query the
 * Patients page uses (identical query key, so no second poll). The guided
 * demo persona counts the seeded roster with the demo attention rules the
 * bell and the "Needs attention" page already share. While the auth session
 * is still resolving nothing is known, so the badge shows no number.
 */
export function usePatientsBadge() {
  const { authStatus } = useSession();
  const roster = useLiveRoster();
  const patients = useScopedPatients();
  const demoFlagged = useMemo(
    () => (roster.liveEnabled ? null : new Set(buildDemoAttentionItems(patients).map((item) => item.patientId))),
    [roster.liveEnabled, patients],
  );

  const badge: PatientsBadge = useMemo(() => {
    if (roster.liveEnabled) {
      const summary = roster.data?.summary;
      return patientsBadge({ total: summary?.totalPatients ?? null, flagged: summary?.attention ?? null });
    }
    if (authStatus === 'loading') return patientsBadge({ total: null, flagged: null });
    return patientsBadge({ total: patients.length, flagged: demoFlagged?.size ?? 0 });
  }, [roster.liveEnabled, roster.data, authStatus, patients, demoFlagged]);

  return {
    badge,
    liveEnabled: roster.liveEnabled,
    /** Live roster rows for the quick-search; undefined until loaded (or in demo). */
    livePatients: roster.liveEnabled ? roster.data?.patients : undefined,
    liveRosterReady: roster.liveEnabled && roster.data !== undefined,
    /** Seeded roster rows (demo persona only). */
    demoPatients: patients,
  };
}
