/**
 * The diet notices (provider changed your diet / pregnancy conflict) for the
 * signed-in account, with device-local dismissal. Signed-out shells never
 * show them.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePatient } from '@/context/PatientContext';
import { usePatientAccount } from '@/context/PatientAccountContext';
import { dietNoticesFor, dismissDietNotice, loadDietDismissals, type DietNotice } from '@/lib/diet-notices';

type Dismissals = Awaited<ReturnType<typeof loadDietDismissals>>;

export function useDietNotices(): { notices: DietNotice[]; dismiss: (notice: DietNotice) => void } {
  const { account } = usePatientAccount();
  const { diet } = usePatient();
  const [dismissals, setDismissals] = useState<Dismissals | null>(null);
  const accountKey = account.kind === 'real' ? `real:${account.patientId}` : account.kind;

  useEffect(() => {
    let active = true;
    void loadDietDismissals().then(loaded => {
      if (active) setDismissals(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  const dismiss = useCallback((notice: DietNotice) => {
    const kind = notice.kind === 'provider_change' ? 'providerChange' : 'pregnancyConflict';
    void dismissDietNotice(kind, accountKey, notice.id).then(setDismissals);
  }, [accountKey]);

  const notices = account.kind === 'real' && dismissals ? dietNoticesFor(diet, accountKey, dismissals) : [];
  return { notices, dismiss };
}
