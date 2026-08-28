/**
 * Patient corner-menu (FAB) invariants check.
 *
 * Renders the REAL shared FabMenu through both side-specific wrappers
 * (PatientFabMenu, ProviderFabMenu) and the real patient tab layout under
 * Node (react-test-renderer + the patient-fab-stubs), so a refactor can
 * never silently:
 *   1. move or resize the patient circle (it must clear the visible tab
 *      bar per platform — the provider side has no bar and sits lower),
 *   2. change the patient rows, their order, icons, or navigation targets
 *      (including the guided-session handoff that must be armed BEFORE
 *      /guided-photos is pushed, and the coach-chat camera deep link),
 *   3. drift the provider menu while sharing the implementation (testIDs,
 *      rows, active-row tick, dedupe-on-navigate, AI Support target),
 *   4. drop the accessibility contract (roles, labels, expanded state), or
 *   5. unmount the FAB from the patient layout / break its mode guards.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:patient-fab
 */
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { PatientFabMenu, patientFabBottom } from '../components/patient/PatientFabMenu';
import { ProviderFabMenu } from '../components/provider/ProviderFabMenu';
import PatientTabLayout from '../app/(patient)/_layout';
import {
  clearRouterCalls,
  clearRedirects,
  redirects,
  routerCalls,
  setPathname,
} from './patient-fab-stubs/expo-router';
import { clearHapticCalls, hapticCalls } from './patient-fab-stubs/expo-haptics';
import { setInsets } from './patient-fab-stubs/react-native-safe-area-context';
import { setAppMode } from './patient-fab-stubs/app-mode-context';
import { setLiquidGlassAvailable } from './patient-fab-stubs/expo-glass-effect';
import { claimGuidedPhotoRequest } from '../lib/guided-photos';

// Opt in to act() — react-test-renderer under plain Node, no jest environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let checks = 0;
let failures = 0;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

/** Host-only matching: stub components are functions, so composite nodes
 *  would otherwise double-match testIDs (see the guided-photos suite). */
const isHost = (node: ReactTestInstance) => typeof node.type === 'string';

function byIdAll(root: ReactTestInstance, id: string): ReactTestInstance[] {
  return root.findAll((n) => isHost(n) && n.props.testID === id);
}

function byId(root: ReactTestInstance, id: string): ReactTestInstance {
  const all = byIdAll(root, id);
  if (all.length !== 1) throw new Error(`expected exactly one #${id}, found ${all.length}`);
  return all[0];
}

function queryId(root: ReactTestInstance, id: string): ReactTestInstance | null {
  return byIdAll(root, id)[0] ?? null;
}

/** Flatten a react-native style (possibly nested arrays) into one object. */
function flat(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flat(s) }), {});
  }
  if (style && typeof style === 'object') return { ...(style as Record<string, unknown>) };
  return {};
}

/** Concatenated string content beneath a node. */
function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown) => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(walk);
      return;
    }
    const inst = child as { children?: unknown } | null;
    if (inst && typeof inst === 'object' && 'children' in inst) walk(inst.children);
  };
  walk(node.children);
  return parts.join('');
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    (node.props.onPress as (() => void) | undefined)?.();
    await Promise.resolve();
  });
}

async function render(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
    await Promise.resolve();
  });
  return renderer!;
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

const featherIn = (node: ReactTestInstance): string | undefined =>
  node.findAll((n) => n.type === 'Feather')[0]?.props.name as string | undefined;

const PATIENT_ROWS = [
  { id: 'patient-menu-log-food', label: 'Log food', icon: 'plus-circle' },
  { id: 'patient-menu-barcode', label: 'Scan a barcode', icon: 'barcode-scan' },
  { id: 'patient-menu-meal-photo', label: 'Snap a meal photo', icon: 'camera' },
  { id: 'patient-menu-check-in', label: 'Daily check-in', icon: 'check-circle' },
  { id: 'patient-menu-progress-photos', label: 'Progress photos', icon: 'image' },
];

const PROVIDER_ROWS = [
  { id: 'provider-menu-overview', label: 'Overview' },
  { id: 'provider-menu-patients', label: 'Patients' },
  { id: 'provider-menu-outcomes', label: 'Outcomes' },
  { id: 'provider-menu-leaderboard', label: 'Leaderboard' },
  { id: 'provider-menu-subscriptions', label: 'Subscriptions' },
  { id: 'provider-menu-training', label: 'Training' },
];

async function main() {
  // ── 1. Placement math: the circle clears the tab bar per platform ─────────
  {
    assert('web bottom = 84px pinned bar + 14 gap', patientFabBottom('web', 0) === 98);
    assert('web bottom ignores the inset (bar is pinned)', patientFabBottom('web', 34) === 98);
    assert('iOS bottom = 49 + home indicator + 14', patientFabBottom('ios', 34) === 97);
    assert('iOS without inset = 49 + 14', patientFabBottom('ios', 0) === 63);
    assert('android bottom includes its inset', patientFabBottom('android', 24) === 87);
  }

  setInsets({ top: 0, bottom: 0, left: 0, right: 0 });
  setPathname('/today');
  let patientCircleColor: unknown;
  let patientCircleShadow: unknown;

  // ── 2. Patient launcher at rest ────────────────────────────────────────────
  {
    clearRouterCalls();
    clearHapticCalls();
    const r = await render(React.createElement(PatientFabMenu));
    const fab = byId(r.root, 'patient-fab');
    const style = flat(fab.props.style);

    assert('launcher is a button', fab.props.accessibilityRole === 'button');
    assert(
      'launcher announces "Open quick actions menu"',
      fab.props.accessibilityLabel === 'Open quick actions menu',
    );
    assert('launcher reports collapsed', fab.props['aria-expanded'] === false);
    assert(
      'launcher accessibilityState collapsed',
      (fab.props.accessibilityState as { expanded?: boolean }).expanded === false,
    );
    assert('launcher shows the grid icon', featherIn(fab) === 'grid');
    assert('circle is 56px', style.width === 56 && style.height === 56);
    assert('circle is round', style.borderRadius === 28);
    assert('circle hugs the right edge at 18', style.right === 18);
    assert('circle floats above the web tab bar (bottom 98)', style.bottom === 98);
    assert('circle is absolutely positioned', style.position === 'absolute');
    assert('circle has the navy fill', typeof style.backgroundColor === 'string');
    assert('circle carries the Heritage shadow', typeof style.boxShadow === 'string');
    patientCircleColor = style.backgroundColor;
    patientCircleShadow = style.boxShadow;

    assert('menu is closed at rest', queryId(r.root, 'patient-menu') === null);
    assert('no stray navigation at rest', routerCalls.length === 0);
    await unmount(r);
  }

  // ── 3. Opening the patient menu ────────────────────────────────────────────
  {
    clearRouterCalls();
    clearHapticCalls();
    const r = await render(React.createElement(PatientFabMenu));
    await press(byId(r.root, 'patient-fab'));

    assert('toggle fires a selection haptic', hapticCalls.includes('selection'));
    const fab = byId(r.root, 'patient-fab');
    assert('launcher reports expanded', fab.props['aria-expanded'] === true);
    assert('launcher swaps to the X icon', featherIn(fab) === 'x');
    assert(
      'launcher announces "Close quick actions menu"',
      fab.props.accessibilityLabel === 'Close quick actions menu',
    );

    const menu = queryId(r.root, 'patient-menu');
    assert('menu card appears', menu !== null);
    if (!menu) throw new Error('menu did not open');
    const cardStyle = flat(menu.props.style);
    assert('card is 90% of the canvas', cardStyle.width === '90%');
    assert(
      'card is raised above the circle (98 + 56 + 12)',
      cardStyle.marginBottom === 98 + 56 + 12,
    );
    assert(
      'reveal animation completed',
      (cardStyle.opacity as { __value?: number } | undefined)?.__value === 1,
    );

    assert('backdrop is tappable', queryId(r.root, 'patient-menu-backdrop') !== null);
    const twin = queryId(r.root, 'patient-fab-close');
    assert('in-modal X twin exists', twin !== null);
    assert('twin announces close', twin?.props.accessibilityLabel === 'Close quick actions menu');
    assert('twin reports expanded', twin?.props['aria-expanded'] === true);
    assert(
      'twin sits on the launcher coordinates',
      flat(twin?.props.style).bottom === 98 && flat(twin?.props.style).right === 18,
    );

    assert('section label reads QUICK ACTIONS', textOf(menu).includes('QUICK ACTIONS'));

    const rows = menu.findAll(
      (n) =>
        isHost(n) &&
        typeof n.props.testID === 'string' &&
        (n.props.testID as string).startsWith('patient-menu-') &&
        n.props.testID !== 'patient-menu-coach',
    );
    assert(
      'exactly the five quick-action rows, in order',
      rows.map((n) => n.props.testID).join(',') === PATIENT_ROWS.map((row) => row.id).join(','),
    );
    for (const [index, expected] of PATIENT_ROWS.entries()) {
      const row = rows[index];
      if (!row) {
        fail(`row ${expected.id} missing`);
        continue;
      }
      assert(`${expected.id} shows "${expected.label}"`, textOf(row).includes(expected.label));
      assert(`${expected.id} is a button`, row.props.accessibilityRole === 'button');
      assert(
        `${expected.id} announces its label`,
        row.props.accessibilityLabel === expected.label,
      );
      assert(
        `${expected.id} is not marked active`,
        (row.props.accessibilityState as { selected?: boolean }).selected === false,
      );
      const iconName =
        expected.id === 'patient-menu-barcode'
          ? (row.findAll((n) => n.type === 'MaterialCommunityIcons')[0]?.props.name as string)
          : featherIn(row);
      assert(`${expected.id} carries the ${expected.icon} icon`, iconName === expected.icon);
    }
    assert(
      'the barcode row reuses the diary scan glyph family',
      rows[1]?.findAll((n) => n.type === 'MaterialCommunityIcons').length === 1,
    );

    const coach = byId(r.root, 'patient-menu-coach');
    assert('coach button reads Message Coach', textOf(coach).includes('Message Coach'));
    assert(
      'coach button announces "Message your coach"',
      coach.props.accessibilityLabel === 'Message your coach',
    );
    assert('coach button carries the chat icon', featherIn(coach) === 'message-circle');

    assert('opening navigates nowhere', routerCalls.length === 0);
    await unmount(r);
  }

  // ── 4. Patient row actions ─────────────────────────────────────────────────
  const rowAction = async (rowId: string) => {
    clearRouterCalls();
    clearHapticCalls();
    const r = await render(React.createElement(PatientFabMenu));
    await press(byId(r.root, 'patient-fab'));
    await press(byId(r.root, rowId));
    const closed = queryId(r.root, 'patient-menu') === null;
    await unmount(r);
    return { calls: [...routerCalls], closed, haptics: hapticCalls.length };
  };

  {
    const logFood = await rowAction('patient-menu-log-food');
    assert('Log food pushes /log-food', JSON.stringify(logFood.calls) === JSON.stringify([{ method: 'push', target: '/log-food' }]));
    assert('Log food closes the menu', logFood.closed);
    assert('Log food fires haptics (toggle + select)', logFood.haptics >= 2);

    const barcode = await rowAction('patient-menu-barcode');
    assert('Scan a barcode pushes /barcode-scan', JSON.stringify(barcode.calls) === JSON.stringify([{ method: 'push', target: '/barcode-scan' }]));
    assert('Scan a barcode closes the menu', barcode.closed);

    const mealPhoto = await rowAction('patient-menu-meal-photo');
    assert(
      'Snap a meal photo deep-links the chat camera',
      JSON.stringify(mealPhoto.calls) ===
        JSON.stringify([
          { method: 'push', target: { pathname: '/coach-chat', params: { camera: '1' } } },
        ]),
    );
    assert('Snap a meal photo closes the menu', mealPhoto.closed);

    const checkIn = await rowAction('patient-menu-check-in');
    assert('Daily check-in pushes /check-in', JSON.stringify(checkIn.calls) === JSON.stringify([{ method: 'push', target: '/check-in' }]));

    assert('no guided handoff armed beforehand', claimGuidedPhotoRequest() === null);
    const progress = await rowAction('patient-menu-progress-photos');
    assert('Progress photos pushes /guided-photos', JSON.stringify(progress.calls) === JSON.stringify([{ method: 'push', target: '/guided-photos' }]));
    const handoff = claimGuidedPhotoRequest();
    assert('Progress photos arms the session handoff BEFORE pushing', handoff !== null);
    assert('the handoff drains after one claim', claimGuidedPhotoRequest() === null);

    clearRouterCalls();
    const r = await render(React.createElement(PatientFabMenu));
    await press(byId(r.root, 'patient-fab'));
    await press(byId(r.root, 'patient-menu-coach'));
    assert('Message Coach pushes /coach-chat (no camera param)', JSON.stringify(routerCalls) === JSON.stringify([{ method: 'push', target: '/coach-chat' }]));
    assert('Message Coach closes the menu', queryId(r.root, 'patient-menu') === null);
    await unmount(r);
  }

  // ── 5. Close paths never navigate ──────────────────────────────────────────
  {
    clearRouterCalls();
    let r = await render(React.createElement(PatientFabMenu));
    await press(byId(r.root, 'patient-fab'));
    await press(byId(r.root, 'patient-menu-backdrop'));
    assert('backdrop closes the menu', queryId(r.root, 'patient-menu') === null);
    assert('backdrop close keeps the collapsed launcher label', byId(r.root, 'patient-fab').props.accessibilityLabel === 'Open quick actions menu');
    await unmount(r);

    r = await render(React.createElement(PatientFabMenu));
    await press(byId(r.root, 'patient-fab'));
    await press(byId(r.root, 'patient-fab-close'));
    assert('the X twin closes the menu', queryId(r.root, 'patient-menu') === null);
    await unmount(r);

    r = await render(React.createElement(PatientFabMenu));
    await press(byId(r.root, 'patient-fab'));
    const modal = r.root.findAll((n) => n.type === 'Modal')[0];
    await act(async () => {
      (modal.props.onRequestClose as () => void)();
    });
    assert('hardware back / Escape closes the menu', queryId(r.root, 'patient-menu') === null);

    // Reopen still works after every close path.
    await press(byId(r.root, 'patient-fab'));
    assert('menu reopens after closing', queryId(r.root, 'patient-menu') !== null);
    await unmount(r);
    assert('close paths never navigate', routerCalls.length === 0);
  }

  // ── 6. Provider menu through the shared component (parity guard) ──────────
  {
    clearRouterCalls();
    setPathname('/patients');
    const r = await render(React.createElement(ProviderFabMenu));
    const fab = byId(r.root, 'provider-fab');
    const style = flat(fab.props.style);
    assert('provider launcher keeps its testID', fab !== null);
    assert(
      'provider launcher keeps "Open navigation menu"',
      fab.props.accessibilityLabel === 'Open navigation menu',
    );
    assert('provider circle keeps 56px', style.width === 56 && style.height === 56);
    assert('provider circle keeps right 18', style.right === 18);
    assert('provider sits lower (no tab bar): bottom 28', style.bottom === 28);
    assert('both circles share the exact navy', style.backgroundColor === patientCircleColor);
    assert('both circles share the exact shadow', style.boxShadow === patientCircleShadow);

    await press(fab);
    const menu = queryId(r.root, 'provider-menu');
    assert('provider menu opens', menu !== null);
    if (!menu) throw new Error('provider menu did not open');
    assert('provider label reads NAVIGATE', textOf(menu).includes('NAVIGATE'));
    assert('provider card raised above its circle (28 + 56 + 12)', flat(menu.props.style).marginBottom === 96);
    assert('provider card matches the patient width', flat(menu.props.style).width === '90%');

    const rows = menu.findAll(
      (n) =>
        isHost(n) &&
        typeof n.props.testID === 'string' &&
        (n.props.testID as string).startsWith('provider-menu-') &&
        n.props.testID !== 'provider-menu-support',
    );
    assert(
      'provider keeps its six rows in order',
      rows.map((n) => n.props.testID).join(',') === PROVIDER_ROWS.map((row) => row.id).join(','),
    );
    for (const [index, expected] of PROVIDER_ROWS.entries()) {
      assert(
        `${expected.id} still reads "${expected.label}"`,
        rows[index] !== undefined && textOf(rows[index]).includes(expected.label),
      );
    }

    const active = rows.filter(
      (n) => (n.props.accessibilityState as { selected?: boolean }).selected === true,
    );
    assert('exactly one active provider row on /patients', active.length === 1 && active[0].props.testID === 'provider-menu-patients');
    const activeTick = active[0]
      ?.findAllByType('View' as never)
      .map((n) => flat(n.props.style))
      .find((s) => s.width === 14 && s.height === 3);
    assert('active row shows the orange tick', activeTick !== undefined && activeTick.backgroundColor !== 'transparent');
    const inactiveTick = rows[0]
      .findAllByType('View' as never)
      .map((n) => flat(n.props.style))
      .find((s) => s.width === 14 && s.height === 3);
    assert('inactive rows keep a transparent tick', inactiveTick !== undefined && inactiveTick.backgroundColor === 'transparent');

    // Selecting the already-active destination dedupes (no navigation).
    await press(byId(r.root, 'provider-menu-patients'));
    assert('active row press closes without navigating', routerCalls.length === 0 && queryId(r.root, 'provider-menu') === null);

    await press(byId(r.root, 'provider-fab'));
    await press(byId(r.root, 'provider-menu-outcomes'));
    assert(
      'other rows navigate (navigate method, not push)',
      JSON.stringify(routerCalls) === JSON.stringify([{ method: 'navigate', target: '/outcomes' }]),
    );

    clearRouterCalls();
    await press(byId(r.root, 'provider-fab'));
    const support = byId(r.root, 'provider-menu-support');
    assert('AI Support keeps its label', textOf(support).includes('AI Support'));
    assert('AI Support keeps its announcement', support.props.accessibilityLabel === 'Open AI Support');
    await press(support);
    assert('AI Support still pushes /support-chat', JSON.stringify(routerCalls) === JSON.stringify([{ method: 'push', target: '/support-chat' }]));
    await unmount(r);
    setPathname('/today');
  }

  // ── 7. The patient layout mounts the FAB behind its guards ────────────────
  {
    clearRedirects();
    clearRouterCalls();
    setLiquidGlassAvailable(false);
    setAppMode({ mode: 'patient', hydrated: true });
    let r = await render(React.createElement(PatientTabLayout));
    const screens = r.root.findAll((n) => n.type === 'TabsScreen');
    assert(
      'classic layout keeps the five tabs',
      screens.map((n) => n.props.name).join(',') === 'today,diary,recipes,progress,plan',
    );
    assert('FAB is mounted over the classic tabs', queryId(r.root, 'patient-fab') !== null);
    assert('no redirect in patient mode', redirects.length === 0);
    await unmount(r);

    setLiquidGlassAvailable(true);
    r = await render(React.createElement(PatientTabLayout));
    assert('liquid-glass layout renders native tabs', r.root.findAll((n) => n.type === 'NativeTabs').length === 1);
    assert('FAB is mounted over the native tabs too', queryId(r.root, 'patient-fab') !== null);
    await unmount(r);
    setLiquidGlassAvailable(false);

    setAppMode({ mode: 'staff', hydrated: true });
    r = await render(React.createElement(PatientTabLayout));
    assert('staff mode redirects to the provider home', JSON.stringify(redirects) === JSON.stringify(['/']));
    assert('staff mode never mounts the patient FAB', queryId(r.root, 'patient-fab') === null);
    await unmount(r);
    clearRedirects();

    setAppMode({ mode: 'unknown', hydrated: true });
    r = await render(React.createElement(PatientTabLayout));
    assert('unknown mode redirects to the persona chooser', JSON.stringify(redirects) === JSON.stringify(['/persona']));
    await unmount(r);
    clearRedirects();

    setAppMode({ mode: 'patient', hydrated: false });
    r = await render(React.createElement(PatientTabLayout));
    assert('unhydrated layout renders nothing', r.root.findAll((n) => isHost(n)).length === 0);
    assert('unhydrated layout does not redirect', redirects.length === 0);
    await unmount(r);
    setAppMode({ mode: 'patient', hydrated: true });
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  if (failures > 0) {
    console.error(`\n✗ Patient corner menu: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ Patient corner menu: ${checks} checks passed`);
}

main().catch((error) => {
  console.error('✗ Patient corner menu: suite crashed', error);
  process.exit(1);
});
