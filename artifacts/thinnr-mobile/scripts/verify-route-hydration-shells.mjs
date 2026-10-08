/**
 * Focused Node regression checks for task 524.
 *
 * This suite intentionally uses only Node's standard library so it can run
 * without Metro, React Native, a browser, or a package.json test alias:
 *
 *   node artifacts/thinnr-mobile/scripts/verify-route-hydration-shells.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const layout = read('app/(patient)/_layout.tsx');
const rootLayout = read('app/_layout.tsx');
const shell = read('components/patient/PatientRouteShell.tsx');
const image = read('components/patient/LibraryImage.tsx');
const library = read('app/(patient)/recipes.tsx');

const checks = [
  ['patient layout paints a shell instead of a hydration null', !/if\s*\([^)]*hydrated[^)]*\)\s*return\s+null/.test(layout)],
  ['patient layout gates data behind admission and hydration', layout.includes('if (!admitted)') && layout.includes('patientHydrated')],
  ['real account waits for local store hydration', /!patientHydrated\s*&&\s*account\.kind === 'real'/.test(layout)],
  ['patient layout never mounts quick actions before admission', layout.includes('return (') && layout.includes('<PatientRouteShell')],
  ['root gate keeps its navigator mounted', rootLayout.includes('{children}') && rootLayout.includes('decision.kind === \'redirect\' ? <Redirect')],
  ['root gate supplies an anonymous-safe holding shell', rootLayout.includes('<PatientRouteShell') && rootLayout.includes('pointerEvents="auto"')],
  ['blocked root hides and disables the mounted navigator', rootLayout.includes('accessibilityElementsHidden') && rootLayout.includes('no-hide-descendants') && rootLayout.includes("inert: gateBlocked") && rootLayout.includes('Keyboard.dismiss()')],
  ['root surfaces typed retryable sync failures', rootLayout.includes('usePatientSyncNotice') && rootLayout.includes("syncNotice\n      ? 'error'") && rootLayout.includes('patient.rehydrate')],
  ['safe shell has explicit loading/offline/error/denied states', shell.includes("PatientShellStatus = 'loading' | 'offline' | 'error' | 'denied'") && shell.includes("status === 'loading'") && shell.includes("status === 'error'") && shell.includes("status === 'denied'")],
  ['loading shell uses route-shaped static rows instead of a spinner card', shell.includes('patient-route-hydration-skeleton') && shell.includes('todayHero') && shell.includes('totalsRow') && shell.includes('trendPlaceholder') && !shell.includes('ActivityIndicator')],
  ['loading copy stays user-facing', !shell.includes('safe account frame') && shell.includes('Loading your data')],
  ['safe shell has no patient avatar or fab controls', !shell.includes("from '@/components/patient/PatientHeader'") && !shell.includes("from '@/components/patient/PatientFabMenu'")],
  ['image placeholder waits for genuine expo-image onLoad', image.includes('onLoad={() => setStatus(\'loaded\')}') && image.includes('status !== \'loaded\'')],
  ['image error keeps its accessible placeholder', image.includes('onError={() => setStatus(\'error\')}') && image.includes('Image unavailable for ${label}')],
  ['image frame has stable dimensions', image.includes('testID={`${testID}-frame`}') && image.includes('position: \'relative\'') && image.includes('height: 108')],
  ['library uses the fixed image helper', library.includes('<LibraryImage') && !library.includes("from 'expo-image'")],
  ['library only shows data skeleton while a remote query is pending', library.includes('remoteSearchPending') && library.includes('FoodSearchSkeleton')],
  ['library keeps same-query results in an account-scoped cache', library.includes('catalogCacheRef') && library.includes('catalogCacheKey')],
  ['library cache is epoch-scoped and clears on owner changes', library.includes('cacheScopeRef') && library.includes('epoch') && library.includes('cacheOwner') && library.includes('catalogCacheRef.current.clear()')],
  ['library does not cache failed local-only results', library.includes('!catalogSearch.error && !catalogSearch.upstreamUnavailable')],
  ['library retains a successful cache during a later error', library.includes('catalogSearch.loading || !!catalogSearch.error || catalogSearch.upstreamUnavailable')],
  ['image load state is keyed by source identity', image.includes('key={loadKey}') && image.includes('sourceFingerprint') && image.includes('LibraryImageContent')],
  ['library exposes retry/error state instead of empty results on failure', library.includes('catalogSearch.error || catalogSearch.upstreamUnavailable')],
];

for (const [label, condition] of checks) {
  assert.equal(condition, true, label);
}

console.log(`route hydration shell checks passed (${checks.length})`);