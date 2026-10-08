/**
 * Runtime React regression checks for the safe patient shell and Library image
 * contract. This runs under Node with native primitives mapped to host stubs:
 *
 *   pnpm exec tsx --tsconfig tsconfig.route-hydration.json scripts/verify-route-hydration-shells.tsx
 */
import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import PatientTabLayout from '../app/(patient)/_layout';
import { LibraryImage } from '../components/patient/LibraryImage';
import { PatientRouteShell } from '../components/patient/PatientRouteShell';
import { appModeState } from './route-hydration-stubs/app-mode-context';
import { patientState } from './route-hydration-stubs/patient-context';
import { accountState } from './route-hydration-stubs/patient-account-context';
import { routerState } from './patient-fab-stubs/expo-router';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let checks = 0;
function check(label: string, condition: boolean): void {
  checks += 1;
  if (!condition) throw new Error(label);
}

function hasTestID(renderer: ReactTestRenderer, testID: string): boolean {
  return renderer.root.findAllByProps({ testID }).length > 0;
}

async function shellChecks(): Promise<void> {
  const routeRows: Array<[string, string]> = [
    ['/today', 'patient-route-skeleton-today'],
    ['/diary', 'patient-route-skeleton-diary'],
    ['/progress', 'patient-route-skeleton-progress'],
    ['/recipes', 'patient-route-skeleton-library'],
  ];
  for (const [pathname, routeTestID] of routeRows) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<PatientRouteShell pathname={pathname} status="loading" />);
    });
    check(`${pathname} paints its route-shaped loading rows`, hasTestID(renderer, routeTestID));
    check(`${pathname} loading has no spinner card`, !hasTestID(renderer, 'patient-route-shell-spinner'));
    check(`${pathname} holding state hides patient tabs`, !hasTestID(renderer, 'patient-tab-bar'));
    await act(async () => { renderer.unmount(); });
  }

  let denied!: ReactTestRenderer;
  let retries = 0;
  await act(async () => {
    denied = create(
      <PatientRouteShell
        pathname="/today"
        status="error"
        detail="Couldn’t load your record. Retry."
        onRetry={() => { retries += 1; }}
      />,
    );
  });
  const retry = denied.root.findByProps({ testID: 'patient-route-shell-retry' });
  await act(async () => { retry.props.onPress(); });
  check('retryable shell exposes its action', retries === 1);
  check('retryable shell has no patient tabs', !hasTestID(denied, 'patient-tab-bar'));
  await act(async () => { denied.unmount(); });
}

async function imageChecks(): Promise<void> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <LibraryImage
        source={{ uri: 'https://example.test/a.jpg' }}
        sourceKey="recipe:a"
        label="Breakfast bowl"
      />,
    );
  });
  check('image starts with accessible loading placeholder', hasTestID(renderer, 'library-image-placeholder'));
  const oldImage = renderer.root.findByType('ExpoImage');
  const oldOnLoad = oldImage.props.onLoad as () => void;
  await act(async () => {
    renderer.update(
      <LibraryImage
        source={{ uri: 'https://example.test/b.jpg' }}
        sourceKey="recipe:b"
        label="Dinner bowl"
      />,
    );
  });
  check('source change immediately resets to placeholder', hasTestID(renderer, 'library-image-placeholder'));
  await act(async () => { oldOnLoad(); });
  check('old source load cannot resolve the new source', hasTestID(renderer, 'library-image-placeholder'));

  const nextImage = renderer.root.findByType('ExpoImage');
  await act(async () => { nextImage.props.onError(new Error('missing')); });
  check('image error keeps a persistent accessible placeholder', hasTestID(renderer, 'library-image-placeholder'));
  check(
    'error placeholder names the current recipe',
    renderer.root.findByProps({ testID: 'library-image-placeholder' }).props.accessibilityLabel ===
      'Image unavailable for Dinner bowl',
  );
  await act(async () => { renderer.unmount(); });
}

async function layoutChecks(): Promise<void> {
  // This is the real patient layout with only native/navigation, account and
  // patient context seams stubbed.  A resolved real account whose local store
  // is still loading must see a loading shell, never a consent/onboarding
  // denial flash before its record is known.
  appModeState.mode = 'patient';
  appModeState.hydrated = true;
  accountState.kind = 'real';
  accountState.resolving = false;
  patientState.hydrated = false;
  patientState.hydratedFlags = null;
  patientState.hydratedPrivacy = null;
  routerState.pathname = '/today';

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<PatientTabLayout />);
  });
  check('real account held on local storage paints loading shell', hasTestID(renderer, 'patient-route-skeleton-today'));
  check('real account storage hold does not paint consent denial', !JSON.stringify(renderer.toJSON()).includes('Consent is required'));
  check('real account storage hold mounts no quick actions', !hasTestID(renderer, 'patient-fab'));

  patientState.hydrated = true;
  patientState.hydratedFlags = { onboardingComplete: true };
  patientState.hydratedPrivacy = { consent: { satisfied: true }, deletion: null };
  await act(async () => {
    renderer.update(<PatientTabLayout />);
  });
  check('consented, onboarded real account is admitted after hydration', hasTestID(renderer, 'patient-tab-bar') && hasTestID(renderer, 'patient-fab'));
  check('admitted real account shows no consent denial', !JSON.stringify(renderer.toJSON()).includes('Consent is required'));

  patientState.hydratedPrivacy = { consent: { satisfied: false }, deletion: null };
  await act(async () => {
    renderer.update(<PatientTabLayout />);
  });
  check('real account without consent is denied with the consent reason', JSON.stringify(renderer.toJSON()).includes('Consent is required') && !hasTestID(renderer, 'patient-fab'));

  patientState.hydratedPrivacy = { consent: { satisfied: true }, deletion: null };
  patientState.hydratedFlags = { onboardingComplete: false };
  await act(async () => {
    renderer.update(<PatientTabLayout />);
  });
  check('real account mid-onboarding is denied with the onboarding reason', JSON.stringify(renderer.toJSON()).includes('Finish onboarding') && !hasTestID(renderer, 'patient-fab'));

  patientState.hydratedFlags = { onboardingComplete: true };
  accountState.kind = 'demo';
  await act(async () => {
    renderer.update(<PatientTabLayout />);
  });
  check('signed-out visitor is denied patient data', JSON.stringify(renderer.toJSON()).includes('Sign in before opening patient data') && !hasTestID(renderer, 'patient-fab'));
  patientState.hydrated = false;
  await act(async () => {
    renderer.update(<PatientTabLayout />);
  });
  check('signed-out visitor cannot turn an unknown store into loading admission', JSON.stringify(renderer.toJSON()).includes('Sign in before opening patient data'));

  accountState.kind = 'real';
  await act(async () => { renderer.unmount(); });
}

async function main(): Promise<void> {
  await layoutChecks();
  await shellChecks();
  await imageChecks();
  console.log(`route hydration runtime checks passed (${checks})`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});