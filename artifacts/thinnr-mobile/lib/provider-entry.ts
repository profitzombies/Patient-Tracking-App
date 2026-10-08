/**
 * Signed-out visitors never reach the provider (office) area: those screens
 * only ever show a real office to a real staff session. Claiming an account
 * is a real signed-out flow and is never redirected.
 */
import { isProviderArea } from '@/lib/office-access-gate';

/** Screens inside the staff tab bar, whose layout already turns away other modes. */
function isStaffTabRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/patients' ||
    pathname === '/outcomes' ||
    pathname === '/leaderboard' ||
    pathname === '/training' ||
    pathname === '/payments' ||
    pathname.startsWith('/payments/')
  );
}

/**
 * Where a signed-out visitor on a provider screen goes, or null when the
 * screen may render. Outside staff mode the tab bar's own layout redirects its
 * screens, so only the provider screens outside it are handled here.
 */
export function providerSignedOutRedirect(input: {
  modeHydrated: boolean;
  mode: 'staff' | 'patient' | null;
  sessionLoading: boolean;
  signedIn: boolean;
  pathname: string;
}): '/provider-login' | '/patient-welcome' | null {
  if (!input.modeHydrated || input.sessionLoading || input.signedIn) return null;
  if (input.pathname.startsWith('/claim-account')) return null;
  if (!isProviderArea(input.pathname)) return null;
  if (input.mode !== 'staff' && isStaffTabRoute(input.pathname)) return null;
  return input.mode === 'staff' ? '/provider-login' : '/patient-welcome';
}
