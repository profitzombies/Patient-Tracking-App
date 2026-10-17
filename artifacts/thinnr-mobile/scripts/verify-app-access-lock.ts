/**
 * App-access lock regression check (no network, no AI credits).
 *
 * Once an office charges for the app's premium AI features, the patient app
 * must honor the entitlement the server reports: everything behaves as
 * today during the free window and while subscribed; otherwise every
 * premium entry point opens ONE upgrade sheet and nothing else changes.
 * This suite runs the real reader, provider, sheet, notices and entry-point
 * wiring under Node (react-test-renderer via tsconfig.app-access-lock.json
 * stubs) against a scripted transport, and pins:
 *
 *   1. Parsing — the wire entitlement is validated whole (half-read answers
 *      are null, never acted on); the checkout link must be http(s); the
 *      402 `upgradeRequired` signal reads with or without its entitlement.
 *   2. Selectors — an unknown entitlement is NOT a lock; the ending-soon
 *      notice fires only inside the last days of a chargeable, still-open
 *      free window with a price, never for an office that does not charge,
 *      never while locked or subscribed.
 *   3. API clients — the coach stream reports the 402 as NON-retryable with
 *      the entitlement attached; the menu, label and barcode clients throw
 *      their error class flagged upgradeRequired; ordinary failures stay
 *      unflagged.
 *   4. Provider — demo/signed-out sessions never probe; a real account reads
 *      on open with its bearer, on foreground return, after a 402 report,
 *      and after the checkout page closes; the lock lifts (and the sheet
 *      closes by itself) when the next read says subscribed; a lapse
 *      re-locks the same way; a failed read keeps the current state; a slow
 *      answer for the previous account is discarded (account epoch); the
 *      sheet shows the office's price + cadence, the three restored
 *      features, an Open checkout that waits on the link, and Not now.
 *   5. Entry points — coach seat, meal photo flow, menu scan, barcode scan
 *      and the composer-side locked notice all open the sheet when locked
 *      (never the camera, picker, lookup or chat), behave exactly as
 *      before when unlocked, and let the HQ coach pause keep precedence.
 *   6. Stale state — a lookup/scan that still reaches the server and
 *      answers 402 reports the lock to the seam, shows no error/retry box,
 *      and keeps the screen usable.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:app-access-lock
 */
import React, { act } from 'react';

import { Platform, emitAppStateChange } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { openedBrowserUrls } from './patient-billing-stubs/expo-web-browser';
import { pickerCalls, pickerScript, resetPickerCalls } from './app-access-lock-stubs/expo-image-picker';
import { coachState, resetCoachStub } from './app-access-lock-stubs/coach-chat-context';
import {
  clearRouterCalls,
  routerCalls,
  routerState,
} from './barcode-scan-stubs/expo-router';
import {
  PatientAccountContext,
  type PatientAccountState,
} from '../context/PatientAccountContext';
import { AppAccessContext, type AppAccessState } from '../context/AppAccessContext';
import { AppAccessProvider } from '../context/AppAccessProvider';
import { AppModeProvider } from '../context/AppModeContext';
import { PatientProvider } from '../context/PatientContext';
import { PatientTabBar } from '../components/patient/PatientTabBar';
import { useMealPhotoFlow } from '../components/patient/MealPhotoButton';
import {
  FreeWindowEndingNotice,
  PremiumLockedNotice,
} from '../components/patient/PremiumAccessNotices';
import BarcodeScanScreen from '../app/barcode-scan';
import MenuScanScreen from '../app/menu-scan';
import {
  ENDING_SOON_DAYS,
  PREMIUM_FEATURES,
  appAccessPriceLine,
  describeEndingDay,
  endingSoonNotice,
  parseAppAccessEntitlement,
  parsePatientAppAccess,
  premiumLocked,
  readUpgradeRequired,
  type AppAccessEntitlement,
  type PatientAppAccess,
} from '../lib/app-access';
import {
  LabelScanError,
  MenuScanError,
  scanLabelPhoto,
  scanMenuPhoto,
  streamCoachChat,
} from '../lib/coach-api';
import { BarcodeLookupError, lookupBarcode } from '../lib/barcode-food';
import { localTodayKey } from '../lib/live-patient-entry';

// ── Harness ─────────────────────────────────────────────────────────────────

let checks = 0;
let failures = 0;
let finished = false;

function fail(message: string): void {
  failures += 1;
  console.error(`FAIL - ${message}`);
}

function assert(label: string, condition: boolean): void {
  checks += 1;
  if (condition) console.log(`ok - ${label}`);
  else fail(label);
}

function assertEqual(label: string, actual: string | number | boolean | null, expected: string | number | boolean | null): void {
  checks += 1;
  if (Object.is(actual, expected)) console.log(`ok - ${label}`);
  else fail(`${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
}

function finish(): never {
  finished = true;
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

process.on('beforeExit', () => {
  if (!finished) {
    console.error('✗ app-access lock check: exited before finishing (dangling await?)');
    process.exit(1);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function settle(): Promise<void> {
  await sleep(0);
  await sleep(0);
  await sleep(0);
}

async function actSettle(mutate?: () => void): Promise<void> {
  await act(async () => {
    mutate?.();
    await settle();
  });
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  checks += 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      console.log(`ok - ${label}`);
      return;
    }
    if (Date.now() > deadline) {
      fail(`${label}: condition not met within ${timeoutMs}ms`);
      return;
    }
    await act(async () => {
      await sleep(8);
    });
  }
}

type HostNode = { type: unknown; props: Record<string, unknown> };
type Rendered = {
  root: { findAll(predicate: (node: HostNode) => boolean): HostNode[] };
  toJSON(): unknown;
  unmount(): void;
  update(element: React.ReactElement): void;
};

const byTestID = (tree: Rendered, testID: string): HostNode | null =>
  tree.root.findAll(node => typeof node.type === 'string' && node.props?.testID === testID)[0] ?? null;
const present = (tree: Rendered, testID: string): boolean => byTestID(tree, testID) !== null;

async function tap(tree: Rendered, testID: string): Promise<void> {
  const node = byTestID(tree, testID);
  if (!node) {
    fail(`tap: no node with testID "${testID}"`);
    return;
  }
  if (node.props.disabled === true) return; // a disabled Pressable swallows taps
  const onPress = node.props.onPress as (() => unknown) | undefined;
  await actSettle(() => {
    void onPress?.();
  });
}

async function typeText(tree: Rendered, testID: string, value: string): Promise<void> {
  const node = byTestID(tree, testID);
  if (!node) {
    fail(`typeText: no node with testID "${testID}"`);
    return;
  }
  const onChangeText = node.props.onChangeText as ((next: string) => void) | undefined;
  await actSettle(() => {
    onChangeText?.(value);
  });
}

function treeText(node: unknown): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(treeText).join(' ');
  const children = (node as { children?: unknown }).children;
  return treeText(children ?? null);
}
function nodeText(tree: Rendered, testID: string): string {
  const matches = tree.root.findAll(
    node => typeof node.type === 'string' && node.props?.testID === testID,
  ) as unknown as Array<{ children?: unknown }>;
  const node = matches[0];
  if (!node) return '';
  // react-test-renderer instances expose children as instances; render the
  // whole tree instead and slice by the testID's subtree via toJSON.
  const json = findJson(tree.toJSON(), testID);
  return treeText(json);
}
function findJson(node: unknown, testID: string): unknown {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findJson(child, testID);
      if (hit) return hit;
    }
    return null;
  }
  const record = node as { props?: Record<string, unknown>; children?: unknown };
  if (record.props?.testID === testID) return node;
  return findJson(record.children ?? null, testID);
}

// ── Scripted transport ──────────────────────────────────────────────────────

interface Scripted {
  status: number;
  body: unknown;
}
/** Per-path responders: 'app-access', 'coach/chat', 'coach/menu-scan', 'coach/label-scan', 'barcode'. */
const responders = new Map<string, () => Scripted | Promise<Scripted>>();
const requestLog: Array<{ path: string; auth: string | null }> = [];
/**
 * 'faithful' — like real fetch, an aborted request rejects on arrival.
 * 'leaky'    — ignores the abort and delivers anyway, so the provider's own
 *              account-epoch guard is the only thing between a late answer
 *              and the wrong account's lock.
 */
let transportMode: 'faithful' | 'leaky' = 'faithful';
const accessReads = () => requestLog.filter(r => r.path === 'app-access').length;

function pathOf(url: string): string {
  if (url.includes('/patient-data/billing/app-access')) return 'app-access';
  if (url.includes('/coach/chat')) return 'coach/chat';
  if (url.includes('/coach/menu-scan')) return 'coach/menu-scan';
  if (url.includes('/coach/label-scan')) return 'coach/label-scan';
  if (url.includes('/barcode/')) return 'barcode';
  throw new Error(`unexpected fetch: ${url}`);
}

const scriptedFetch = (async (input: unknown, init?: { headers?: unknown; signal?: AbortSignal }) => {
  const url = String(
    typeof input === 'object' && input !== null && 'url' in (input as object)
      ? (input as { url: unknown }).url
      : input,
  );
  const path = pathOf(url);
  const headers =
    init && typeof init.headers === 'object' && init.headers !== null
      ? (init.headers as Record<string, string>)
      : {};
  requestLog.push({ path, auth: headers.Authorization ?? null });
  const responder = responders.get(path);
  if (!responder) throw new Error(`no responder for ${path}`);
  const scripted = await responder();
  if (transportMode === 'faithful' && init?.signal?.aborted) {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  return new Response(JSON.stringify(scripted.body), {
    status: scripted.status,
    headers: { 'Content-Type': 'application/json' },
  });
}) as unknown as typeof fetch;

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHECKOUT_URL = 'https://billing.example.test/app-access/checkout?token=abc';

function shiftDay(todayKey: string, days: number): string {
  const date = new Date(`${todayKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const TODAY = localTodayKey();

const freeWindow = (endsOn: string, kind: 'protocol' | 'trial' = 'protocol'): PatientAppAccess => ({
  available: true,
  reason: kind === 'protocol' ? 'protocol_window' : 'trial',
  free_window: { kind, ends_on: endsOn },
  office_charges: true,
  price_cents: 999,
  cadence: 'monthly',
  subscription: null,
  subscription_id: null,
  checkout_url: null,
});

const LOCKED: PatientAppAccess = {
  available: false,
  reason: 'locked',
  free_window: { kind: 'protocol', ends_on: shiftDay(TODAY, -4) },
  office_charges: true,
  price_cents: 999,
  cadence: 'monthly',
  subscription: null,
  subscription_id: null,
  checkout_url: CHECKOUT_URL,
};

const SUBSCRIBED: PatientAppAccess = {
  available: true,
  reason: 'subscribed',
  free_window: { kind: 'protocol', ends_on: shiftDay(TODAY, -4) },
  office_charges: true,
  price_cents: 999,
  cadence: 'monthly',
  subscription: { state: 'active', current_period_end: shiftDay(TODAY, 20), cancel_at_period_end: false },
  subscription_id: 'sub_1',
  checkout_url: null,
};

const LAPSED: PatientAppAccess = {
  ...LOCKED,
  subscription: { state: 'canceled', current_period_end: shiftDay(TODAY, -1), cancel_at_period_end: true },
  subscription_id: 'sub_1',
};

const NOT_CHARGING: PatientAppAccess = {
  available: true,
  reason: 'office_not_charging',
  free_window: { kind: 'protocol', ends_on: shiftDay(TODAY, 1) },
  office_charges: false,
  price_cents: null,
  cadence: null,
  subscription: null,
  subscription_id: null,
  checkout_url: null,
};

const LOCKED_ENTITLEMENT: AppAccessEntitlement = {
  available: false,
  reason: 'locked',
  free_window: { kind: 'trial', ends_on: shiftDay(TODAY, -2) },
  office_charges: true,
  price_cents: 499,
  cadence: '2_weeks',
  subscription: null,
};

const UPGRADE_402 = {
  error: 'Subscribe to keep using the AI coach.',
  retryable: false,
  upgradeRequired: true,
  entitlement: LOCKED_ENTITLEMENT,
};

function scriptAccess(answer: PatientAppAccess | { status: number; body?: unknown }): void {
  if ('status' in answer) {
    responders.set('app-access', () => ({ status: answer.status, body: answer.body ?? { error: 'nope' } }));
    return;
  }
  responders.set('app-access', () => ({ status: 200, body: answer }));
}

// ── Fake account seam (the real provider reads it) ──────────────────────────

const tokenLog: string[] = [];
function accountValue(kind: 'signed-out' | 'real', patientId = 'pat-1'): PatientAccountState {
  if (kind === 'signed-out') {
    return { resolving: false, account: { kind: 'signed-out' }, accountNotice: null, retryResolve: () => {} };
  }
  return {
    resolving: false,
    account: { kind: 'real', patientId, api: {} as never } as PatientAccountState['account'],
    accountNotice: null,
    retryResolve: () => {},
    getAccessToken: async () => {
      tokenLog.push(patientId);
      return `token-${patientId}`;
    },
  };
}

// ── Recording seam for the entry-point section ──────────────────────────────

const seamCalls = { sheet: 0, reports: [] as Array<AppAccessEntitlement | null>, refresh: 0 };
function seamValue(access: PatientAppAccess | null): AppAccessState {
  return {
    access,
    locked: premiumLocked(access),
    refresh: async () => {
      seamCalls.refresh += 1;
    },
    openUpgradeSheet: () => {
      seamCalls.sheet += 1;
    },
    reportUpgradeRequired: entitlement => {
      seamCalls.reports.push(entitlement);
    },
  };
}
function resetSeam(): void {
  seamCalls.sheet = 0;
  seamCalls.reports.length = 0;
  seamCalls.refresh = 0;
}

const MODE_KEY = 'thinnr_app_mode_v1';

async function main() {
  process.env.EXPO_PUBLIC_DOMAIN = 'app-access.internal';
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = scriptedFetch;
  Platform.OS = 'web';

  if (!globalThis.localStorage) {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => (store.has(key) ? store.get(key) : null),
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    };
  }

  const realConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) return;
    if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return;
    realConsoleError(...args);
  };

  const rendererModule = (await import('react-test-renderer')) as unknown as {
    default?: { create: (el: React.ReactElement) => Rendered };
    create?: (el: React.ReactElement) => Rendered;
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');
  const create = async (element: React.ReactElement): Promise<Rendered> => {
    let tree!: Rendered;
    await act(async () => {
      tree = TestRenderer.create!(element);
      await settle();
    });
    return tree;
  };
  const h = React.createElement;

  // ── 1. Parsing ────────────────────────────────────────────────────────────
  {
    const parsed = parsePatientAppAccess(LOCKED);
    assert('a complete locked answer parses whole', parsed?.available === false && parsed.reason === 'locked');
    assertEqual('the checkout link survives parsing', parsed?.checkout_url ?? null, CHECKOUT_URL);
    assertEqual(
      'a non-http checkout link is dropped',
      parsePatientAppAccess({ ...LOCKED, checkout_url: 'javascript:alert(1)' })?.checkout_url ?? null,
      null,
    );
    assert('an unknown reason is not an entitlement', parseAppAccessEntitlement({ ...LOCKED, reason: 'maybe' }) === null);
    assert('a malformed free window is not an entitlement', parseAppAccessEntitlement({ ...LOCKED, free_window: { kind: 'protocol', ends_on: 'soon' } }) === null);
    assert('a missing office_charges flag is not an entitlement', parseAppAccessEntitlement({ ...LOCKED, office_charges: undefined }) === null);
    assert('a negative price reads as no price', parseAppAccessEntitlement({ ...LOCKED, price_cents: -5 })?.price_cents === null);
    const upgrade = readUpgradeRequired(UPGRADE_402);
    assert('the 402 signal reads with its entitlement', upgrade?.upgradeRequired === true && upgrade.entitlement?.reason === 'locked');
    assert('the 402 signal reads without an entitlement', readUpgradeRequired({ upgradeRequired: true })?.entitlement === null);
    assert('an ordinary error body is not an upgrade signal', readUpgradeRequired({ error: 'x', retryable: false }) === null);
  }

  // ── 2. Selectors ──────────────────────────────────────────────────────────
  {
    assertEqual('unknown entitlement is not a lock', premiumLocked(null), false);
    assertEqual('available:false is the lock', premiumLocked(LOCKED), true);
    assertEqual('subscribed is not a lock', premiumLocked(SUBSCRIBED), false);
    assertEqual('price line reads price + cadence', appAccessPriceLine(LOCKED) ?? '', '$9.99 a month');
    assertEqual('2-week cadence reads in patient words', appAccessPriceLine(LOCKED_ENTITLEMENT) ?? '', '$4.99 every 2 weeks');
    assertEqual('a non-charging office has no price line', appAccessPriceLine(NOT_CHARGING), null);

    const soon = endingSoonNotice(freeWindow(shiftDay(TODAY, 2)), TODAY);
    assert('a window ending in 2 days earns the notice', soon?.daysLeft === 2 && soon.priceLine === '$9.99 a month');
    assertEqual('the notice names the day', describeEndingDay(soon!), `on ${new Date(`${shiftDay(TODAY, 2)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`);
    assertEqual('ending today reads "today"', describeEndingDay(endingSoonNotice(freeWindow(TODAY), TODAY)!), 'today');
    assertEqual('ending tomorrow reads "tomorrow"', describeEndingDay(endingSoonNotice(freeWindow(shiftDay(TODAY, 1), 'trial'), TODAY)!), 'tomorrow');
    assert('a window with more days left earns no notice', endingSoonNotice(freeWindow(shiftDay(TODAY, ENDING_SOON_DAYS + 1)), TODAY) === null);
    assert('a window ending exactly at the threshold earns the notice', endingSoonNotice(freeWindow(shiftDay(TODAY, ENDING_SOON_DAYS)), TODAY) !== null);
    assert('an office that does not charge earns no notice', endingSoonNotice(NOT_CHARGING, TODAY) === null);
    assert('an office that does not charge earns no notice even with a stale price on file', endingSoonNotice({ ...NOT_CHARGING, price_cents: 999, cadence: 'monthly' }, TODAY) === null);
    assertEqual('an office that does not charge has no price line even with a stale price on file', appAccessPriceLine({ ...NOT_CHARGING, price_cents: 999, cadence: 'monthly' }), null);
    assert('a locked entitlement earns no notice', endingSoonNotice(LOCKED, TODAY) === null);
    assert('a subscription earns no notice', endingSoonNotice({ ...SUBSCRIBED, free_window: { kind: 'protocol', ends_on: shiftDay(TODAY, 1) } }, TODAY) === null);
    assert('a window without a price on file earns no notice', endingSoonNotice({ ...freeWindow(shiftDay(TODAY, 1)), price_cents: null }, TODAY) === null);
    assert('an already-passed window earns no notice', endingSoonNotice(freeWindow(shiftDay(TODAY, -1)), TODAY) === null);
  }

  // ── 3. API clients: the terminal 402 ──────────────────────────────────────
  {
    // No `retryable` flag in the body: the upgrade signal alone must make
    // the failure terminal.
    const { retryable: _omitted, ...upgradeOnly } = UPGRADE_402;
    responders.set('coach/chat', () => ({ status: 402, body: upgradeOnly }));
    const events: string[] = [];
    let details: Record<string, unknown> = {};
    await streamCoachChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      {
        onDelta: () => events.push('delta'),
        onCard: () => events.push('card'),
        onDone: () => events.push('done'),
        onError: (message, retryable, extra) => {
          events.push(`error(${retryable ? 'retryable' : 'terminal'}):${message}`);
          details = (extra ?? {}) as Record<string, unknown>;
        },
      } as never,
    );
    assertEqual('coach chat: the 402 is terminal with the server wording', events.join('|'), 'error(terminal):Subscribe to keep using the AI coach.');
    assert('coach chat: the error carries the upgrade flag + entitlement', details.upgradeRequired === true && (details.entitlement as AppAccessEntitlement | null)?.reason === 'locked');

    responders.set('coach/chat', () => ({ status: 429, body: { error: 'Slow down.' } }));
    details = {};
    await streamCoachChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      { onDelta: () => {}, onCard: () => {}, onDone: () => {}, onError: (_m: string, _r: boolean, extra?: unknown) => { details = (extra ?? {}) as Record<string, unknown>; } } as never,
    );
    assert('coach chat: an ordinary failure is not flagged', details.upgradeRequired !== true);

    responders.set('coach/menu-scan', () => ({ status: 402, body: UPGRADE_402 }));
    let menuError: unknown = null;
    try {
      await scanMenuPhoto('data:image/jpeg;base64,AAAA');
    } catch (error) {
      menuError = error;
    }
    assert('menu scan: the 402 throws MenuScanError flagged upgradeRequired', menuError instanceof MenuScanError && menuError.upgradeRequired && menuError.entitlement?.cadence === '2_weeks');

    responders.set('coach/label-scan', () => ({ status: 402, body: { upgradeRequired: true } }));
    let labelError: unknown = null;
    try {
      await scanLabelPhoto('data:image/jpeg;base64,AAAA');
    } catch (error) {
      labelError = error;
    }
    assert('label scan: a bare 402 signal still flags the error (entitlement null)', labelError instanceof LabelScanError && labelError.upgradeRequired && labelError.entitlement === null);

    responders.set('barcode', () => ({ status: 402, body: UPGRADE_402 }));
    let barcodeError: unknown = null;
    try {
      await lookupBarcode('3017624010701');
    } catch (error) {
      barcodeError = error;
    }
    assert('barcode: the 402 throws BarcodeLookupError flagged upgradeRequired', barcodeError instanceof BarcodeLookupError && barcodeError.upgradeRequired && barcodeError.entitlement?.reason === 'locked');

    responders.set('barcode', () => ({ status: 500, body: { error: 'boom' } }));
    barcodeError = null;
    try {
      await lookupBarcode('3017624010701');
    } catch (error) {
      barcodeError = error;
    }
    assert('barcode: an ordinary failure is not flagged', barcodeError instanceof BarcodeLookupError && !barcodeError.upgradeRequired);
  }

  // ── 4. Provider ───────────────────────────────────────────────────────────
  {
    const probe: { current: AppAccessState | null } = { current: null };
    function Probe(): null {
      probe.current = React.useContext(AppAccessContext);
      return null;
    }
    const seam = () => {
      if (!probe.current) throw new Error('probe never rendered');
      return probe.current;
    };
    const renderWith = (account: PatientAccountState) =>
      h(
        PatientAccountContext.Provider,
        { value: account },
        h(AppAccessProvider, null, h(Probe), h(FreeWindowEndingNotice), h(PremiumLockedNotice)),
      );

    // 4a. Signed-out: never probes, nothing to open.
    requestLog.length = 0;
    scriptAccess(LOCKED);
    const tree = await create(renderWith(accountValue('signed-out')));
    assertEqual('signed-out: the entitlement is never read', accessReads(), 0);
    assertEqual('signed-out: nothing is locked', seam().locked, false);
    await actSettle(() => seam().openUpgradeSheet());
    assert('signed-out: the sheet cannot open', !present(tree, 'upgrade-sheet'));
    await actSettle(() => seam().reportUpgradeRequired(LOCKED_ENTITLEMENT));
    assertEqual('signed-out: a stray 402 report cannot lock', seam().locked, false);
    assertEqual('signed-out: a stray 402 report triggers no read', accessReads(), 0);

    // 4b. Real account, locked.
    await actSettle(() => tree.update(renderWith(accountValue('real', 'pat-1'))));
    await waitUntil('real account: read on open', () => accessReads() === 1);
    assertEqual('real account: the read carries the bearer', requestLog[0]?.auth ?? '', 'Bearer token-pat-1');
    await waitUntil('real account: the server lock lands', () => seam().locked);
    assert('locked: the sheet does not open by itself', !present(tree, 'upgrade-sheet'));
    assert('locked: the composer-side notice shows', present(tree, 'coach-locked-notice'));
    assert('locked: no ending-soon notice', !present(tree, 'coach-ending-soon-notice'));

    await tap(tree, 'coach-locked-upgrade');
    assert('locked: the notice button opens the sheet', present(tree, 'upgrade-sheet'));
    assert('sheet: shows the office price and cadence', nodeText(tree, 'upgrade-sheet-price').includes('$9.99 a month'));
    const restores = nodeText(tree, 'upgrade-sheet-restores');
    assert('sheet: lists every restored premium feature', PREMIUM_FEATURES.every(feature => restores.includes(feature)));
    assertEqual('sheet: three features are restored', PREMIUM_FEATURES.length, 3);
    assert('sheet: Open checkout is enabled with the link', byTestID(tree, 'upgrade-sheet-checkout')?.props.disabled === false);
    assert('sheet: Not now is offered', present(tree, 'upgrade-sheet-dismiss'));

    await tap(tree, 'upgrade-sheet-dismiss');
    assert('Not now closes the sheet', !present(tree, 'upgrade-sheet'));
    assertEqual('Not now keeps the lock', seam().locked, true);

    // 4c. Open checkout → browser → re-read → unlock closes the sheet.
    await actSettle(() => seam().openUpgradeSheet());
    assert('openUpgradeSheet re-opens the sheet', present(tree, 'upgrade-sheet'));
    openedBrowserUrls.length = 0;
    scriptAccess(SUBSCRIBED);
    const readsBefore = accessReads();
    // On device the checkout page opens in the in-app browser (web uses a
    // new tab); the provider reads the platform at tap time.
    Platform.OS = 'ios';
    await tap(tree, 'upgrade-sheet-checkout');
    Platform.OS = 'web';
    assertEqual('Open checkout opens the office checkout page in the browser', openedBrowserUrls[0] ?? '', CHECKOUT_URL);
    await waitUntil('returning from the browser re-reads the entitlement', () => accessReads() === readsBefore + 1);
    await waitUntil('a new subscription unlocks without a restart', () => !seam().locked);
    assert('the sheet closes by itself once unlocked', !present(tree, 'upgrade-sheet'));
    assert('subscribed: no locked notice', !present(tree, 'coach-locked-notice'));
    assert('subscribed: no ending-soon notice', !present(tree, 'coach-ending-soon-notice'));

    // 4d. Foreground return re-reads; a lapse re-locks the same way.
    scriptAccess(LAPSED);
    const readsBeforeFg = accessReads();
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('foreground return re-reads the entitlement', () => accessReads() === readsBeforeFg + 1);
    await waitUntil('a lapsed subscription re-locks', () => seam().locked);
    await actSettle(() => emitAppStateChange('background'));
    assertEqual('going to the background does not read', accessReads(), readsBeforeFg + 1);

    // 4e. A failed read keeps the current state (never unlocks on silence).
    scriptAccess({ status: 500 });
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('a failing read is attempted', () => accessReads() === readsBeforeFg + 2);
    assertEqual('a failed read keeps the lock', seam().locked, true);
    scriptAccess({ status: 200, body: { available: true } });
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('a malformed read is attempted', () => accessReads() === readsBeforeFg + 3);
    assertEqual('a malformed read keeps the lock', seam().locked, true);

    // 4f. Ending-soon notice: chargeable window in its last days.
    scriptAccess(freeWindow(shiftDay(TODAY, 1)));
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('free window: the lock lifts', () => !seam().locked);
    assert('free window ending tomorrow: the quiet notice shows', present(tree, 'coach-ending-soon-notice'));
    const noticeText = nodeText(tree, 'coach-ending-soon-notice');
    assert('ending-soon notice says when and what the office charges', noticeText.includes('ends tomorrow') && noticeText.includes('$9.99 a month'));
    assert('free window: no locked notice', !present(tree, 'coach-locked-notice'));
    await actSettle(() => seam().openUpgradeSheet());
    assert('free window: the sheet never shows while unlocked', !present(tree, 'upgrade-sheet'));

    scriptAccess(freeWindow(shiftDay(TODAY, 10)));
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('free window with days to spare: notice gone', () => !present(tree, 'coach-ending-soon-notice'));

    // 4g. Office that does not charge: never a notice, never a lock.
    scriptAccess(NOT_CHARGING);
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('non-charging office: read lands', () => seam().access?.reason === 'office_not_charging');
    assertEqual('non-charging office: not locked', seam().locked, false);
    assert('non-charging office: no ending-soon notice even with a window ending tomorrow', !present(tree, 'coach-ending-soon-notice'));

    // 4h. Stale-state 402 report: locks now, opens the sheet, re-reads for
    //     the link. The re-read is held so the "meanwhile" state is visible.
    const holdAccess = (answer: PatientAppAccess): (() => void) => {
      let release: () => void = () => {};
      responders.set('app-access', () => new Promise<Scripted>(resolve => {
        release = () => resolve({ status: 200, body: answer });
      }));
      return () => release();
    };
    let releaseRead = holdAccess(LOCKED);
    const readsBefore402 = accessReads();
    await actSettle(() => seam().reportUpgradeRequired(LOCKED_ENTITLEMENT));
    assertEqual('402 report: locked immediately', seam().locked, true);
    assert('402 report: the sheet opens', present(tree, 'upgrade-sheet'));
    assert('402 report: Open checkout waits for the link', byTestID(tree, 'upgrade-sheet-checkout')?.props.disabled === true);
    assert('402 report: the attached price shows meanwhile', nodeText(tree, 'upgrade-sheet-price').includes('$4.99 every 2 weeks'));
    assertEqual('402 report: the entitlement is re-read', accessReads(), readsBefore402 + 1);
    await actSettle(() => releaseRead());
    await waitUntil('402 report: the re-read supplies the checkout link', () => byTestID(tree, 'upgrade-sheet-checkout')?.props.disabled === false);
    await tap(tree, 'upgrade-sheet-dismiss');

    scriptAccess(SUBSCRIBED);
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('back to subscribed', () => !seam().locked);
    releaseRead = holdAccess(SUBSCRIBED);
    await actSettle(() => seam().reportUpgradeRequired(null));
    assertEqual('402 report without an entitlement still locks', seam().locked, true);
    assert('402 report without an entitlement still opens the sheet', present(tree, 'upgrade-sheet'));
    await actSettle(() => releaseRead());
    await waitUntil('the re-read (subscribed) lifts the stale lock', () => !seam().locked);
    assert('and closes the sheet', !present(tree, 'upgrade-sheet'));

    // 4i. Account epoch: a slow answer for the previous account is discarded
    //     even when the transport leaks it past the abort.
    transportMode = 'leaky';
    let releaseSlow: (() => void) | null = null;
    responders.set('app-access', () => new Promise<Scripted>(resolve => {
      releaseSlow = () => resolve({ status: 200, body: LOCKED });
    }));
    await actSettle(() => emitAppStateChange('active'));
    await waitUntil('slow read for pat-1 is in flight', () => releaseSlow !== null);
    scriptAccess(SUBSCRIBED);
    await actSettle(() => tree.update(renderWith(accountValue('real', 'pat-2'))));
    assertEqual('account switch forgets the previous entitlement', seam().access === null || seam().access?.subscription_id === 'sub_1', true);
    await waitUntil('account switch reads for the new account', () => requestLog[requestLog.length - 1]?.auth === 'Bearer token-pat-2');
    await waitUntil('pat-2 reads as subscribed', () => seam().access?.reason === 'subscribed' && !seam().locked);
    await actSettle(() => releaseSlow?.());
    assertEqual("pat-1's late locked answer never paints pat-2", seam().locked, false);
    assertEqual("pat-2's entitlement is untouched by the late answer", seam().access?.subscription_id ?? '', 'sub_1');
    transportMode = 'faithful';

    await actSettle(() => tree.update(renderWith(accountValue('signed-out'))));
    assertEqual('signing out clears the entitlement', seam().access === null, true);
    tree.unmount();
  }

  // ── 5. Entry points (recording seam) ──────────────────────────────────────
  globalThis.localStorage.setItem(MODE_KEY, 'patient');
  await AsyncStorage.setItem(MODE_KEY, 'patient');

  const withSeam = (access: PatientAppAccess | null, child: React.ReactElement) =>
    h(AppAccessContext.Provider, { value: seamValue(access) }, child);

  // 5a. Coach seat on the floating tab bar.
  {
    routerState.pathname = '/today';
    resetCoachStub();
    resetSeam();
    clearRouterCalls();
    const tree = await create(withSeam(LOCKED, h(PatientTabBar)));
    await tap(tree, 'patient-tab-coach');
    assertEqual('coach seat (locked): opens the upgrade sheet', seamCalls.sheet, 1);
    assertEqual('coach seat (locked): never navigates to the chat', routerCalls.length, 0);
    assert('coach seat (locked): the seat is still in the bar', present(tree, 'patient-tab-coach'));

    coachState.coachPaused = { message: 'Paused by HQ' };
    await actSettle(() => tree.update(withSeam(LOCKED, h(PatientTabBar))));
    await tap(tree, 'patient-tab-coach');
    assertEqual('coach seat (locked + HQ paused): the pause keeps precedence — no sheet', seamCalls.sheet, 1);
    assertEqual('coach seat (locked + HQ paused): opens the coach screens for their own notice', routerCalls.map(c => `${c.method}:${c.target}`).join('|'), 'push:/coach-history');

    coachState.coachPaused = null;
    clearRouterCalls();
    await actSettle(() => tree.update(withSeam(freeWindow(shiftDay(TODAY, 1)), h(PatientTabBar))));
    await tap(tree, 'patient-tab-coach');
    assertEqual('coach seat (free window): opens the coach screens as before', routerCalls.map(c => `${c.method}:${c.target}`).join('|'), 'push:/coach-history');
    assertEqual('coach seat (free window): no sheet', seamCalls.sheet, 1);
    clearRouterCalls();
    await actSettle(() => tree.update(withSeam(null, h(PatientTabBar))));
    await tap(tree, 'patient-tab-coach');
    assertEqual('coach seat (unknown entitlement): opens the chat', routerCalls.length, 1);
    tree.unmount();
  }

  // 5b. Meal photo flow (library picker on web).
  {
    resetCoachStub();
    resetSeam();
    resetPickerCalls();
    const flowRef: { current: ReturnType<typeof useMealPhotoFlow> | null } = { current: null };
    function FlowHost(): React.ReactElement {
      flowRef.current = useMealPhotoFlow({ mealSlot: 'lunch' as never });
      return h(React.Fragment, null, flowRef.current.modals);
    }
    const tree = await create(withSeam(LOCKED, h(FlowHost)));
    await actSettle(() => flowRef.current?.start());
    assertEqual('meal photo (locked): opens the upgrade sheet', seamCalls.sheet, 1);
    assertEqual('meal photo (locked): never launches the picker', pickerCalls.library + pickerCalls.camera, 0);

    coachState.coachPaused = { message: 'Paused by HQ' };
    await actSettle(() => tree.update(withSeam(LOCKED, h(FlowHost))));
    await actSettle(() => flowRef.current?.start());
    assertEqual('meal photo (locked + HQ paused): the pause keeps precedence — no sheet', seamCalls.sheet, 1);
    assertEqual('meal photo (locked + HQ paused): the flow runs so the coach can show its own notice', pickerCalls.library, 1);

    coachState.coachPaused = null;
    await actSettle(() => tree.update(withSeam(SUBSCRIBED, h(FlowHost))));
    await actSettle(() => flowRef.current?.start());
    assertEqual('meal photo (subscribed): launches the picker as before', pickerCalls.library, 2);
    assertEqual('meal photo (subscribed): no sheet', seamCalls.sheet, 1);
    tree.unmount();
  }

  // 5c. Menu scan screen.
  {
    routerState.pathname = '/menu-scan';
    resetSeam();
    resetPickerCalls();
    const menu = (access: PatientAppAccess | null) => withSeam(access, h(AppModeProvider, null, h(MenuScanScreen)));
    const tree = await create(menu(LOCKED));
    assertEqual('menu scan (locked): the sheet opens once on arrival', seamCalls.sheet, 1);
    assert('menu scan (locked): the screen still renders its pick actions', present(tree, 'menu-scan-choose'));
    await tap(tree, 'menu-scan-choose');
    assertEqual('menu scan (locked): choosing a photo opens the sheet', seamCalls.sheet, 2);
    assertEqual('menu scan (locked): never launches the picker', pickerCalls.library + pickerCalls.camera, 0);
    await actSettle(() => tree.update(menu(LOCKED)));
    assertEqual('menu scan (locked): a re-render does not re-open the sheet', seamCalls.sheet, 2);

    await actSettle(() => tree.update(menu(freeWindow(shiftDay(TODAY, 1)))));
    await tap(tree, 'menu-scan-choose');
    assertEqual('menu scan (free window): the picker launches as before', pickerCalls.library, 1);
    assertEqual('menu scan (free window): no sheet', seamCalls.sheet, 2);
    tree.unmount();
  }

  // 5d. Barcode scan screen: lock gate + stale-state 402.
  {
    routerState.pathname = '/barcode-scan';
    routerState.params = { date: TODAY, meal: 'snacks' };
    resetSeam();
    requestLog.length = 0;
    responders.set('barcode', () => ({ status: 402, body: UPGRADE_402 }));
    const screen = (access: PatientAppAccess | null) =>
      withSeam(access, h(AppModeProvider, null, h(PatientProvider, null, h(BarcodeScanScreen))));
    const tree = await create(screen(LOCKED));
    assertEqual('barcode (locked): the sheet opens once on arrival', seamCalls.sheet, 1);
    assert('barcode (locked): the locked card explains and offers the upgrade', present(tree, 'barcode-locked'));
    await tap(tree, 'barcode-locked-upgrade');
    assertEqual('barcode (locked): the card button opens the sheet', seamCalls.sheet, 2);
    await typeText(tree, 'barcode-input', '3017624010701');
    await tap(tree, 'barcode-submit');
    assertEqual('barcode (locked): a typed lookup opens the sheet instead', seamCalls.sheet, 3);
    assertEqual('barcode (locked): nothing reaches the server', requestLog.length, 0);
    assert('barcode (locked): no error box', !present(tree, 'barcode-error'));

    // Stale state: unlocked locally, but the server answers 402.
    await actSettle(() => tree.update(screen(SUBSCRIBED)));
    assert('barcode (subscribed): the locked card is gone', !present(tree, 'barcode-locked'));
    await typeText(tree, 'barcode-input', '3017624010701');
    await tap(tree, 'barcode-submit');
    await waitUntil('barcode (stale): the lookup reached the server', () => requestLog.length === 1);
    await waitUntil('barcode (stale): the 402 is reported to the seam with its entitlement', () => seamCalls.reports.length === 1 && seamCalls.reports[0]?.reason === 'locked');
    assert('barcode (stale): no error / retry box for the terminal reply', !present(tree, 'barcode-error') && !present(tree, 'barcode-retry'));
    assert('barcode (stale): the screen is back to its scan state', present(tree, 'barcode-input'));
    tree.unmount();
  }

  // 5e. Menu scan stale-state 402: the kept photo waits, no retry offered.
  {
    routerState.pathname = '/menu-scan';
    resetSeam();
    requestLog.length = 0;
    responders.set('coach/menu-scan', () => ({ status: 402, body: UPGRADE_402 }));
    pickerScript.next = {
      canceled: false,
      assets: [{ uri: 'data:image/jpeg;base64,QUJD', width: 800, height: 600 }],
    };
    const tree = await create(withSeam(SUBSCRIBED, h(AppModeProvider, null, h(MenuScanScreen))));
    await tap(tree, 'menu-scan-choose');
    await waitUntil('menu scan (stale): the picked photo is ready to scan', () => present(tree, 'menu-scan-start'));
    await tap(tree, 'menu-scan-start');
    await waitUntil('menu scan (stale): the scan reached the server', () => requestLog.some(r => r.path === 'coach/menu-scan'));
    await waitUntil('menu scan (stale): the 402 is reported to the seam', () => seamCalls.reports.length === 1 && seamCalls.reports[0]?.price_cents === 499);
    assert('menu scan (stale): no error / retry box', !present(tree, 'menu-scan-error') && !present(tree, 'menu-scan-retry'));
    assert('menu scan (stale): the photo is kept for after the upgrade', present(tree, 'menu-scan-start'));
    tree.unmount();
  }

  finish();
}

main().catch(error => {
  console.error(error);
  fail(`suite crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  finish();
});
