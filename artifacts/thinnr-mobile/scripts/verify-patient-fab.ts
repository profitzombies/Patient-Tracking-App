/**
 * Patient bottom navigation check — floating pill bar + corner launcher.
 *
 * Patients navigate from a floating row in the bottom gutter: a Heritage
 * pill holding the four daily screens (Today, Diary, Progress, Coach) with
 * the shared corner launcher immediately to its right, carrying the two
 * overflow destinations (Library, Plan) above its quick actions. Staff keep
 * the same launcher with their own config and no bar at all. This suite
 * renders the REAL patient tab layout, both persona wrappers, and the
 * meal-photo flow the patient menu hosts, under Node with
 * react-test-renderer (tsconfig.patient-fab.json maps native-only modules
 * to Node stubs), and proves:
 *
 *   1. Mount & shelf — the layout carries the pill bar AND the launcher as
 *      siblings of the tab navigator (so they float on every screen), the
 *      navigator itself draws no bar, and the two floating surfaces share
 *      one row that they can never overlap in.
 *   2. Pill bar — four seats in order, each with a real accessible name and
 *      selected state (a hand-rolled bar owes its own a11y), the active
 *      seat lit as a pale cobalt capsule (never an underline, which stole
 *      height from every seat and pushed the icons off centre), SF Symbols
 *      on iOS / Feather elsewhere, tab-navigate + skip-when-already-there
 *      for the three screens, and a push for the coach chat that stacks
 *      over them.
 *   3. Menu parity — identical card structure to staff: labelled section
 *      groups, icon-chip rows in order, divider, cobalt primary button;
 *      identical open/close accessibility contract (button roles, expanded
 *      state, selected tick on the active destination, backdrop + twin X).
 *      Patient rests as a plus, staff as the grid.
 *   4. Destinations — every row closes the menu with selection feedback and
 *      lands on an EXISTING screen: /recipes, /plan, /barcode-scan, the
 *      meal photo flow (library picker on web with the preview surviving
 *      the closed menu; /food-camera handoff on device), /check-in, the
 *      /progress screen, /log-food.
 *   5. Staff side unchanged — the provider wrapper still renders its six
 *      destinations + AI Support through the same shared contract.
 *   6. Stacking — snackbars and scroll padding both clear the whole
 *      floating row, so a snackbar's corner action ("UNDO") never hides
 *      under the circle and no list ends under the bar.
 *   7. One implementation — both wrappers are config-only (no modal /
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
import { FAB_RIGHT, FAB_SIZE } from '../components/ui/FabMenu';
import colors from '../constants/colors';
import {
  PATIENT_BAR_HEIGHT,
  PATIENT_BAR_SIDE,
  patientBarBottom,
  patientBarRightInset,
  patientContentBottom,
  patientFabBottom,
  patientSnackbarBottom,
} from '../constants/layout';
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
    console.error(`\n✗ patient bottom navigation check: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ patient bottom navigation check: ${checks} checks passed`);
  process.exit(0);
}

// A dangling await must never look like success.
process.on('beforeExit', () => {
  if (!finished) {
    console.error('✗ patient bottom navigation check: exited before finishing (dangling await?)');
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

function orangeTicks(node: TestNode): number {
  return node.findAll(n => isHost(n) && flattenStyle(n.props.style).backgroundColor === colors.light.orange)
    .length;
}

/**
 * Seats in the pill bar mark themselves by lighting the whole seat (a pale
 * cobalt capsule), not by an underline: the underline had to come out of
 * the seat's own height, which shifted every icon in the bar upward to
 * make room for a marker only one seat ever showed.
 */
function litSeats(node: TestNode): number {
  return node.findAll(n => isHost(n) && flattenStyle(n.props.style).backgroundColor === colors.light.accent)
    .length;
}

// ─── Shared menu contract (the "pixel-matched to staff" guarantee) ───────────

interface RowSpec {
  key: string;
  label: string;
  iconHost: 'Feather' | 'MaterialCommunityIcons';
  iconName: string;
}

interface SectionSpec {
  key: string;
  label: string;
  rows: RowSpec[];
}

const PATIENT_SECTIONS: SectionSpec[] = [
  {
    key: 'destinations',
    label: 'MENU',
    rows: [
      { key: 'library', label: 'Library', iconHost: 'Feather', iconName: 'grid' },
      { key: 'plan', label: 'Plan', iconHost: 'Feather', iconName: 'clipboard' },
      { key: 'account', label: 'Account & settings', iconHost: 'Feather', iconName: 'user' },
    ],
  },
  {
    key: 'quick-actions',
    label: 'QUICK ACTIONS',
    rows: [
      { key: 'barcode', label: 'Scan a barcode', iconHost: 'MaterialCommunityIcons', iconName: 'barcode-scan' },
      { key: 'meal-photo', label: 'Snap a meal photo', iconHost: 'Feather', iconName: 'camera' },
      { key: 'care-team-chat', label: 'Message My Care Team', iconHost: 'Feather', iconName: 'message-square' },
      { key: 'check-in', label: 'Daily check-in', iconHost: 'Feather', iconName: 'check-circle' },
      { key: 'progress-photos', label: 'Progress photos', iconHost: 'Feather', iconName: 'image' },
    ],
  },
];

const PROVIDER_SECTIONS: SectionSpec[] = [
  {
    key: 'navigate',
    label: 'NAVIGATE',
    rows: [
      { key: 'overview', label: 'Overview', iconHost: 'Feather', iconName: 'home' },
      { key: 'patients', label: 'Patients', iconHost: 'Feather', iconName: 'users' },
      { key: 'outcomes', label: 'Outcomes', iconHost: 'Feather', iconName: 'bar-chart-2' },
      { key: 'leaderboard', label: 'Leaderboard', iconHost: 'Feather', iconName: 'award' },
      { key: 'subscriptions', label: 'Subscriptions', iconHost: 'Feather', iconName: 'package' },
      { key: 'training', label: 'Training', iconHost: 'Feather', iconName: 'book-open' },
    ],
  },
];

interface MenuContract {
  side: string;
  root: TestNode;
  idPrefix: string;
  sections: SectionSpec[];
  openLabel: string;
  closeLabel: string;
  restingIcon: string;
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
  assertEqual(`${side}: corner offset`, Number(fabStyle.right), FAB_RIGHT);
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
  assertEqual(`${side}: resting glyph`, String(restingIcon?.props.name), opts.restingIcon);
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
  assertEqual(
    `${side}: card structure (section groups + divider + primary)`,
    kids.length,
    opts.sections.length + 2,
  );

  opts.sections.forEach((section, sectionIndex) => {
    const group = only(root, `${idPrefix}-menu-section-${section.key}`);
    if (!group) return;
    assertEqual(
      `${side}: group ${sectionIndex + 1} is ${section.key}`,
      String(kids[sectionIndex]?.props.testID),
      `${idPrefix}-menu-section-${section.key}`,
    );
    const groupKids = nodeKids(group);
    assertEqual(`${side}: ${section.key} heading`, textOf(groupKids[0]!), section.label);
    assertEqual(`${side}: ${section.key} row count`, groupKids.length - 1, section.rows.length);

    section.rows.forEach((row, index) => {
      const rowNode = only(root, `${idPrefix}-menu-${row.key}`);
      if (!rowNode) return;
      assertEqual(
        `${side}: ${section.key} row ${index + 1} is ${row.key}`,
        String(groupKids[index + 1]?.props.testID),
        `${idPrefix}-menu-${row.key}`,
      );
      assertEqual(`${side}: row ${row.key} role`, String(rowNode.props.accessibilityRole), 'button');
      assertEqual(`${side}: row ${row.key} a11y label`, String(rowNode.props.accessibilityLabel), row.label);
      assert(`${side}: row ${row.key} shows its label`, textOf(rowNode).includes(row.label));
      const icon = rowNode.findAll(n => isHost(n) && n.type === row.iconHost)[0];
      assertEqual(`${side}: row ${row.key} glyph`, String(icon?.props.name), row.iconName);
      const selected = (rowNode.props.accessibilityState as { selected?: boolean } | undefined)?.selected;
      assertEqual(`${side}: row ${row.key} selected state`, String(Boolean(selected)), String(row.key === opts.activeKey));
      assertEqual(`${side}: row ${row.key} active tick`, orangeTicks(rowNode), row.key === opts.activeKey ? 1 : 0);
    });
  });

  const divider = kids[opts.sections.length];
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

// ─── Pill bar contract ───────────────────────────────────────────────────────

interface SeatSpec {
  key: string;
  label: string;
  sf: string;
  feather: string;
  /** What pressing it does when it is NOT the current screen. */
  method: 'navigate' | 'push';
  target: string;
}

const SEATS: SeatSpec[] = [
  { key: 'today', label: 'Today', sf: 'sun.max', feather: 'sun', method: 'navigate', target: '/today' },
  { key: 'diary', label: 'Diary', sf: 'book', feather: 'book-open', method: 'navigate', target: '/diary' },
  {
    key: 'progress',
    label: 'Progress',
    sf: 'chart.xyaxis.line',
    feather: 'trending-down',
    method: 'navigate',
    target: '/progress',
  },
  { key: 'coach', label: 'Coach', sf: 'message', feather: 'message-circle', method: 'push', target: '/coach-chat' },
];

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

  // ── 1. Layout mounts the whole floating row over a bar-less navigator ────
  Platform.OS = 'web';
  routerState.pathname = '/today';
  const WEB_BAR_BOTTOM = patientBarBottom(INSET_BOTTOM);
  const WEB_FAB_BOTTOM = patientFabBottom(INSET_BOTTOM);
  assertEqual('web bar shelf (flat gutter on the fixed canvas)', WEB_BAR_BOTTOM, 18);
  assertEqual('web circle centers on the bar', WEB_FAB_BOTTOM, WEB_BAR_BOTTOM + (PATIENT_BAR_HEIGHT - FAB_SIZE) / 2);

  const layout = render(h(PatientTabLayout));
  const root = layout.root;
  const screens = root.findAll(n => isHost(n) && n.type === 'TabsScreen');
  assertEqual(
    'all five patient screens still registered',
    screens.map(s => String(s.props.name)).join(','),
    'today,diary,recipes,progress,plan',
  );
  const navigator = root.findAll(n => isHost(n) && n.type === 'Tabs')[0];
  assert('navigator mounted', navigator !== undefined);
  const tabBarProp = navigator?.props.tabBar as (() => unknown) | undefined;
  assertEqual('navigator is handed a tabBar renderer', typeof tabBarProp, 'function');
  assertEqual('navigator draws no bar of its own', String(tabBarProp?.()), 'null');
  assert('layout mounts the pill bar', byTestID(root, 'patient-tab-bar').length === 1);
  assert('layout mounts the launcher', byTestID(root, 'patient-fab').length === 1);

  // The two floating surfaces share a row and must never overlap: the bar
  // stops a clear gap short of where the circle starts.
  assertEqual('bar right inset clears the circle', patientBarRightInset(), FAB_RIGHT + FAB_SIZE + 12);
  assert('bar cannot run under the circle', patientBarRightInset() > FAB_RIGHT + FAB_SIZE);
  assert('bar is taller than the circle it flanks', PATIENT_BAR_HEIGHT > FAB_SIZE);

  const bar = only(root, 'patient-tab-bar');
  const barStyle = flattenStyle(bar?.props.style);
  assertEqual('web: bar bottom', Number(barStyle.bottom), WEB_BAR_BOTTOM);
  assertEqual('web: bar left gutter', Number(barStyle.left), PATIENT_BAR_SIDE);
  assertEqual('web: bar right inset', Number(barStyle.right), patientBarRightInset());
  assertEqual('web: bar height', Number(barStyle.height), PATIENT_BAR_HEIGHT);
  assertEqual('web: capsule radius', Number(barStyle.borderRadius), PATIENT_BAR_HEIGHT / 2);
  assertEqual('web: cream bar', String(barStyle.backgroundColor), colors.light.card);
  assertEqual('web: bar hairline', String(barStyle.borderColor), colors.light.border);
  assert('web: bar floats over content', String(barStyle.position) === 'absolute');
  assert('web: bar casts a shadow', 'boxShadow' in barStyle);

  // ── 2. Four seats: order, accessible names, active marking, glyphs ───────
  const barKids = nodeKids(bar!);
  assertEqual(
    'seats in order',
    barKids.map(kid => String(kid.props.testID)).join(','),
    SEATS.map(seat => `patient-tab-${seat.key}`).join(','),
  );
  // A hand-rolled bar owes its own tab semantics — as four plain buttons a
  // screen reader loses "tab 2 of 4, selected" entirely.
  assertEqual('bar announces as a tab list', String(bar?.props.accessibilityRole), 'tablist');
  assertEqual('bar carries the web tablist role', String(bar?.props.role), 'tablist');
  SEATS.forEach(seat => {
    const node = only(root, `patient-tab-${seat.key}`);
    if (!node) return;
    assertEqual(`seat ${seat.key} role`, String(node.props.accessibilityRole), 'tab');
    assertEqual(`seat ${seat.key} web role`, String(node.props.role), 'tab');
    assertEqual(`seat ${seat.key} accessible name`, String(node.props.accessibilityLabel), seat.label);
    assert(`seat ${seat.key} shows its label`, textOf(node).includes(seat.label));
    const active = seat.key === 'today';
    assertEqual(
      `seat ${seat.key} selected state on /today`,
      String(Boolean((node.props.accessibilityState as { selected?: boolean } | undefined)?.selected)),
      String(active),
    );
    // The marker IS the seat: the seat Pressable itself carries the lit
    // capsule, sized to the bar's inner height, so nothing above or below
    // the icon moves between the lit and unlit states. Expected numbers are
    // spelled out here rather than imported from the component — a test
    // that reads its own expectation out of the code under test would wave
    // any future re-shuffle straight through.
    const seatStyle = flattenStyle(node.props.style);
    assertEqual(`seat ${seat.key} fills the capsule's inner height`, Number(seatStyle.height), 48);
    assertEqual(`seat ${seat.key} is capsule-shaped`, Number(seatStyle.borderRadius), 24);
    assertEqual(
      `seat ${seat.key} leaves 6pt of bar above and below`,
      PATIENT_BAR_HEIGHT - Number(seatStyle.height),
      12,
    );
    assertEqual(`seat ${seat.key} centers its glyph`, String(seatStyle.justifyContent), 'center');
    assertEqual(`seat ${seat.key} adds no vertical padding`, seatStyle.paddingVertical ?? 0, 0);
    // The lit background belongs to the seat itself, and unlit seats stay
    // fully transparent — a seat that painted a nested box would reintroduce
    // exactly the height-stealing marker this replaced.
    assertEqual(
      `seat ${seat.key} background on /today`,
      String(seatStyle.backgroundColor),
      active ? colors.light.accent : 'transparent',
    );
    assertEqual(`seat ${seat.key} lights nothing but itself`, litSeats(node), active ? 1 : 0);
    // No decorative child of any color may return: the seat holds its glyph
    // and its label, nothing else. A tick/underline would show up here as a
    // childless host box, whatever color it was painted.
    const decorations = node.findAll(
      n => isHost(n) && n !== node && n.type === 'View' && n.findAll(inner => isHost(inner) && inner !== n).length === 0,
    );
    assertEqual(`seat ${seat.key} draws no underline or tick`, decorations.length, 0);
    const feather = node.findAll(n => isHost(n) && n.type === 'Feather')[0];
    assertEqual(`web seat ${seat.key} glyph`, String(feather?.props.name), seat.feather);
    assertEqual(`web seat ${seat.key} draws no SF symbol`, node.findAll(n => isHost(n) && n.type === 'SymbolView').length, 0);
  });

  // ── 3. Seat semantics: tab-swap, skip-when-there, coach stacks over ──────
  const pressSeat = (key: string) => {
    clearRouterCalls();
    const before = selectionCalls.count;
    tap(only(root, `patient-tab-${key}`));
    assertEqual(`seat ${key}: one selection tick`, selectionCalls.count, before + 1);
  };

  pressSeat('diary');
  assertEqual(
    'seat diary: swaps tabs',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'navigate', target: '/diary' }]),
  );
  pressSeat('progress');
  assertEqual(
    'seat progress: swaps tabs',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'navigate', target: '/progress' }]),
  );
  pressSeat('coach');
  assertEqual(
    'seat coach: stacks the chat over the current screen',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'push', target: '/coach-chat' }]),
  );
  pressSeat('today');
  assertEqual('seat today: already there, no re-navigation', routerCalls.length, 0);

  // Active marking follows the route, not a local guess.
  routerState.pathname = '/diary';
  const rerender = render(h(PatientTabLayout));
  const diarySeat = only(rerender.root, 'patient-tab-diary');
  assertEqual(
    'on /diary: diary seat reports selected',
    String((diarySeat?.props.accessibilityState as { selected?: boolean } | undefined)?.selected),
    'true',
  );
  assertEqual('on /diary: exactly one seat is lit', litSeats(only(rerender.root, 'patient-tab-bar')!), 1);
  unmount(rerender);

  // Library and Plan live in the menu, not the bar: on those screens NO seat
  // may claim the tick (a bar that lies about where you are is worse than a
  // bar with nothing lit) — the menu row carries the marker instead.
  (['/recipes', '/plan'] as const).forEach(where => {
    routerState.pathname = where;
    const tree = render(h(PatientTabLayout));
    assertEqual(`on ${where}: no seat is lit`, litSeats(only(tree.root, 'patient-tab-bar')!), 0);
    SEATS.forEach(seat => {
      const node = only(tree.root, `patient-tab-${seat.key}`);
      assertEqual(
        `on ${where}: seat ${seat.key} reports unselected`,
        String(Boolean((node?.props.accessibilityState as { selected?: boolean } | undefined)?.selected)),
        'false',
      );
    });
    tap(only(tree.root, 'patient-fab'));
    const rowKey = where === '/recipes' ? 'library' : 'plan';
    const row = only(tree.root, `patient-menu-${rowKey}`);
    assertEqual(`on ${where}: menu row ${rowKey} carries the tick`, row ? orangeTicks(row) : NaN, 1);
    unmount(tree);
  });

  // The coach seat pushes unconditionally — unlike the navigate seats it
  // never skips, so a second visit always stacks a fresh chat screen.
  routerState.pathname = '/coach-chat';
  const onCoach = render(h(PatientTabLayout));
  clearRouterCalls();
  tap(only(onCoach.root, 'patient-tab-coach'));
  assertEqual(
    'coach seat never skips (push, not navigate)',
    JSON.stringify(routerCalls),
    JSON.stringify([{ method: 'push', target: '/coach-chat' }]),
  );
  unmount(onCoach);
  routerState.pathname = '/today';

  // ── 4. Menu contract: two groups, plus launcher, Log food primary ────────
  checkMenuContract({
    side: 'patient(web)',
    root,
    idPrefix: 'patient',
    sections: PATIENT_SECTIONS,
    openLabel: 'Open menu and quick actions',
    closeLabel: 'Close menu and quick actions',
    restingIcon: 'plus',
    primary: { key: 'log-food', label: 'Log food', a11yLabel: 'Log food', iconName: 'plus' },
    fabBottom: WEB_FAB_BOTTOM,
  });

  // ── 5. Rows close the menu, tick feedback, land on existing screens ──────
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

  // The two overflow destinations swap screens like the bar's seats do.
  await rowNavigates('library', { method: 'navigate', target: '/recipes' });
  await rowNavigates('plan', { method: 'navigate', target: '/plan' });
  await rowNavigates('barcode', { method: 'push', target: '/barcode-scan' });
  await rowNavigates('care-team-chat', { method: 'push', target: '/care-team-chat' });
  await rowNavigates('check-in', { method: 'push', target: '/check-in' });
  await rowNavigates('log-food', { method: 'push', target: '/log-food' });
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
  assertEqual('on /progress: row shows the orange tick', activeRow ? orangeTicks(activeRow) : NaN, 1);
  clearRouterCalls();
  await tapAndSettle(activeRow);
  assertEqual('on /progress: menu closes without re-navigating', byTestID(root, 'patient-menu').length, 0);
  assertEqual('on /progress: no duplicate navigation', routerCalls.length, 0);
  routerState.pathname = '/today';

  // ── 6. Snap a meal photo (web): picker → preview survives the closed menu ─
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

  // ── 7. Persona gate: neither surface leaks outside the patient side ──────
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
  assertEqual('staff persona: no patient pill bar', byTestID(staffTree.root, 'patient-tab-bar').length, 0);
  unmount(staffTree);
  appModeState.mode = 'patient';

  // ── 8. Device placement, SF symbols, in-app camera handoff ───────────────
  Platform.OS = 'ios';
  const NATIVE_BAR_BOTTOM = patientBarBottom(INSET_BOTTOM);
  const NATIVE_FAB_BOTTOM = patientFabBottom(INSET_BOTTOM);
  assertEqual('device bar shelf (home indicator + gutter)', NATIVE_BAR_BOTTOM, INSET_BOTTOM + 6);
  assertEqual(
    'device circle centers on the bar',
    NATIVE_FAB_BOTTOM,
    NATIVE_BAR_BOTTOM + (PATIENT_BAR_HEIGHT - FAB_SIZE) / 2,
  );

  const nativeLayout = render(h(PatientTabLayout));
  const nativeBar = only(nativeLayout.root, 'patient-tab-bar');
  assertEqual(
    'device: bar clears the home indicator',
    Number(flattenStyle(nativeBar?.props.style).bottom),
    NATIVE_BAR_BOTTOM,
  );
  SEATS.forEach(seat => {
    const node = only(nativeLayout.root, `patient-tab-${seat.key}`);
    if (!node) return;
    const symbol = node.findAll(n => isHost(n) && n.type === 'SymbolView')[0];
    assertEqual(`device seat ${seat.key} SF symbol`, String(symbol?.props.name), seat.sf);
  });
  assertEqual(
    'device: circle rides the same shelf inside the layout',
    Number(flattenStyle(only(nativeLayout.root, 'patient-fab')?.props.style).bottom),
    NATIVE_FAB_BOTTOM,
  );
  unmount(nativeLayout);

  const nativeTree = render(h(PatientFabMenu));
  const nativeFab = only(nativeTree.root, 'patient-fab');
  assertEqual(
    'device: launcher anchors to the shared shelf',
    Number(flattenStyle(nativeFab?.props.style).bottom),
    NATIVE_FAB_BOTTOM,
  );
  const providerBottom = Math.max(INSET_BOTTOM, 14) + 14;
  // Both personas now float in the gutter (patients beside their pill bar,
  // staff alone), so neither may sit on the home indicator.
  assert('device: the patient row clears the home indicator', NATIVE_BAR_BOTTOM >= INSET_BOTTOM);
  assert('device: the patient circle clears the home indicator', NATIVE_FAB_BOTTOM >= INSET_BOTTOM);
  assert('device: the staff circle clears the home indicator', providerBottom >= INSET_BOTTOM);

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

  // ── 9. Staff side unchanged: same shared contract, staff config ──────────
  routerState.pathname = '/patients';
  const providerTree = render(h(ProviderFabMenu));
  assertEqual('staff has no pill bar', byTestID(providerTree.root, 'patient-tab-bar').length, 0);
  checkMenuContract({
    side: 'provider',
    root: providerTree.root,
    idPrefix: 'provider',
    sections: PROVIDER_SECTIONS,
    openLabel: 'Open navigation menu',
    closeLabel: 'Close navigation menu',
    restingIcon: 'grid',
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

  // ── 10. Everything else stacks above the floating row ────────────────────
  const clearsRow = (label: string, value: number, insetsBottom: number) => {
    assert(`${label}: clears the pill bar`, value >= patientBarBottom(insetsBottom) + PATIENT_BAR_HEIGHT);
    assert(`${label}: clears the launcher circle`, value >= patientFabBottom(insetsBottom) + FAB_SIZE);
  };
  assertEqual(
    'web: snackbar shelf rides the row top + 12',
    patientSnackbarBottom(INSET_BOTTOM),
    WEB_BAR_BOTTOM + PATIENT_BAR_HEIGHT + 12,
  );
  clearsRow('web snackbar', patientSnackbarBottom(INSET_BOTTOM), INSET_BOTTOM);
  clearsRow('web scroll padding', patientContentBottom(INSET_BOTTOM), INSET_BOTTOM);
  assert(
    'web: scroll padding leaves more room than the snackbar shelf',
    patientContentBottom(INSET_BOTTOM) > patientSnackbarBottom(INSET_BOTTOM),
  );
  Platform.OS = 'ios';
  assertEqual(
    'device: snackbar shelf rides the row top + 12',
    patientSnackbarBottom(INSET_BOTTOM),
    NATIVE_BAR_BOTTOM + PATIENT_BAR_HEIGHT + 12,
  );
  clearsRow('device snackbar', patientSnackbarBottom(INSET_BOTTOM), INSET_BOTTOM);
  clearsRow('device scroll padding', patientContentBottom(INSET_BOTTOM), INSET_BOTTOM);
  Platform.OS = 'web';

  // ── 11. One implementation, one shelf (static drift guards) ──────────────
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const providerSrc = read('components/provider/ProviderFabMenu.tsx');
  const patientSrc = read('components/patient/PatientFabMenu.tsx');
  const ownsVisuals = (src: string) =>
    src.includes('<AppModal') || src.includes('Animated.') || src.includes('StyleSheet.create');
  assert('staff wrapper renders the shared FabMenu', providerSrc.includes('<FabMenu'));
  assert('patient wrapper renders the shared FabMenu', patientSrc.includes('<FabMenu'));
  assert('staff wrapper is config-only (no visuals to drift)', !ownsVisuals(providerSrc));
  assert('patient wrapper is config-only (no visuals to drift)', !ownsVisuals(patientSrc));
  const layoutSrc = read('app/(patient)/_layout.tsx');
  assert('patient layout mounts the launcher', layoutSrc.includes('<PatientFabMenu'));
  assert('patient layout mounts the pill bar', layoutSrc.includes('<PatientTabBar'));
  assert('staff tab layout keeps its launcher', read('app/(tabs)/_layout.tsx').includes('<ProviderFabMenu'));
  assert(
    'snackbar rides the shared shelf constant',
    read('components/ui/Snackbar.tsx').includes('patientSnackbarBottom('),
  );
  // Every patient screen pads from the shared shelf — a leftover literal is
  // exactly how content starts hiding under the floating row again.
  ['today', 'diary', 'recipes', 'progress', 'plan'].forEach(screen => {
    const src = read(`app/(patient)/${screen}.tsx`);
    assert(`${screen} pads from the shared shelf`, src.includes('patientContentBottom(insets.bottom)'));
    assert(`${screen} keeps no hardcoded tab-bar allowance`, !src.includes('84 + 20'));
  });
  // Coach earned a permanent seat, so the old hero shortcut is gone (two
  // entry points to the same chat on one screen is the clutter we removed).
  assert(
    'today drops the duplicate hero coach button',
    !read('app/(patient)/today.tsx').includes('coach-chat-btn'),
  );
  assert(
    'the pill bar carries the coach seat instead',
    read('components/patient/PatientTabBar.tsx').includes("href: '/coach-chat'"),
  );

  finish();
}

main().catch((error: unknown) => {
  fail(`unhandled: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  finish();
});
