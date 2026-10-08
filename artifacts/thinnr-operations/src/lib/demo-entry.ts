/**
 * The one production switch for the guided demo.
 *
 * THINNR_DEMO (set per environment, compiled in by Vite as
 * VITE_THINNR_DEMO) decides whether the signed-out guided demo and its
 * personas can be entered at all:
 *   "on"  → demo entry available (development)
 *   "off" → demo entry removed (the published app)
 *   anything else → follow the build: development builds keep the demo,
 *                   production builds fail closed.
 *
 * Only demo ENTRY is switched here. Signed-in screens never render demo
 * content, whatever this says — they show live data or an honest empty state.
 */
export function resolveDemoEntry(raw: string | null | undefined, productionBuild: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  return !productionBuild;
}

// `import.meta.env` only exists under Vite. Node-run checks (tsx) have no
// such object, so each read is guarded and falls back to a development build.
function readSwitch(): string {
  try {
    return String(import.meta.env.VITE_THINNR_DEMO ?? '');
  } catch {
    return '';
  }
}

function readProductionBuild(): boolean {
  try {
    return import.meta.env.PROD === true;
  } catch {
    return false;
  }
}

/** True when the guided demo and its personas may be entered in this build. */
export const demoEntryEnabled: boolean = resolveDemoEntry(readSwitch(), readProductionBuild());
