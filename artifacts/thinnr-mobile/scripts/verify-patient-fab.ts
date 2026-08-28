/**
 * Patient corner quick-actions launcher check.
 *
 * Patients get the exact same bottom-right circle + popout menu as staff —
 * one shared FabMenu implementation behind both personas — filled with
 * patient quick actions and floating above the visible patient tab bar
 * (staff hide theirs, so their circle hugs the corner). This suite renders
 * the REAL patient tab layout, both persona wrappers, and the meal-photo
 * flow the patient menu hosts, under Node with react-test-renderer
 * (tsconfig.patient-fab.json maps native-only modules to Node stubs), and
 * proves:
 *
 *   1. Mount & placement — the patient tab layout carries the launcher as a
 *      sibling of the tab navigator (so it floats on every tab), a 56px
 *      navy circle at right 18 sitting above the tab bar shelf: web
 *      84 + 14, device insets + 84 + 14 — and only for the patient persona.
 *   2. Menu parity — identical card structure to staff: section label, five
 *      icon-chip rows in order, divider, cobalt primary button; identical
 *      open/close accessibility contract (button roles, expanded state,
 *      selected tick on the active destination, backdrop + twin X).
 *   3. Destinations — every row closes the menu with selection feedback and
 *      lands on an EXISTING screen: /log-food, /barcode-scan, the meal
 *      photo flow (library picker on web with the preview surviving the
 *      closed menu; /food-camera handoff on device), /check-in, the
 *      /progress tab (tab-navigate + skip-when-already-there), /coach-chat.
 *   4. Staff side unchanged — the provider wrapper still renders its six
 *      destinations + AI Support through the same shared contract.
 *   5. Stacking — the snackbar shelf clears the launcher, so a snackbar's
 *      corner action ("UNDO") never hides under the circle.
 *   6. One implementation — both wrappers are config-only (no modal /
 *      animation / stylesheet of their own), so the two menus cannot drift.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:patient-fab
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import React, { act } from 'react';
import { Platform } from 'react-native';

import PatientTabLayout from '../app/(patient)/_layout';
import { PatientFabMenu } from '../components/patient/PatientFabMenu';
import { ProviderFabMenu } from '../components/provider/ProviderFabMenu';
import { FAB_SIZE } from '../components/ui/FabMenu';
import colors from '../constants/colors';
import { patientFabBottom, patientSnackbarBottom, patientTabBarAllowance } from '../constants/layout';
import { claimFoodCameraRequest } from '../lib/food-camera';
import { appModeState } from './patient-fab-stubs/app-mode-context';
import { clearSendPhotoCalls, sendPhotoCalls } from './patient-fab-stubs/coach-chat-context';
import { selectionCalls } from './patient-fab-stubs/expo-haptics';
import { pickerCalls, pickerScript } from './patient-fab-stubs/expo-image-picker';
import { clearRouterCalls, routerCalls, routerState } from './patient-fab-stubs/expo-router';

const h = React.createElement;

let checks = 0;
let failures = 0;
let finished = false;

function fail(message: string) {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function assert(label: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(label);
}

function assertEqual(label: string, actual: string | number, expected: string | number) {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

function finish(): never {
  finished = true;
  if (failures > 0) {
    console.error(`\n✗ patient corner launcher check: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ patient corner launcher check: ${checks} checks passed`);
  process.exit(0);
}

// A dangling await must never look like success.
process.on('beforeExit', () => {
  if (!finished) {
    console.error('✗ patient corner launcher check: exited before finishing (dangling await?)');
    process.exit(1);
  }
});

// ─── react-test-renderer harness ─────────────────────────────────────────────

interface TestNode {
  type: unknown;
  props: Record<string, unknown>;
  children: (TestNode | string)[];
  findAll(predicate: (node: TestNode) => boolean): TestNode[];
}

interface Renderer {
  root: TestNode;
  unmount(): void;
}

let createRenderer: (el: React.ReactElement) => Renderer;

function render(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = createRenderer(element);
  });
  return renderer;
}

function isHost(node: TestNode): boolean {
  return typeof node.type === 'string';
}

function byTestID(root: TestNode, id: string): TestNode[] {
  return root.findAll(node => isHost(node) && node.props.testID === id);
}

/** Exactly-one lookup; missing/duplicated testIDs fail loudly. */
function only(root: TestNode, id: string): TestNode | null {
  const all = byTestID(root, id);
  assertEqual(`exactly one "${id}"`, all.length, 1);
  return all[0] ?? null;
}

function tap(node: TestNode | null): void {
  if (!node) return;
  act(() => {
    (node.props.onPress as (() => void) | undefined)?.();
  });
}

/** Drains microtasks + several macrotask rounds so async chains finish INSIDE act. */
async function drainAsync(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Tap whose handler kicks off async work (picker, photo prep, handoff). */
async function tapAndSettle(node: TestNode | null): Promise<void> {
  if (!node) return;
  await act(async () => {
    (node.props.onPress as (() => void) | undefined)?.();
    await drainAsync();
  });
}

function unmount(renderer: Renderer): void {
  act(() => {
    renderer.unmount();
  });
}

function flattenStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') Object.assign(out, value as Record<string, unknown>);
  };
  visit(style);
  return out;
}

function textOf(node: TestNode): string {
  const parts: string[] = [];
  const walk = (child: TestNode | string): void => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    child.children.forEach(walk);
  };
  node.children.forEach(walk);
  return parts.join('');
}

function nodeKids(node: TestNode): TestNode[] {
  return node.children.filter((child): child is TestNode => typeof child !== 'string');
}

// ─── Shared menu contract (the "pixel-matched to staff" guarantee) ───────────

interface RowSpec {
  key: string;
  label: string;
  iconHost: 'Feather' | 'MaterialCommunityIcons';
  iconName: string;
}

const PATIENT_ROWS: RowSpec[] = [
  { key: 'log-food', label: 'Log food', iconHost: 'Feather', iconName: 'plus' },
  { key: 'barcode', label: 'Scan a barcode', iconHost: 'MaterialCommunityIcons', iconName: 'barcode-scan' },
  { key: 'meal-photo', label: 'Snap a meal photo', iconHost: 'Feather', iconName: 'camera' },
  { key: 'check-in', label: 'Daily check-in', iconHost: 'Feather', iconName: 'check-circle' },
  { key: 'progress-photos', label: 'Progress photos', iconHost: 'Feather', iconName: 'image' },
];

const PROVIDER_ROWS: RowSpec[] = [
  { key: 'overview', label: 'Overview', iconHost: 'Feather', iconName: 'home' },
  { key: 'patients', label: 'Patients', iconHost: 'Feather', iconName: 'users' },
  { key: 'outcomes', label: 'Outcomes', iconHost: 'Feather', iconName: 'bar-chart-2' },
  { key: 'leaderboard', label: 'Leaderboard', iconHost: 'Feather', iconName: 'award' },
  { key: 'subscriptions', label: 'Subscriptions', iconHost: 'Feather', iconName: 'package' },
  { key: 'training', label: 'Training', iconHost: 'Feather', iconName: 'book-open' },
];

interface MenuContract {
  side: string;
  root: TestNode;
  idPrefix: string;
  sectionLabel: string;
  openLabel: string;
  closeLabel: string;
  rows: RowSpec[];
  primary: { key: string; label: string; a11yLabel: string; iconName: string };
  fabBottom: number;
  activeKey?: string;
}

/** Opens the menu, checks every shared visual/a11y invariant, closes it. */
function checkMenuContract(opts: MenuContract): void {
  const { side, root, idPrefix } = opts;

  const fab = only(root, `${idPrefix}-fab`);
  if (!fab) return;
  const fabStyle = flattenStyle(fab.props.style);
  assertEqual(`${side}: circle width`, Number(fabStyle.width), FAB_SIZE);
  assertEqual(`${side}: circle height`, Number(fabStyle.height), FAB_SIZE);
  assertEqual(`${side}: circle radius`, Number(fabStyle.borderRadius), FAB_SIZE / 2);
  assertEqual(`${side}: corner offset`, Number(fabStyle.right), 18);
  assertEqual(`${side}: bottom offset`, Number(fabStyle.bottom), opts.fabBottom);
  assertEqual(`${side}: navy circle`, String(fabStyle.backgroundColor), colors.light.navy);
  assert(
    `${side}: circle casts the shared shadow`,
    'boxShadow' in fabStyle || 'shadowColor' in fabStyle || 'elevation' in fabStyle,
  );
  assertEqual(`${side}: launcher role`, String(fab.props.accessibilityRole), 'button');
  assertEqual(`${side}: launcher label (closed)`, String(fab.props.accessibilityLabel), opts.openLabel);
  assertEqual(
    `${side}: launcher reports collapsed`,
    String((fab.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded),
    'false',
  );
  const restingIcon = fab.findAll(n => isHost(n) && n.type === 'Feather')[0];
  assertEqual(`${side}: resting grid glyph`, String(restingIcon?.props.name), 'grid');
  assertEqual(`${side}: menu starts closed`, byTestID(root, `${idPrefix}-menu`).length, 0);

  const hapticsBefore = selectionCalls.count;
  tap(fab);
  assertEqual(`${side}: opening ticks selection feedback`, selectionCalls.count, hapticsBefore + 1);

  const menu = only(root, `${idPrefix}-menu`);
  if (!menu) return;
  const cardStyle = flattenStyle(menu.props.style);
  const cardDrop = cardStyle.marginBottom ?? cardStyle.bottom;
  assertEqual(`${side}: card floats above the circle`, Number(cardDrop), opts.fabBottom + FAB_SIZE + 12);
  assertEqual(`${side}: cream card`, String(cardStyle.backgroundColor), colors.light.card);

  const kids = nodeKids(menu);
  assertEqual(`${side}: card structure (label + rows + divider + primary)`, kids.length, opts.rows.length + 3);
  assertEqual(`${side}: section label`, textOf(kids[0]!), opts.sectionLabel);

  opts.rows.forEach((row, index) => {
    const rowNode = only(root, `${idPrefix}-menu-${row.key}`);
    if (!rowNode) return;
    assertEqual(`${side}: row ${index + 1} is ${row.key}`, String(kids[index + 1]?.props.testID), `${idPrefix}-menu-${row.key}`);
    assertEqual(`${side}: row ${row.key} role`, String(rowNode.props.accessibilityRole), 'button');
    assertEqual(`${side}: row ${row.key} a11y label`, String(rowNode.props.accessibilityLabel), row.label);
    assert(`${side}: row ${row.key} shows its label`, textOf(rowNode).includes(row.label));
    const icon = rowNode.findAll(n => isHost(n) && n.type === row.iconHost)[0];
    assertEqual(`${side}: row ${row.key} glyph`, String(icon?.props.name), row.iconName);
    const selected = (rowNode.props.accessibilityState as { selected?: boolean } | undefined)?.selected;
    assertEqual(`${side}: row ${row.key} selected state`, String(Boolean(selected)), String(row.key === opts.activeKey));
    const ticks = rowNode.findAll(
      n => isHost(n) && flattenStyle(n.props.style).backgroundColor === colors.light.orange,
    );
    assertEqual(`${side}: row ${row.key} active tick`, ticks.length, row.key === opts.activeKey ? 1 : 0);
  });

  const divider = kids[opts.rows.length + 1];
  assertEqual(`${side}: divider under the rows`, Number(divider ? flattenStyle(divider.props.style).height : NaN), 1);

  const primary = only(root, `${idPrefix}-menu-${opts.primary.key}`);
  if (primary) {
    assertEqual(
      `${side}: primary sits last`,
      String(kids[kids.length - 1]?.props.testID),
      `${idPrefix}-menu-${opts.primary.key}`,
    );
    assertEqual(`${side}: primary a11y label`, String(primary.props.accessibilityLabel), opts.primary.a11yLabel);
    assert(`${side}: primary shows its label`, textOf(primary).includes(opts.primary.label));
    assertEqual(
      `${side}: cobalt primary`,
      String(flattenStyle(primary.props.style).backgroundColor),
      colors.light.cobalt,
    );
    const icon = primary.findAll(n => isHost(n) && n.type === 'Feather')[0];
    assertEqual(`${side}: primary glyph`, String(icon?.props.name), opts.primary.iconName);
  }

  const backdrop = only(root, `${idPrefix}-menu-backdrop`);
  if (backdrop) {
    assertEqual(`${side}: backdrop role`, String(backdrop.props.accessibilityRole), 'button');
    assertEqual(`${side}: backdrop label`, String(backdrop.props.accessibilityLabel), 'Close menu');
  }

  const twin = only(root, `${idPrefix}-fab-close`);
  if (twin) {
    assertEqual(`${side}: twin X label`, String(twin.props.accessibilityLabel), opts.closeLabel);
    assertEqual(
      `${side}: twin X reports expanded`,
      String((twin.props.accessibilityState as { expanded?: boolean } | undefined)?.expanded),
      'true',
    );
    assertEqual(`${side}: twin X keeps the corner`, Number(flattenStyle(twin.props.style).bottom), opts.fabBottom);
    const twinIcon = twin.findAll(n => isHost(n) && n.type === 'Feather')[0];
    assertEqual(`${side}: twin X glyph`, String(twinIcon?.props.name), 'x');
  }

  tap(backdrop);
  assertEqual(`${side}: backdrop closes the menu`, byTestID(root, `${idPrefix}-menu`).length, 0);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

const INSET_BOTTOM = 34; // what the safe-area stub reports

async function main(): Promise<void> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // react-test-renderer 19 prints a one-line deprecation notice; keep the
  // output readable but let every other console.error through untouched.
  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    realConsoleError(...args);
  };
  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create?: (el: React.ReactElement) => Renderer };
    create?: (el: React.ReactElement) => Renderer;
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');
  createRenderer = TestRenderer.create.bind(TestRenderer);

  // ── 1. Patient layout mounts the launcher above the web tab bar ──────────
  Platform.OS = 'web';
  routerState.pathname = '/today';
  const WEB_FAB_BOTTOM = patientFabBottom(INSET_BOTTOM);
  assertEqual('web shelf math (fixed 84px tab bar + gap)', WEB_FAB_BOTTOM, 84 + 14);

  const layout = render(h(PatientTabLayout));
  const root = layout.root;
  const screens = root.findAll(n => isHost(n) && n.type === 'TabsScreen');
  assertEqual(
    'launcher is a sibling of all five patient tabs',
    screens.map(s => String(s.props.name)).join(','),
    'today,diary,recipes,progress,plan',
  );

  checkMenuContract({
    side: 'patient(web)',
    root,
    idPrefix: 'patient',
    sectionLabel: 'QUICK ACTIONS',
    openLabel: 'Open quick actions menu',
    closeLabel: 'Close quick actions menu',
    rows: PATIENT_ROWS,
    primary: { key: 'coach', label: 'Message Coach', a11yLabel: 'Message your coach', iconName: 'message-circle' },
    fabBottom: WEB_FAB_BOTTOM,
  });

  // ── 2. Rows close the menu, tick feedback, land on existing screens ──────
  const openMenu = () => tap(only(root, 'patient-fab'));

  const rowNavigates = async (key: string, expected: { method: string; target: string }) => {
    openMenu();
    clearRouterCalls();
    const before = selectionCalls.count;
    await tapAndSettle(only(root, `patient-menu-${key}`));
    assertEqual(`row ${key}: menu closes`, byTestID(root, 'patient-menu').length, 0);
    assertEqual(`row ${key}: one selection tick`, selectionCalls.count, before + 1);
    assertEqual(`row ${key}: destination`, JSON.stringify(routerCalls), JSON.stringify([expected]));
  };

  await rowNavigates('log-food', { method: 'push', target: '/log-food' });
  await rowNavigates('barcode', { method: 'push', target: '/barcode-scan' });
  await rowNavigates('check-in', { method: 'push', target: '/check-in' });
  await rowNavigates('coach', { method: 'push', target: '/coach-chat' });
  // Progress photos targets the progress TAB → tab-navigate, not push.
  await rowNavigates('progress-photos', { method: 'navigate', target: '/progress' });

  // Already on Progress: the row shows the active tick and skips re-navigating.
  routerState.pathname = '/progress';
  openMenu();
  const activeRow = only(root, 'patient-menu-progress-photos');
  assertEqual(
    'on /progress: row reports selected',
    String((activeRow?.props.accessibilityState as { selected?: boolean } | undefined)?.selected),
    'true',
  );
  assertEqual(
    'on /progress: row shows the orange tick',
    activeRow
      ? activeRow.findAll(n => isHost(n) && flattenStyle(n.props.style).backgroundColor === colors.light.orange).length
      : NaN,
    1,
  );
  clearRouterCalls();
  await tapAndSettle(activeRow);
  assertEqual('on /progress: menu closes without re-navigating', byTestID(root, 'patient-menu').length, 0);
  assertEqual('on /progress: no duplicate navigation', routerCalls.length, 0);
  routerState.pathname = '/today';

  // ── 3. Snap a meal photo (web): picker → preview survives the closed menu ─
  pickerScript.next = {
    canceled: false,
    assets: [{ uri: 'blob:meal-fixture', width: 1200, height: 900 }],
  };
  clearSendPhotoCalls();
  openMenu();
  clearRouterCalls();
  await tapAndSettle(only(root, 'patient-menu-meal-photo'));
  assertEqual('meal photo: menu closes', byTestID(root, 'patient-menu').length, 0);
  assertEqual('meal photo: library picker launched once', pickerCalls.count, 1);
  assert('meal photo: preview outlives the closed menu', only(root, 'meal-photo-preview') !== null);
  assertEqual('meal photo: nothing sent before confirm', sendPhotoCalls.length, 0);
  await tapAndSettle(only(root, 'meal-photo-use'));
  assertEqual('meal photo: one photo handed to the coach', sendPhotoCalls.length, 1);
  assertEqual('meal photo: sent as a meal read', String(sendPhotoCalls[0]?.kind), 'meal');
  assertEqual('meal photo: the picked shot rides through', String(sendPhotoCalls[0]?.photo.uri), 'blob:meal-fixture');
  assert('meal photo: no meal-slot pin from the menu', sendPhotoCalls[0]?.options === undefined);
  assertEqual(
    'meal photo: lands in coach chat',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'push', target: '/coach-chat' }]),
  );
  assertEqual('meal photo: preview closes after send', byTestID(root, 'meal-photo-preview').length, 0);
  unmount(layout);

  // ── 4. Persona gate: the launcher never leaks outside the patient side ───
  appModeState.mode = 'staff';
  const staffTree = render(h(PatientTabLayout));
  assertEqual(
    'staff persona: patient layout redirects away',
    staffTree.root
      .findAll(n => isHost(n) && n.type === 'Redirect')
      .map(n => String(n.props.href))
      .join(','),
    '/',
  );
  assertEqual('staff persona: no patient launcher', byTestID(staffTree.root, 'patient-fab').length, 0);
  unmount(staffTree);
  appModeState.mode = 'patient';

  // ── 5. Device placement + in-app camera handoff ──────────────────────────
  Platform.OS = 'ios';
  const NATIVE_FAB_BOTTOM = patientFabBottom(INSET_BOTTOM);
  assertEqual(
    'device shelf math (inset + tab bar + gap)',
    NATIVE_FAB_BOTTOM,
    INSET_BOTTOM + patientTabBarAllowance(0) + 14,
  );
  const nativeTree = render(h(PatientFabMenu));
  const nativeFab = only(nativeTree.root, 'patient-fab');
  assertEqual(
    'device: circle floats above tab bar + home indicator',
    Number(flattenStyle(nativeFab?.props.style).bottom),
    NATIVE_FAB_BOTTOM,
  );
  const providerBottom = Math.max(INSET_BOTTOM, 14) + 14;
  assert('patients float higher than staff (visible tab bar)', NATIVE_FAB_BOTTOM > providerBottom);

  tap(nativeFab);
  clearRouterCalls();
  await tapAndSettle(only(nativeTree.root, 'patient-menu-meal-photo'));
  assertEqual(
    'device meal photo: opens the in-app food camera',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'push', target: '/food-camera' }]),
  );
  const session = claimFoodCameraRequest();
  assert('device meal photo: capture request pending for the camera screen', session !== null);
  await act(async () => {
    session?.settle(null);
    await drainAsync();
  });
  assertEqual(
    'device meal photo: backing out of the camera shows no preview',
    byTestID(nativeTree.root, 'meal-photo-preview').length,
    0,
  );
  unmount(nativeTree);
  Platform.OS = 'web';

  // ── 6. Staff side unchanged: same shared contract, staff config ──────────
  routerState.pathname = '/patients';
  const providerTree = render(h(ProviderFabMenu));
  checkMenuContract({
    side: 'provider',
    root: providerTree.root,
    idPrefix: 'provider',
    sectionLabel: 'NAVIGATE',
    openLabel: 'Open navigation menu',
    closeLabel: 'Close navigation menu',
    rows: PROVIDER_ROWS,
    primary: { key: 'support', label: 'AI Support', a11yLabel: 'Open AI Support', iconName: 'message-circle' },
    fabBottom: providerBottom,
    activeKey: 'patients',
  });
  tap(only(providerTree.root, 'provider-fab'));
  clearRouterCalls();
  await tapAndSettle(only(providerTree.root, 'provider-menu-overview'));
  assertEqual(
    'staff row semantics intact (tab-navigate to Overview)',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'navigate', target: '/' }]),
  );
  tap(only(providerTree.root, 'provider-fab'));
  clearRouterCalls();
  await tapAndSettle(only(providerTree.root, 'provider-menu-support'));
  assertEqual(
    'staff primary semantics intact (push AI Support)',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'push', target: '/support-chat' }]),
  );
  unmount(providerTree);
  routerState.pathname = '/today';

  // ── 7. Snackbars stack above the launcher (UNDO stays tappable) ──────────
  assertEqual(
    'web: snackbar shelf rides the circle top + 12',
    patientSnackbarBottom(INSET_BOTTOM),
    WEB_FAB_BOTTOM + FAB_SIZE + 12,
  );
  Platform.OS = 'ios';
  assertEqual(
    'device: snackbar shelf rides the circle top + 12',
    patientSnackbarBottom(INSET_BOTTOM),
    NATIVE_FAB_BOTTOM + FAB_SIZE + 12,
  );
  Platform.OS = 'web';

  // ── 8. One implementation, two configs (static drift guard) ──────────────
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const providerSrc = read('components/provider/ProviderFabMenu.tsx');
  const patientSrc = read('components/patient/PatientFabMenu.tsx');
  const ownsVisuals = (src: string) =>
    src.includes('<AppModal') || src.includes('Animated.') || src.includes('StyleSheet.create');
  assert('staff wrapper renders the shared FabMenu', providerSrc.includes('<FabMenu'));
  assert('patient wrapper renders the shared FabMenu', patientSrc.includes('<FabMenu'));
  assert('staff wrapper is config-only (no visuals to drift)', !ownsVisuals(providerSrc));
  assert('patient wrapper is config-only (no visuals to drift)', !ownsVisuals(patientSrc));
  assert('patient tab layout mounts the launcher', read('app/(patient)/_layout.tsx').includes('<PatientFabMenu'));
  assert('staff tab layout keeps its launcher', read('app/(tabs)/_layout.tsx').includes('<ProviderFabMenu'));
  assert(
    'snackbar rides the shared shelf constant',
    read('components/ui/Snackbar.tsx').includes('patientSnackbarBottom('),
  );

  finish();
}

main().catch((error: unknown) => {
  fail(`unhandled: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  finish();
});
