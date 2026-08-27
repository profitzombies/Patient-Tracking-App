/**
 * Barcode multi-scan regression check (no network, no AI credits).
 *
 * Renders the REAL barcode-scan screen under Node (react-test-renderer via
 * tsconfig.barcode-scan.json stubs) with the real AppModeContext +
 * PatientContext and the real lib/barcode-food client, against a scripted
 * /api/barcode/:code transport. Pins the multi-scan session contract:
 *
 *   1. Canonicalization: typed/scanned UPC-A, EAN-13, and UPC-E forms of
 *      the same product all collapse to one canonical code client-side.
 *   2. Session list: every successful lookup APPENDS a row (name, brand,
 *      per-serving facts, serving stepper) and scanning stays live between
 *      finds; manual entry feeds the SAME list; the empty state shows no
 *      list card and no confirm button.
 *   3. Dedupe: a code that canonicalizes to a listed row is refused
 *      WITHOUT a network call; a different code the SERVER unifies to a
 *      listed product (canonical `food.code` match) is refused after the
 *      lookup — both show the brief announced "already on your list"
 *      notice and never a second row.
 *   4. One confirm logs all: nothing reaches the diary or My Foods before
 *      the single primary action; confirming saves each listed food
 *      per-serving to My Foods and logs quantity × per-serving to the
 *      bound meal/date with the label flow's exact entry shape (detail,
 *      rounding, refId linkage that existing undo/edit paths key on).
 *      Misses, failures, and cancels never disturb the list.
 *   5. Torch: the scanner's flash button lights CameraView.enableTorch the
 *      moment it's pressed, announces Flash on/off, stays lit across scan
 *      cycles, resets when the list is logged, and is absent on web and on
 *      the no-camera fallback.
 *   6. Gates: the patient-only redirect still guards the route; a denied
 *      camera keeps the typed path (and the list) fully working.
 *   7. Casing: a found product NAME renders in the app's Title Case
 *      everywhere the session shows it (row, added/duplicate notices,
 *      stepper voice-over labels) and in what the confirm saves — with
 *      brand-style inner caps kept and connector words small — while the
 *      BRAND line stays exactly as the source spells it.
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:barcode-scan
 */
import React, { act } from 'react';

import { Platform } from 'react-native';
import { announcements } from './onboarding-gate-stubs/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { cameraState, resetCameraStub } from './meal-photo-stubs/expo-camera';
import {
  clearRedirects,
  clearRouterCalls,
  redirects,
  routerCalls,
  routerState,
} from './barcode-scan-stubs/expo-router';
import { AppModeProvider } from '../context/AppModeContext';
import { PatientProvider, usePatient } from '../context/PatientContext';
import BarcodeScanScreen from '../app/barcode-scan';
import {
  normalizeScannedBarcode,
  normalizeTypedBarcode,
} from '../lib/barcode-food';
import { TODAY_KEY } from '../data/patient-data';

// ── Harness ─────────────────────────────────────────────────────────────────

let checks = 0;
let failures = 0;

function fail(message: string): void {
  failures += 1;
  console.error(`FAIL - ${message}`);
}

function assert(label: string, condition: boolean): void {
  checks += 1;
  if (condition) console.log(`ok - ${label}`);
  else fail(label);
}

function assertEqual(label: string, actual: string | number, expected: string | number): void {
  checks += 1;
  if (Object.is(actual, expected)) console.log(`ok - ${label}`);
  else fail(`${label}\n    actual:   ${JSON.stringify(actual)}\n    expected: ${JSON.stringify(expected)}`);
}

function finish(): never {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function settle(): Promise<void> {
  await sleep(0);
  await sleep(0);
}

async function actSettle(mutate?: () => void): Promise<void> {
  await act(async () => {
    mutate?.();
    await settle();
  });
}

async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<void> {
  checks += 1;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      fail(`${label}: condition not met within ${timeoutMs}ms`);
      finish();
    }
    await act(async () => {
      await sleep(8);
    });
  }
}

// ── RTR query helpers ───────────────────────────────────────────────────────

type HostNode = { type: unknown; props: Record<string, unknown> };
type Rendered = {
  root: { findAll(predicate: (node: HostNode) => boolean): HostNode[] };
  toJSON(): unknown;
  unmount(): void;
};

// Host elements only — a composite keeps testID in its own props and would
// shadow the Pressable that actually carries onPress/disabled.
const byTestID = (tree: Rendered, testID: string): HostNode | null =>
  tree.root.findAll(
    node => typeof node.type === 'string' && node.props?.testID === testID,
  )[0] ?? null;
const present = (tree: Rendered, testID: string): boolean => byTestID(tree, testID) !== null;

async function tap(tree: Rendered, testID: string): Promise<void> {
  const node = byTestID(tree, testID);
  if (!node) {
    fail(`tap: no node with testID "${testID}"`);
    finish();
  }
  if (node.props.disabled === true) return; // a disabled Pressable swallows taps
  const onPress = node.props.onPress as (() => unknown) | undefined;
  await actSettle(() => {
    void onPress?.();
  });
}

/** Types into a TextInput through its onChangeText, like a keyboard would. */
async function typeText(tree: Rendered, testID: string, value: string): Promise<void> {
  const node = byTestID(tree, testID);
  if (!node) {
    fail(`typeText: no node with testID "${testID}"`);
    finish();
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
const screenText = (tree: Rendered) => treeText(tree.toJSON());

/** Session-list rows only (`barcode-item-<code>`, not the stepper controls). */
const listRowCount = (tree: Rendered): number =>
  tree.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props?.testID === 'string' &&
      /^barcode-item-[0-9]+$/.test(node.props.testID as string),
  ).length;

const cameraNode = (tree: Rendered): HostNode | null =>
  tree.root.findAll(node => node.type === 'CameraView')[0] ?? null;

/** Fires the camera's barcode callback the way a live detection would. */
async function scanCode(tree: Rendered, data: string, type: string): Promise<void> {
  const camera = cameraNode(tree);
  if (!camera) {
    fail(`scanCode: no CameraView mounted for "${data}"`);
    finish();
  }
  const handler = camera.props.onBarcodeScanned as
    | ((event: { data: string; type: string }) => void)
    | undefined;
  await actSettle(() => {
    handler?.({ data, type });
  });
}

// ── Scripted /api/barcode/:code transport ───────────────────────────────────

interface Scripted {
  status: number;
  body: unknown;
}
type Responder = () => Scripted | Promise<Scripted>;

const responders = new Map<string, Responder>();
/** Every code the client actually asked the server about, in order. */
const lookupLog: string[] = [];

const DEFAULT_MISS =
  'We could not find that barcode. Check the number, or scan the Nutrition Facts label instead.';

function scriptFound(code: string, food: Record<string, unknown>): void {
  responders.set(code, () => ({
    status: 200,
    body: { result: 'found', source: 'table', food },
  }));
}

const scriptedFetch = (async (input: unknown) => {
  const url = String(
    typeof input === 'object' && input !== null && 'url' in (input as object)
      ? (input as { url: unknown }).url
      : input,
  );
  const match = url.match(/\/api\/barcode\/([0-9]+)$/);
  if (!match) throw new Error(`unexpected fetch: ${url}`);
  lookupLog.push(match[1]);
  const responder = responders.get(match[1]);
  const scripted = responder
    ? await responder()
    : { status: 200, body: { result: 'not_found', message: DEFAULT_MISS } };
  return new Response(JSON.stringify(scripted.body), {
    status: scripted.status,
    headers: { 'Content-Type': 'application/json' },
  });
}) as unknown as typeof fetch;

// ── Fixtures ────────────────────────────────────────────────────────────────

// EAN-13 with no UPC twin.
const NUTELLA = {
  code: '3017624010701',
  name: 'Nutella',
  brand: 'Ferrero',
  serving: '15 g',
  calories: 80.7,
  protein: 0.9,
  carbs: 8.6,
  fat: 4.7,
};
// Sold under a UPC-A; canonical form carries the GTIN-13 leading zero, so
// typing either '012000161155' or '0012000161155' means THIS product.
const COLA = {
  code: '0012000161155',
  name: 'Fizzy Cola',
  brand: 'Big Fizz',
  serving: '355 ml',
  calories: 140,
  protein: 0,
  carbs: 39,
  fat: 0,
};
const CHOCO = {
  code: '0012345678905',
  name: 'Choco Bar',
  brand: 'Sweetworks',
  serving: '1 bar (40g)',
  calories: 210.4,
  protein: 2.6,
  carbs: 24.2,
  fat: 11.8,
};
// A DIFFERENT code family the SERVER unifies to CHOCO's canonical row —
// the client cannot know these match until the lookup answers.
const CHOCO_ALIAS_CODE = '5000159407236';
const TRAIL = {
  code: '4000000000019',
  name: 'Trail Mix',
  serving: '30 g',
  calories: 160,
  protein: 5,
  carbs: 13,
  fat: 10,
};
// Source-cased fixtures: the lookup seam Title Cases the NAME for display
// and saves, while the BRAND stays exactly as the source spells it.
const SWEETTARTS = {
  code: '0079200674033',
  name: 'mini Chewy mixed fruit',
  brand: 'SweetTARTS',
  serving: '32 pieces (33g)',
  calories: 130,
  protein: 0,
  carbs: 30,
  fat: 1,
};
const OATMEAL = {
  code: '0072463000019',
  name: "McCann's quick and easy steel cut oatmeal",
  brand: "McCann's",
  serving: '40 g',
  calories: 150,
  protein: 4,
  carbs: 27,
  fat: 2.5,
};
const CANCEL_CODE = '5449000000996';
const MISS_CODE = '9990000000000';

const FIXTURE_NAMES = new Set(['Nutella', 'Fizzy Cola', 'Choco Bar', 'Trail Mix']);

const MODE_KEY = 'thinnr_app_mode_v1';

// ── Providers around the real screen ────────────────────────────────────────

const patientRef: { current: ReturnType<typeof usePatient> | null } = { current: null };
function PatientProbe(): null {
  patientRef.current = usePatient();
  return null;
}
const patient = () => {
  if (!patientRef.current) {
    fail('patient probe never rendered');
    finish();
  }
  return patientRef.current;
};

async function main() {
  process.env.EXPO_PUBLIC_DOMAIN = 'barcode-scan.internal';
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = scriptedFetch;

  // On the 'web' platform path AppModeContext and PatientContext persist
  // through localStorage — give Node one.
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
    default?: { create: (el: React.ReactElement) => { unmount(): void } };
    create?: (el: React.ReactElement) => { unmount(): void };
  };
  const TestRenderer = rendererModule.default ?? rendererModule;
  if (!TestRenderer.create) throw new Error('react-test-renderer did not expose create()');

  const renderScreen = async (): Promise<Rendered> => {
    let tree!: Rendered;
    await act(async () => {
      tree = TestRenderer.create!(
        React.createElement(
          AppModeProvider,
          null,
          React.createElement(
            PatientProvider,
            null,
            React.createElement(PatientProbe),
            React.createElement(BarcodeScanScreen),
          ),
        ),
      ) as unknown as Rendered;
      await settle();
    });
    return tree;
  };

  const seedPatientMode = async (): Promise<void> => {
    globalThis.localStorage.setItem(MODE_KEY, 'patient');
    await AsyncStorage.setItem(MODE_KEY, 'patient');
  };

  scriptFound(NUTELLA.code, NUTELLA);
  scriptFound(COLA.code, COLA);
  scriptFound(CHOCO.code, CHOCO);
  scriptFound(SWEETTARTS.code, SWEETTARTS);
  scriptFound(OATMEAL.code, OATMEAL);
  responders.set(CHOCO_ALIAS_CODE, () => ({
    status: 200,
    body: { result: 'found', source: 'table', food: CHOCO },
  }));

  // ── 1. Canonicalization: every form of a product is ONE code ─────────────
  {
    assertEqual(
      'a typed UPC-A gains its GTIN-13 leading zero',
      normalizeTypedBarcode('012000161155') ?? '',
      '0012000161155',
    );
    assertEqual(
      'the typed EAN-13 form of the same product matches it',
      normalizeTypedBarcode('0012000161155') ?? '',
      '0012000161155',
    );
    assertEqual(
      'a scanned upc_a canonicalizes identically',
      normalizeScannedBarcode('012000161155', 'upc_a') ?? '',
      '0012000161155',
    );
    const typedUpcE = normalizeTypedBarcode('123456');
    assert('a 6-digit typed code expands as UPC-E', typedUpcE !== null);
    assertEqual(
      'the scanned upc_e form expands to the SAME canonical code',
      normalizeScannedBarcode('123456', 'upc_e') ?? '',
      typedUpcE ?? '',
    );
  }

  // ── 2. Web manual session: list, dedupe, one confirm logs all ────────────
  Platform.OS = 'web';
  routerState.pathname = '/barcode-scan';
  routerState.params = { date: TODAY_KEY, meal: 'lunch' };
  await seedPatientMode();
  {
    const tree = await renderScreen();
    await waitUntil('the screen renders the manual entry path', () => present(tree, 'barcode-input'));

    assert('web never mounts the camera shell', !present(tree, 'barcode-camera'));
    assert('web hides the torch button entirely', !present(tree, 'barcode-torch'));
    assert('an empty session shows no list card', !present(tree, 'barcode-list'));
    assert('an empty session shows no confirm action', !present(tree, 'barcode-add-all'));

    const foodsBefore = patient().customFoods.length;
    const lunchFixtureEntries = () =>
      patient()
        .entriesForDate(TODAY_KEY)
        .filter(entry => entry.meal === 'lunch' && FIXTURE_NAMES.has(entry.name));

    // Garbage input: announced validation, no request.
    await typeText(tree, 'barcode-input', '123');
    await tap(tree, 'barcode-submit');
    assert('a too-short number shows the announced input error', present(tree, 'barcode-input-error'));
    assertEqual('a rejected input never reaches the server', lookupLog.length, 0);

    // First find appends a row and keeps the input ready for the next code.
    await typeText(tree, 'barcode-input', NUTELLA.code);
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'a found product lands on the session list',
      () => present(tree, `barcode-item-${NUTELLA.code}`),
    );
    assert('the append shows the announced added notice', present(tree, 'barcode-notice-added'));
    assert(
      'the added notice names the product',
      screenText(tree).includes('Nutella is on your list.'),
    );
    assertEqual(
      'the input clears for the next code',
      String(byTestID(tree, 'barcode-input')?.props.value),
      '',
    );
    assertEqual(
      'a single-item list reads naturally',
      String(byTestID(tree, 'barcode-add-all')?.props.accessibilityLabel),
      'Add 1 food to Lunch',
    );
    assert(
      'the row carries the per-serving facts line',
      screenText(tree).includes('Per 15 g · 81 cal · P 0.9g · C 8.6g · F 4.7g'),
    );

    // Second product typed as its RAW UPC-A — the row keys on the canonical code.
    await typeText(tree, 'barcode-input', '012000161155');
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'the UPC-A entry lands under its canonical GTIN-13 row',
      () => present(tree, `barcode-item-${COLA.code}`),
    );
    assertEqual(
      'two items pluralize the confirm action',
      String(byTestID(tree, 'barcode-add-all')?.props.accessibilityLabel),
      'Add 2 foods to Lunch',
    );

    // Exact repeat: refused before any network call.
    const lookupsBeforeRepeat = lookupLog.length;
    await typeText(tree, 'barcode-input', NUTELLA.code);
    await tap(tree, 'barcode-submit');
    assert('an exact repeat shows the announced duplicate notice', present(tree, 'barcode-notice-duplicate'));
    assert(
      'the duplicate notice names the listed product',
      screenText(tree).includes('Nutella is already on your list.'),
    );
    assertEqual('the repeat never re-queries the server', lookupLog.length, lookupsBeforeRepeat);
    assertEqual('the repeat adds no second row', listRowCount(tree), 2);

    // Same product in its OTHER code form: still one product, still no request.
    await typeText(tree, 'barcode-input', '0012000161155');
    await tap(tree, 'barcode-submit');
    assert(
      'the EAN-13 form of a listed UPC product is refused as a duplicate',
      screenText(tree).includes('Fizzy Cola is already on your list.'),
    );
    assertEqual('the variant form needs no server round trip', lookupLog.length, lookupsBeforeRepeat);
    assertEqual('the variant form adds no row', listRowCount(tree), 2);

    // A code only the SERVER can unify: dedupe keys on the returned food.code.
    await typeText(tree, 'barcode-input', CHOCO.code);
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'the third product lands on the list',
      () => present(tree, `barcode-item-${CHOCO.code}`),
    );
    const lookupsBeforeAlias = lookupLog.length;
    await typeText(tree, 'barcode-input', CHOCO_ALIAS_CODE);
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'the server-unified alias is refused as a duplicate',
      () => screenText(tree).includes('Choco Bar is already on your list.'),
    );
    assertEqual('the alias DID require the lookup to answer', lookupLog.length, lookupsBeforeAlias + 1);
    assertEqual('the alias adds no row', listRowCount(tree), 3);

    // Steppers stay per-row.
    await tap(tree, `barcode-item-plus-${NUTELLA.code}`);
    assertEqual(
      'the plus stepper bumps THAT row by a half serving',
      treeText(byTestID(tree, `barcode-item-qty-${NUTELLA.code}`)?.props.children ?? null) ||
        String(byTestID(tree, `barcode-item-qty-${NUTELLA.code}`)?.props.children),
      '1.5',
    );
    await tap(tree, `barcode-item-minus-${COLA.code}`);
    assertEqual(
      'the minus stepper drops to the half-serving floor',
      String(byTestID(tree, `barcode-item-qty-${COLA.code}`)?.props.children),
      '0.5',
    );
    await tap(tree, `barcode-item-minus-${COLA.code}`);
    assertEqual(
      'the floor holds at half a serving',
      String(byTestID(tree, `barcode-item-qty-${COLA.code}`)?.props.children),
      '0.5',
    );

    // A miss keeps the session intact.
    await typeText(tree, 'barcode-input', MISS_CODE);
    await tap(tree, 'barcode-submit');
    await waitUntil('an unknown code shows the honest miss card', () => present(tree, 'barcode-miss'));
    assertEqual('the miss disturbs no listed rows', listRowCount(tree), 3);
    await tap(tree, 'barcode-try-again');
    assert('dismissing the miss returns to scanning', !present(tree, 'barcode-miss'));
    assertEqual('the list survives the miss round trip', listRowCount(tree), 3);

    // A transport failure keeps the session intact, and the retry appends.
    responders.set(TRAIL.code, () => ({ status: 502, body: { error: 'The lookup hiccuped. Try again.' } }));
    await typeText(tree, 'barcode-input', TRAIL.code);
    await tap(tree, 'barcode-submit');
    await waitUntil('a failed lookup shows the announced error card', () => present(tree, 'barcode-failed'));
    assert('the failure surfaces the server message', screenText(tree).includes('The lookup hiccuped. Try again.'));
    assertEqual('the failure disturbs no listed rows', listRowCount(tree), 3);
    scriptFound(TRAIL.code, TRAIL);
    await tap(tree, 'barcode-retry');
    await waitUntil(
      'the retry appends the recovered product',
      () => present(tree, `barcode-item-${TRAIL.code}`),
    );
    assertEqual('the retry re-asked for the SAME code', lookupLog[lookupLog.length - 1] ?? '', TRAIL.code);

    // Cancelling a pending lookup never ghost-appends later.
    let releaseCancelled!: () => void;
    responders.set(CANCEL_CODE, () =>
      new Promise<Scripted>(resolve => {
        releaseCancelled = () =>
          resolve({
            status: 200,
            body: {
              result: 'found',
              source: 'table',
              food: { code: CANCEL_CODE, name: 'Ghost Soda', serving: '250 ml', calories: 90, protein: 0, carbs: 22, fat: 0 },
            },
          });
      }),
    );
    await typeText(tree, 'barcode-input', CANCEL_CODE);
    await tap(tree, 'barcode-submit');
    await waitUntil('a pending lookup shows the checking card', () => present(tree, 'barcode-looking'));
    await tap(tree, 'barcode-lookup-cancel');
    assert('cancel returns to scanning', !present(tree, 'barcode-looking'));
    await actSettle(() => releaseCancelled());
    assert('a cancelled lookup never appends late', !present(tree, `barcode-item-${CANCEL_CODE}`));
    assertEqual('the list still holds exactly the found items', listRowCount(tree), 4);

    // NOTHING has been logged or saved yet.
    assertEqual('no custom food exists before the confirm', patient().customFoods.length, foodsBefore);
    assertEqual('no diary entry exists before the confirm', lunchFixtureEntries().length, 0);

    // ONE confirm logs the whole list.
    await tap(tree, 'barcode-add-all');
    await waitUntil('the confirm lands the logged state', () => present(tree, 'barcode-added'));
    assert(
      'the logged state reads the full outcome',
      screenText(tree).includes('Added 4 foods to Lunch · saved to My Foods'),
    );
    assertEqual('every listed food joined My Foods', patient().customFoods.length, foodsBefore + 4);
    const entries = lunchFixtureEntries();
    assertEqual('every listed food landed one diary entry', entries.length, 4);

    const nutellaFood = patient().customFoods.find(food => food.name === 'Nutella');
    const nutellaEntry = entries.find(entry => entry.name === 'Nutella');
    assert('the saved food stays per-serving (rounded)', nutellaFood?.calories === 81);
    assertEqual('the entry multiplies the stepped quantity', nutellaEntry?.quantity ?? 0, 1.5);
    assertEqual('the entry calories are quantity × per-serving', nutellaEntry?.calories ?? 0, 122);
    assertEqual('the entry detail carries the label-flow shape', nutellaEntry?.detail ?? '', '1.5 × 15 g');
    assertEqual(
      'the entry links to its saved food (the undo/edit contract)',
      nutellaEntry?.refId ?? '',
      nutellaFood?.id ?? 'missing-food',
    );
    const colaEntry = entries.find(entry => entry.name === 'Fizzy Cola');
    assertEqual('the half-serving row logs half the calories', colaEntry?.calories ?? 0, 70);

    assert('the confirm action leaves once logged', !present(tree, 'barcode-add-all'));
    assert('Done rides the logged state', present(tree, 'barcode-done'));
    assertEqual(
      'the input pauses while the logged summary is up',
      String(byTestID(tree, 'barcode-input')?.props.editable),
      'false',
    );
    assertEqual(
      'the steppers freeze once logged',
      String(byTestID(tree, `barcode-item-plus-${NUTELLA.code}`)?.props.disabled),
      'true',
    );

    // Scan more starts a FRESH list; the logged foods stay logged.
    await tap(tree, 'barcode-scan-more');
    assert('scan-more clears the session list', !present(tree, 'barcode-list'));
    assertEqual('scan-more keeps the logged entries', lunchFixtureEntries().length, 4);
    assertEqual(
      'the input reopens for the next session',
      String(byTestID(tree, 'barcode-input')?.props.editable),
      'true',
    );

    tree.unmount();
  }

  // ── 2b. Presentation casing: source-cased names render Title Case ────────
  // The lookup is the ONE normalization seam: the list row, the notices,
  // the stepper voice-over labels, and the eventual saves all inherit the
  // Title Case name from it, while the brand line stays source-verbatim.
  routerState.params = { date: TODAY_KEY, meal: 'breakfast' };
  {
    const tree = await renderScreen();
    await waitUntil('the casing session renders', () => present(tree, 'barcode-input'));

    await typeText(tree, 'barcode-input', SWEETTARTS.code);
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'the source-cased product lands on the list',
      () => present(tree, `barcode-item-${SWEETTARTS.code}`),
    );
    const text = screenText(tree);
    assert('the scan list shows the Title Case name', text.includes('Mini Chewy Mixed Fruit'));
    assert('the source casing never renders', !text.includes('mini Chewy mixed fruit'));
    assert('the brand line stays exactly as the source spells it', text.includes('SweetTARTS'));
    assert(
      'the added notice carries the Title Case name',
      text.includes('Mini Chewy Mixed Fruit is on your list.'),
    );
    assertEqual(
      'the plus stepper voice-over speaks the Title Case name',
      String(byTestID(tree, `barcode-item-plus-${SWEETTARTS.code}`)?.props.accessibilityLabel),
      'More servings of Mini Chewy Mixed Fruit',
    );
    assertEqual(
      'the minus stepper voice-over matches',
      String(byTestID(tree, `barcode-item-minus-${SWEETTARTS.code}`)?.props.accessibilityLabel),
      'Fewer servings of Mini Chewy Mixed Fruit',
    );
    assertEqual(
      'the quantity voice-over matches',
      String(byTestID(tree, `barcode-item-qty-${SWEETTARTS.code}`)?.props.accessibilityLabel),
      '1 serving of Mini Chewy Mixed Fruit',
    );

    // The duplicate notice inherits the same cased name.
    await typeText(tree, 'barcode-input', SWEETTARTS.code);
    await tap(tree, 'barcode-submit');
    assert(
      'the duplicate notice carries the Title Case name',
      screenText(tree).includes('Mini Chewy Mixed Fruit is already on your list.'),
    );

    // Brand-style inner caps and connector words INSIDE a name survive.
    await typeText(tree, 'barcode-input', OATMEAL.code);
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'the inner-caps product lands on the list',
      () => present(tree, `barcode-item-${OATMEAL.code}`),
    );
    assert(
      'inner-cap spellings keep their capitals and connectors stay small',
      screenText(tree).includes("McCann's Quick and Easy Steel Cut Oatmeal"),
    );

    // The confirm saves and logs the SAME cased names the list showed.
    await tap(tree, 'barcode-add-all');
    await waitUntil('the casing session logs', () => present(tree, 'barcode-added'));
    const savedSweet = patient().customFoods.find(food => food.name === 'Mini Chewy Mixed Fruit');
    assert('My Foods keeps the Title Case name', savedSweet !== undefined);
    assertEqual('the saved brand stays verbatim', savedSweet?.brand ?? '', 'SweetTARTS');
    assert(
      'My Foods keeps the inner-cap name too',
      patient().customFoods.some(food => food.name === "McCann's Quick and Easy Steel Cut Oatmeal"),
    );
    const breakfastNames = patient()
      .entriesForDate(TODAY_KEY)
      .filter(entry => entry.meal === 'breakfast')
      .map(entry => entry.name);
    assert(
      'the diary entry matches what the scan screen showed',
      breakfastNames.includes('Mini Chewy Mixed Fruit'),
    );

    tree.unmount();
  }

  // ── 3. Native scanner: live camera, torch, camera-fed dedupe ─────────────
  Platform.OS = 'ios';
  routerState.params = { date: TODAY_KEY, meal: 'dinner' };
  resetCameraStub();
  clearRouterCalls();
  {
    const tree = await renderScreen();
    await waitUntil('the granted camera mounts the viewfinder', () => present(tree, 'barcode-camera'));
    assertEqual('an already-granted camera is never re-asked', cameraState.requestCount, 0);

    // Torch: immediate, announced, persistent.
    assert('the torch button rides the live camera', present(tree, 'barcode-torch'));
    assertEqual('the torch starts off', String(cameraNode(tree)?.props.enableTorch), 'false');
    assertEqual(
      'the torch label offers the ON action first',
      String(byTestID(tree, 'barcode-torch')?.props.accessibilityLabel),
      'Turn on the flash',
    );
    announcements.length = 0;
    await tap(tree, 'barcode-torch');
    assertEqual('pressing lights the torch immediately', String(cameraNode(tree)?.props.enableTorch), 'true');
    assert('the torch flip is announced', announcements.includes('Flash on'));
    assertEqual(
      'the lit torch label offers the OFF action',
      String(byTestID(tree, 'barcode-torch')?.props.accessibilityLabel),
      'Turn off the flash',
    );

    const dinnerFixtureEntries = () =>
      patient()
        .entriesForDate(TODAY_KEY)
        .filter(entry => entry.meal === 'dinner' && FIXTURE_NAMES.has(entry.name));

    // A live detection appends and scanning stays live.
    await scanCode(tree, NUTELLA.code, 'ean13');
    await waitUntil(
      'a live scan drops the product onto the list',
      () => present(tree, `barcode-item-${NUTELLA.code}`),
    );
    assert(
      'the append is announced on iOS',
      announcements.some(message => message.includes('Nutella is on your list.')),
    );
    assert(
      'scanning stays live after a find',
      typeof cameraNode(tree)?.props.onBarcodeScanned === 'function',
    );
    assertEqual('the torch stays lit across the scan cycle', String(cameraNode(tree)?.props.enableTorch), 'true');

    // Raw UPC-A detection lands under the canonical row.
    await scanCode(tree, '012000161155', 'upc_a');
    await waitUntil(
      'a raw UPC-A scan lands under its canonical row',
      () => present(tree, `barcode-item-${COLA.code}`),
    );

    // Re-scanning an EARLIER product (outside the repeat gate) is refused.
    announcements.length = 0;
    const lookupsBeforeDupe = lookupLog.length;
    await scanCode(tree, NUTELLA.code, 'ean13');
    assert(
      'a re-scanned listed product announces the duplicate',
      announcements.some(message => message.includes('Nutella is already on your list.')),
    );
    assertEqual('the camera duplicate needs no server round trip', lookupLog.length, lookupsBeforeDupe);
    assertEqual('the camera duplicate adds no row', listRowCount(tree), 2);

    // While a lookup is pending, detections pause.
    let releaseChoco!: () => void;
    responders.set(CHOCO.code, () =>
      new Promise<Scripted>(resolve => {
        releaseChoco = () =>
          resolve({ status: 200, body: { result: 'found', source: 'table', food: CHOCO } });
      }),
    );
    await scanCode(tree, CHOCO.code, 'ean13');
    await waitUntil('the pending lookup shows the checking card', () => present(tree, 'barcode-looking'));
    assert(
      'detections pause while a lookup is in flight',
      cameraNode(tree)?.props.onBarcodeScanned === undefined,
    );
    await actSettle(() => releaseChoco());
    await waitUntil(
      'the released lookup appends its product',
      () => present(tree, `barcode-item-${CHOCO.code}`),
    );

    // ONE confirm: logs everything, resets the torch, announces, pauses scanning.
    announcements.length = 0;
    await tap(tree, 'barcode-add-all');
    await waitUntil('the native confirm lands the logged state', () => present(tree, 'barcode-added'));
    assertEqual('logging the list logs every row', dinnerFixtureEntries().length, 3);
    assertEqual('adding the foods turns the torch off', String(cameraNode(tree)?.props.enableTorch), 'false');
    assert(
      'the logged outcome is announced on iOS',
      announcements.some(message => message.includes('Added 3 foods to Dinner and saved to My Foods.')),
    );
    assert(
      'scanning pauses once the list is logged',
      cameraNode(tree)?.props.onBarcodeScanned === undefined,
    );

    clearRouterCalls();
    await tap(tree, 'barcode-done');
    assertEqual(
      'Done leaves the scanner',
      routerCalls.map(call => call.method).join(','),
      'back',
    );

    tree.unmount();
  }

  // ── 4. The patient-only gate still guards the route ───────────────────────
  {
    globalThis.localStorage.removeItem(MODE_KEY);
    await AsyncStorage.removeItem(MODE_KEY);
    clearRedirects();
    const tree = await renderScreen();
    await waitUntil('an unchosen persona redirects away', () => redirects.includes('/persona'));
    assert('no scanner UI leaks past the gate', !present(tree, 'barcode-input'));
    tree.unmount();
  }

  // ── 5. Denied camera: typed path (and the list) still work, no torch ─────
  {
    await seedPatientMode();
    resetCameraStub();
    cameraState.permission = { granted: false, canAskAgain: false, status: 'denied' };
    const tree = await renderScreen();
    await waitUntil('the denied state shows its explainer card', () => present(tree, 'barcode-camera-denied'));
    assert('a denied camera never mounts the viewfinder', !present(tree, 'barcode-camera'));
    assert('no torch button without a live camera', !present(tree, 'barcode-torch'));
    await typeText(tree, 'barcode-input', NUTELLA.code);
    await tap(tree, 'barcode-submit');
    await waitUntil(
      'manual entry still feeds the session list',
      () => present(tree, `barcode-item-${NUTELLA.code}`),
    );
    tree.unmount();
  }

  finish();
}

main().catch(error => {
  console.error('barcode scan check crashed:', error);
  process.exit(1);
});
