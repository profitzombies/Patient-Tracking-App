/**
 * Root-level surface for the patient store's sync notices: a rolled-back
 * real-account write, a failed live hydration, or a failed account lookup.
 * Rendered from the app layout (a sibling of the navigator) so
 * PatientContext itself stays free of UI imports that every Node test suite
 * would otherwise have to stub. A signed-out shell never sets a notice, so
 * this renders nothing there.
 */
import React from 'react';
import { Snackbar } from '@/components/ui/Snackbar';
import { usePatientSyncNotice } from '@/context/PatientContext';

export function PatientSyncNotice() {
  const notice = usePatientSyncNotice();
  if (!notice) return null;
  return (
    <Snackbar
      testID="patient-sync-notice"
      message={notice.message}
      actionLabel={notice.actionLabel}
      onAction={notice.onAction}
      actionTestID="patient-sync-notice-action"
    />
  );
}
