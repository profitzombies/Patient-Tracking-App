/**
 * Create-food "Scan a label" flow check.
 *
 * Renders the REAL CreateFoodScreen (with the real AppMode/Patient
 * providers) under tsx + react-test-renderer (tsconfig.label-scan.json maps
 * native-only modules to Node stubs; the network is a scripted
 * globalThis.fetch) and proves the task's contract end to end:
 *
 *   - Create mode offers the scan; edit mode never does.
 *   - A scanned label prefills serving, calories, protein, carbs, and fat
 *     from the server's validated read — name/brand stay the patient's to
 *     write, and the exact picked photo bytes are what gets uploaded.
 *   - A flagged read (printed calories fighting the macro math) surfaces the
 *     double-check note.
 *   - Unreadable / not-a-label answers show the server's warm re-ask in an
 *     announced notice, leave every field untouched, and keep the photo so
 *     retry re-sends the same image.
 *   - Transport failures and malformed responses become announced errors
 *     with a retry — never silent, never guessed values.
 *   - Prefilled values stay fully editable and saving is the ordinary
 *     addCustomFood path (Title Case name, rounded numbers, router back).
 *
 * Run: pnpm --filter @workspace/thinnr-mobile run test:label-scan
 */
import React, { act } from 'react';

import {
  clearRedirects,
  clearRouterCalls,
  redirects,
  routerCalls,
  setParams,
} from './label-scan-stubs/expo-router';
import { pickerState, type ImagePickerAsset } from './label-scan-stubs/expo-image-picker';

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

function finish(): never {
  if (failures > 0) {
    console.error(`\n✗ create-food label scan: ${failures} failure(s) across ${checks} checks`);
    process.exit(1);
  }
  console.log(`✓ create-food label scan: ${checks} checks passed`);
  process.exit(0);
}

// ─── Renderer plumbing (same conventions as the other RTR suites) ───────────

interface TestInstance {
  type: unknown;
  props: Record<string, unknown>;
  children: Array<TestInstance | string>;
  findAllByProps(props: Record<string, unknown>): TestInstance[];
}

interface Renderer {
  root: TestInstance;
  unmount(): void;
}

let createRenderer: (el: React.ReactElement) => Renderer;

/** Finds the HOST element for a testID (deepest match). */
function hostByTestID(root: TestInstance, testID: string): TestInstance | null {
  const hosts = root.findAllByProps({ testID }).filter(i => typeof i.type === 'string');
  return hosts[hosts.length - 1] ?? null;
}

function present(root: TestInstance, testID: string): boolean {
  return hostByTestID(root, testID) !== null;
}

function pressableByTestID(root: TestInstance, testID: string): TestInstance | null {
  const hosts = root
    .findAllByProps({ testID })
    .filter(i => typeof i.type === 'string' && typeof i.props.onPress === 'function');
  return hosts[hosts.length - 1] ?? null;
}

/**
 * Simulates a tap. The handler's promise is deliberately NOT awaited — the
 * cancel check scripts a fetch that never settles, and awaiting it would
 * silently drain the event loop (Node then exits 0 with no output). Instead
 * a bounded microtask flush lets every settled promise chain (picker → prep
 * → fetch → setState) propagate before assertions run.
 */
async function tap(root: TestInstance, testID: string, label: string): Promise<boolean> {
  const el = pressableByTestID(root, testID);
  if (!el) {
    fail(`${label}: pressable "${testID}" not found`);
    return false;
  }
  if (el.props.disabled === true) {
    fail(`${label}: pressable "${testID}" is disabled`);
    return false;
  }
  await act(async () => {
    void (el.props.onPress as () => unknown)();
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  });
  return true;
}

async function typeText(root: TestInstance, testID: string, value: string, label: string) {
  const inputs = root
    .findAllByProps({ testID })
    .filter(i => typeof i.type === 'string' && typeof i.props.onChangeText === 'function');
  const el = inputs[inputs.length - 1];
  if (!el) {
    fail(`${label}: input "${testID}" not found`);
    return;
  }
  await act(async () => {
    (el.props.onChangeText as (v: string) => void)(value);
  });
}

function inputValue(root: TestInstance, testID: string): string {
  const el = hostByTestID(root, testID);
  return el ? String(el.props.value ?? '') : '<missing>';
}

function textContent(node: TestInstance | string): string {
  if (typeof node === 'string') return node;
  return (node.children ?? []).map(textContent).join('');
}

/** Text inside the host element carrying a testID ('' when absent). */
function textOf(root: TestInstance, testID: string): string {
  const el = hostByTestID(root, testID);
  return el ? textContent(el) : '';
}

// ─── Scripted network ────────────────────────────────────────────────────────

type Scripted =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'reject'; error: Error }
  /** Never settles — holds the scanning phase for cancel checks. */
  | { kind: 'hang' };

const fetchState = {
  script: [] as Scripted[],
  calls: [] as Array<{ url: string; image: string | undefined }>,
};

function installFetchMock() {
  (globalThis as Record<string, unknown>).fetch = async (
    url: unknown,
    init?: { body?: string },
  ) => {
    let image: string | undefined;
    try {
      image = init?.body ? (JSON.parse(init.body) as { image?: string }).image : undefined;
    } catch {
      image = undefined;
    }
    fetchState.calls.push({ url: String(url), image });
    const next = fetchState.script.shift();
    if (!next) throw new Error(`unscripted fetch to ${String(url)}`);
    if (next.kind === 'reject') throw next.error;
    if (next.kind === 'hang') return new Promise<never>(() => {});
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    };
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Picker asset for the web path: blob uri + base64 (as the picker returns). */
const PICKED_ASSET: ImagePickerAsset = {
  uri: 'blob:fake-picker-object',
  base64: 'bGFiZWxQaG90bw==',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 1600,
};
/** What photo-prep turns PICKED_ASSET into — and what must be uploaded. */
const EXPECTED_UPLOAD = 'data:image/jpeg;base64,bGFiZWxQaG90bw==';

const OK_BODY = {
  result: 'ok',
  message: 'Nice, a label I can actually read, sharp shot.',
  label: {
    id: 'label_ok1',
    servingSize: '2/3 cup (55g)',
    servingsPerContainer: 8,
    calories: 230,
    protein: 8,
    carbs: 37,
    fat: 8,
    fiber: 4,
    sugar: 12,
    sodium: 160,
    suggestedSlot: 'snacks',
  },
};

const FLAGGED_BODY = {
  result: 'ok',
  message: 'Got the panel, this one reads like a light snack.',
  label: {
    id: 'label_flag1',
    servingSize: '1 pouch (20g)',
    calories: 400,
    protein: 2,
    carbs: 5,
    fat: 1.5,
    suggestedSlot: 'snacks',
    flagged: true,
  },
};

const UNREADABLE_MESSAGE =
  'It does look like a nutrition label, but the macro rows are too blurry for me to read with confidence.\n\n' +
  'Whenever you are ready, snap the Nutrition Facts panel one more time, straight on and filling the frame, and I will read it fresh.';

const UNREADABLE_BODY = { result: 'unreadable', message: UNREADABLE_MESSAGE };

// ─── Render helper ───────────────────────────────────────────────────────────

type Deps = {
  CreateFoodScreen: React.ComponentType;
  AppModeProvider: React.ComponentType<{ children?: React.ReactNode }>;
  PatientProvider: React.ComponentType<{ children?: React.ReactNode }>;
  usePatient: () => {
    hydrated: boolean;
    customFoods: Array<{
      id: string;
      name: string;
      brand?: string;
      serving: string;
      calories: number;
      protein: number;
      carbs: number;
      fat: number;
    }>;
  };
};

let deps!: Deps;

async function renderCreateFood(params: Record<string, string> = {}) {
  setParams(params);
  clearRouterCalls();
  clearRedirects();
  let patientApi: ReturnType<Deps['usePatient']> | null = null;
  function Probe(): null {
    patientApi = deps.usePatient();
    return null;
  }
  let renderer!: Renderer;
  await act(async () => {
    renderer = createRenderer(
      React.createElement(
        deps.AppModeProvider,
        null,
        React.createElement(
          deps.PatientProvider,
          null,
          React.createElement(Probe),
          React.createElement(deps.CreateFoodScreen),
        ),
      ),
    );
  });
  // Providers hydrate async (mode from localStorage, patient from storage).
  await act(async () => {});
  return { renderer, patient: () => patientApi! };
}

/** Picks a photo (web library path) and lands in the preview phase. */
async function pickPhoto(root: TestInstance, label: string) {
  pickerState.library.push({ canceled: false, assets: [PICKED_ASSET] });
  await tap(root, 'createfood-scan-choose', label);
  assert(`${label}: preview offers "Read this label"`, present(root, 'createfood-scan-start'));
}

// ─── Checks ──────────────────────────────────────────────────────────────────

async function checkAffordance() {
  const label = 'affordance';
  const { renderer } = await renderCreateFood();
  const root = renderer.root;

  assert(`${label}: no persona redirect for the patient`, redirects.length === 0);
  assert(`${label}: create mode shows the scan section`, present(root, 'createfood-scan-section'));
  assert(`${label}: web offers the library picker`, present(root, 'createfood-scan-choose'));
  assert(`${label}: web hides the native camera button`, !present(root, 'createfood-scan-take'));
  assert(
    `${label}: the form card is still the screen's body`,
    present(root, 'createfood-name') && present(root, 'createfood-save'),
  );
  act(() => renderer.unmount());
}

async function checkHappyPath() {
  const label = 'happy path';
  const { renderer } = await renderCreateFood();
  const root = renderer.root;

  await pickPhoto(root, label);
  assert(
    `${label}: web picker was asked for base64 (stable data URI input)`,
    (pickerState.libraryLaunchOptions.at(-1) as { base64?: boolean } | undefined)?.base64 === true,
  );

  // Hold the first scan mid-flight: progress + cancel, then cancel back out.
  fetchState.script.push({ kind: 'hang' });
  await tap(root, 'createfood-scan-start', label);
  assert(`${label}: scanning shows progress`, present(root, 'createfood-scan-progress'));
  assert(
    `${label}: progress line is a live region`,
    textOf(root, 'createfood-scan-progress').includes('Reading the label'),
  );
  await tap(root, 'createfood-scan-cancel', label);
  assert(`${label}: cancel returns to the preview`, present(root, 'createfood-scan-start'));
  assert(`${label}: cancelled scan touched nothing`, inputValue(root, 'createfood-calories') === '');

  // Scan for real.
  fetchState.script.push({ kind: 'json', status: 200, body: OK_BODY });
  await tap(root, 'createfood-scan-start', label);

  const call = fetchState.calls.at(-1);
  assert(
    `${label}: POSTs to /coach/label-scan`,
    call !== undefined && call.url.endsWith('/coach/label-scan'),
  );
  assert(`${label}: uploads the exact picked photo bytes`, call?.image === EXPECTED_UPLOAD);

  assert(`${label}: serving prefilled`, inputValue(root, 'createfood-serving') === '2/3 cup (55g)');
  assert(`${label}: calories prefilled`, inputValue(root, 'createfood-calories') === '230');
  assert(`${label}: protein prefilled`, inputValue(root, 'createfood-protein') === '8');
  assert(`${label}: carbs prefilled`, inputValue(root, 'createfood-carbs') === '37');
  assert(`${label}: fat prefilled`, inputValue(root, 'createfood-fat') === '8');
  assert(`${label}: name stays the patient's to write`, inputValue(root, 'createfood-name') === '');
  assert(`${label}: brand untouched`, inputValue(root, 'createfood-brand') === '');

  const section = textOf(root, 'createfood-scan-section');
  assert(`${label}: done card shows LABEL READ`, section.includes('LABEL READ'));
  assert(`${label}: done card carries the coach reaction`, section.includes(OK_BODY.message));
  assert(
    `${label}: done card reminds that values stay editable`,
    section.includes('Every value below is editable'),
  );
  assert(`${label}: no double-check note without a flag`, !present(root, 'createfood-scan-flagged'));
  assert(`${label}: offers scanning a different label`, present(root, 'createfood-scan-restart'));

  act(() => renderer.unmount());
}

async function checkFlagged() {
  const label = 'flagged label';
  const { renderer } = await renderCreateFood();
  const root = renderer.root;

  await pickPhoto(root, label);
  fetchState.script.push({ kind: 'json', status: 200, body: FLAGGED_BODY });
  await tap(root, 'createfood-scan-start', label);

  assert(`${label}: values still prefill`, inputValue(root, 'createfood-calories') === '400');
  assert(`${label}: decimal macros survive`, inputValue(root, 'createfood-fat') === '1.5');
  const note = hostByTestID(root, 'createfood-scan-flagged');
  assert(`${label}: double-check note shown`, note !== null);
  assert(
    `${label}: note is announced (alert role)`,
    note !== null && note.props.accessibilityRole === 'alert',
  );
  assert(
    `${label}: note wording matches the chat card`,
    textOf(root, 'createfood-scan-flagged').includes(
      'The printed calories and macros disagree on this label.',
    ),
  );
  act(() => renderer.unmount());
}

async function checkUnreadable() {
  const label = 'unreadable label';
  const { renderer } = await renderCreateFood();
  const root = renderer.root;

  await pickPhoto(root, label);
  fetchState.script.push({ kind: 'json', status: 200, body: UNREADABLE_BODY });
  await tap(root, 'createfood-scan-start', label);

  const notice = hostByTestID(root, 'createfood-scan-notice');
  assert(`${label}: warm notice shown`, notice !== null);
  assert(
    `${label}: notice is announced (alert role + live region)`,
    notice !== null &&
      notice.props.accessibilityRole === 'alert' &&
      notice.props.accessibilityLiveRegion === 'polite',
  );
  const noticeText = textOf(root, 'createfood-scan-notice');
  assert(
    `${label}: notice carries the server's words verbatim`,
    noticeText.includes('too blurry') && noticeText.includes('snap the Nutrition Facts panel'),
  );

  // Nothing guessed, nothing touched.
  for (const field of ['serving', 'calories', 'protein', 'carbs', 'fat', 'name'] as const) {
    assert(`${label}: ${field} untouched`, inputValue(root, `createfood-${field}`) === '');
  }

  // Retry re-sends the SAME photo — no re-pick needed.
  fetchState.script.push({ kind: 'json', status: 200, body: OK_BODY });
  const callsBefore = fetchState.calls.length;
  await tap(root, 'createfood-scan-retry', label);
  const retryCall = fetchState.calls.at(-1);
  assert(`${label}: retry hits the scanner again`, fetchState.calls.length === callsBefore + 1);
  assert(`${label}: retry reuses the kept photo`, retryCall?.image === EXPECTED_UPLOAD);
  assert(
    `${label}: a readable retry then prefills`,
    inputValue(root, 'createfood-calories') === '230',
  );
  act(() => renderer.unmount());
}

async function checkFailures() {
  // Transport failure.
  {
    const label = 'network failure';
    const { renderer } = await renderCreateFood();
    const root = renderer.root;
    await pickPhoto(root, label);
    fetchState.script.push({ kind: 'reject', error: new TypeError('network down') });
    await tap(root, 'createfood-scan-start', label);
    const box = hostByTestID(root, 'createfood-scan-error');
    assert(`${label}: announced error box`, box !== null && box.props.accessibilityRole === 'alert');
    assert(
      `${label}: connection wording`,
      textOf(root, 'createfood-scan-error').includes('Could not reach the label scanner'),
    );
    assert(`${label}: retry offered`, present(root, 'createfood-scan-retry'));
    assert(`${label}: fields untouched`, inputValue(root, 'createfood-calories') === '');
    act(() => renderer.unmount());
  }

  // Server 502 with a user-facing message.
  {
    const label = 'server failure';
    const { renderer } = await renderCreateFood();
    const root = renderer.root;
    await pickPhoto(root, label);
    fetchState.script.push({
      kind: 'json',
      status: 502,
      body: { error: 'The label scan is unavailable right now. Please try again.' },
    });
    await tap(root, 'createfood-scan-start', label);
    assert(
      `${label}: server's message surfaces`,
      textOf(root, 'createfood-scan-error').includes('The label scan is unavailable right now.'),
    );
    act(() => renderer.unmount());
  }

  // "ok" without a valid label payload must be an error, never a prefill.
  {
    const label = 'malformed ok';
    const { renderer } = await renderCreateFood();
    const root = renderer.root;
    await pickPhoto(root, label);
    fetchState.script.push({
      kind: 'json',
      status: 200,
      body: { result: 'ok', message: 'Read it!', label: { servingSize: 'x' } },
    });
    await tap(root, 'createfood-scan-start', label);
    assert(`${label}: treated as an error`, present(root, 'createfood-scan-error'));
    assert(`${label}: nothing prefilled`, inputValue(root, 'createfood-calories') === '');
    act(() => renderer.unmount());
  }
}

async function checkEditableAndSave() {
  const label = 'edit + save';
  const { renderer, patient } = await renderCreateFood();
  const root = renderer.root;

  await pickPhoto(root, label);
  fetchState.script.push({ kind: 'json', status: 200, body: OK_BODY });
  await tap(root, 'createfood-scan-start', label);

  // Every prefilled value stays editable.
  await typeText(root, 'createfood-calories', '215', label);
  await typeText(root, 'createfood-protein', '9', label);
  assert(`${label}: calories editable after prefill`, inputValue(root, 'createfood-calories') === '215');

  await typeText(root, 'createfood-name', 'label granola', label);
  await tap(root, 'createfood-save', label);

  const saved = patient().customFoods.find(f => f.name === 'Label Granola');
  assert(`${label}: ordinary save path ran (Title Case name)`, saved !== undefined);
  assert(`${label}: edited calories saved, not the scan's`, saved?.calories === 215);
  assert(`${label}: edited protein saved`, saved?.protein === 9);
  assert(`${label}: label serving saved`, saved?.serving === '2/3 cup (55g)');
  assert(`${label}: untouched carbs saved from the scan`, saved?.carbs === 37);
  assert(
    `${label}: save navigates as always`,
    routerCalls.some(c => c.method === 'replace' && c.target === '/recipes'),
  );

  act(() => renderer.unmount());
  return saved?.id;
}

async function checkEditModeHidesScan(savedId: string | undefined) {
  const label = 'edit mode';
  if (!savedId) {
    fail(`${label}: no saved food id from the save check`);
    return;
  }
  const { renderer } = await renderCreateFood({ id: savedId });
  const root = renderer.root;

  assert(`${label}: scan section absent`, !present(root, 'createfood-scan-section'));
  assert(`${label}: fields seed from the stored food`, inputValue(root, 'createfood-name') === 'Label Granola');
  assert(`${label}: stored calories seeded`, inputValue(root, 'createfood-calories') === '215');
  act(() => renderer.unmount());
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // AppMode reads localStorage on web (the stubbed Platform.OS); Node has
  // none, so install a tiny shim seeded to the patient persona.
  const webStore = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => webStore.get(k) ?? null,
    setItem: (k: string, v: string) => void webStore.set(k, v),
    removeItem: (k: string) => void webStore.delete(k),
  };
  webStore.set('thinnr_app_mode_v1', 'patient');

  // apiBase() needs a domain; the mock intercepts before any real network.
  process.env.EXPO_PUBLIC_DOMAIN = 'label-scan.test';
  installFetchMock();

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

  // Import the app modules AFTER the environment shims are in place.
  const [screen, appMode, patientCtx] = await Promise.all([
    import('../app/create-food'),
    import('../context/AppModeContext'),
    import('../context/PatientContext'),
  ]);
  deps = {
    CreateFoodScreen: screen.default,
    AppModeProvider: appMode.AppModeProvider,
    PatientProvider: patientCtx.PatientProvider,
    usePatient: patientCtx.usePatient,
  };

  await checkAffordance();
  await checkHappyPath();
  await checkFlagged();
  await checkUnreadable();
  await checkFailures();
  const savedId = await checkEditableAndSave();
  await checkEditModeHidesScan(savedId);

  finish();
}

// A dangling await (e.g. an unscripted hanging promise) would otherwise let
// Node drain its event loop and exit 0 without running a single assertion.
process.on('beforeExit', () => {
  console.error('✗ create-food label scan: suite exited before finishing (dangling await?)');
  process.exit(1);
});

main().catch(error => {
  console.error('create-food label scan suite crashed:', error);
  process.exit(1);
});
