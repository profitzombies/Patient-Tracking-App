import type { OfficeAccessSnapshot } from '@/lib/office-access-types';

export type OfficeAccessGateDecision =
  | { kind: 'allow' }
  | { kind: 'hold' }
  | { kind: 'error' }
  | { kind: 'handoff'; missing: string[] };

const STAFF_PREFIXES = [
  '/patients',
  '/outcomes',
  '/leaderboard',
  '/payments',
  '/training',
  '/training-course/',
  '/training-lesson/',
  '/training-teammate/',
  '/patient/',
  '/office-patient/',
  '/sell-to-patient',
  '/claim-account',
];

export function isProviderArea(pathname: string): boolean {
  return pathname === '/' || STAFF_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function officeAccessGateDecision(input: {
  modeHydrated: boolean;
  mode: 'patient' | 'staff' | null;
  sessionLoading: boolean;
  signedIn: boolean;
  pathname: string;
  pending: boolean;
  failed: boolean;
  snapshot?: OfficeAccessSnapshot;
}): OfficeAccessGateDecision {
  if (!input.modeHydrated || input.sessionLoading) return { kind: 'hold' };
  // Signed-out staff and every patient route retain their existing admission policy.
  if (input.mode !== 'staff' || !input.signedIn || !isProviderArea(input.pathname)) {
    return { kind: 'allow' };
  }
  if (input.pending) return { kind: 'hold' };
  if (input.failed || !input.snapshot) return { kind: 'error' };
  if (input.snapshot.complete) return { kind: 'allow' };
  return {
    kind: 'handoff',
    missing: input.snapshot.steps
      .filter((step) => step.status !== 'done')
      .map((step) => step.detail?.trim() || step.id.replace(/_/g, ' ')),
  };
}