/**
 * Session-derived switches for patient screens. A signed-in visitor (any
 * role), or one whose stored session is still being checked, is treated as
 * live from the first render so no signed-out fallback ever flashes.
 */
import { usePatientAccount } from '@/context/PatientAccountContext';

/**
 * True while a live session exists on this device (any role), or while the
 * stored session is still being checked.
 */
export function useSignedIn(): boolean {
  // The account context exposes a bearer supplier exactly when a live
  // session exists; the signed-out default omits it and is not resolving.
  const { getAccessToken, resolving } = usePatientAccount();
  return Boolean(getAccessToken) || resolving === true;
}

/**
 * True when patient screens must show the account's own values (or an honest
 * blank): a resolved or failed account, or any live session — including one
 * still being resolved.
 */
export function useLivePatient(): boolean {
  const { account, getAccessToken, resolving } = usePatientAccount();
  return account.kind !== 'demo' || Boolean(getAccessToken) || resolving === true;
}
