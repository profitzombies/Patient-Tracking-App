/**
 * The one production switch for the guided demo — the mobile copy of the
 * operations web app's src/lib/demo-entry.ts (same rule, same values).
 *
 * THINNR_DEMO is set per environment and compiled into the bundle as
 * EXPO_PUBLIC_THINNR_DEMO (the dev script and scripts/build.js pass it on):
 *   "on"  → demo entry available (development)
 *   "off" → demo entry removed (the published app)
 *   anything else → follow the build: development bundles keep the demo,
 *                   production bundles fail closed.
 *
 * Only demo ENTRY is switched here: the seeded patient walkthrough, the
 * signed-out provider dashboard, the persona picker's demo cards and the
 * claim test screen. Signed-in screens never show demo content, whatever
 * this says — they show live data or an honest empty state.
 */
import { isProviderArea } from '@/lib/office-access-gate';

export function resolveDemoEntry(raw: string | null | undefined, productionBuild: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  return !productionBuild;
}

function readProductionBuild(): boolean {
  // __DEV__ is a React Native global. Node-run checks (tsx) have none and
  // count as a development build.
  return typeof __DEV__ === 'boolean' ? !__DEV__ : false;
}

/** True when the guided demo and its personas may be entered in this build. */
// The literal `process.env.EXPO_PUBLIC_…` read is what Expo inlines at
// bundle time; do not destructure or index it.
export const demoEntryEnabled: boolean = resolveDemoEntry(
  process.env.EXPO_PUBLIC_THINNR_DEMO,
  readProductionBuild(),
);

/** Footer line under demo screens; real accounts get the plain advice notice. */
export const DEMO_DISCLAIMER = 'SYNTHETIC DEMO DATA  •  NOT MEDICAL ADVICE';
export const ADVICE_DISCLAIMER = 'NOT MEDICAL ADVICE';

/** Demo labels only ever show to signed-out visitors of a demo-enabled build. */
export function showsDemoLabels(signedIn: boolean, enabled: boolean = demoEntryEnabled): boolean {
  return enabled && !signedIn;
}

export function disclaimerText(signedIn: boolean, enabled: boolean = demoEntryEnabled): string {
  return showsDemoLabels(signedIn, enabled) ? DEMO_DISCLAIMER : ADVICE_DISCLAIMER;
}

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
 * Where a signed-out visitor on a provider screen goes when the demo is
 * switched off, or null when the screen may render. Claiming an account is a
 * real signed-out flow and is never redirected; everything else in the
 * provider area only ever showed the seeded office to signed-out visitors.
 * Outside staff mode the tab bar's own layout redirects its screens, so only
 * the provider screens outside it are handled here.
 */
export function providerDemoRedirect(input: {
  enabled: boolean;
  modeHydrated: boolean;
  mode: 'staff' | 'patient' | null;
  sessionLoading: boolean;
  signedIn: boolean;
  pathname: string;
}): '/provider-login' | '/patient-welcome' | null {
  if (input.enabled || !input.modeHydrated || input.sessionLoading || input.signedIn) return null;
  if (input.pathname.startsWith('/claim-account')) return null;
  if (!isProviderArea(input.pathname)) return null;
  if (input.mode !== 'staff' && isStaffTabRoute(input.pathname)) return null;
  return input.mode === 'staff' ? '/provider-login' : '/patient-welcome';
}
