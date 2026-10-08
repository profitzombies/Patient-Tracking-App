/**
 * Whether this screen may show demo labels ("SYNTHETIC DEMO DATA", the
 * seeded persona's initials). Only a signed-out visitor of a demo-enabled
 * build sees them; any live session — patient, staff, or still resolving —
 * never does, whatever the demo switch says.
 */
import { usePatientAccount } from '@/context/PatientAccountContext';
import { showsDemoLabels } from '@/lib/demo-entry';

/**
 * True while a live session exists on this device (any role), or while the
 * stored session is still being checked — so a signed-in visitor never sees
 * a flash of demo labels on launch.
 */
export function useSignedIn(): boolean {
  // The account context exposes a bearer supplier exactly when a live
  // session exists; the signed-out demo default omits it and is not resolving.
  const { getAccessToken, resolving } = usePatientAccount();
  return Boolean(getAccessToken) || resolving === true;
}

export function useDemoLabels(): boolean {
  return showsDemoLabels(useSignedIn());
}

/**
 * True when patient screens must show the account's own values (or an honest
 * blank) instead of the demo persona's: a resolved or failed account, or any
 * live session — including one still being resolved.
 */
export function useLivePatient(): boolean {
  const { account, getAccessToken, resolving } = usePatientAccount();
  return account.kind !== 'demo' || Boolean(getAccessToken) || resolving === true;
}
