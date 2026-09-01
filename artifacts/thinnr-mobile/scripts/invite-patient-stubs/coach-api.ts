/**
 * Controllable apiBase stub for the invite-patients suite ONLY. The real
 * module derives the base URL from EXPO_PUBLIC_DOMAIN and throws when it is
 * unset — the toggle below lets the suite exercise both branches.
 */

let throws = false;

export function __setApiBaseThrows(value: boolean): void {
  throws = value;
}

export function apiBase(): string {
  if (throws) throw new Error('EXPO_PUBLIC_DOMAIN is not configured');
  return 'http://api.test/api';
}
