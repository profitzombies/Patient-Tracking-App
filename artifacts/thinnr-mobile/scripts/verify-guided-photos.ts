/**
 * Guided progress-photo session verification (task: hands-free countdown
 * capture with per-angle reshoot and App Storage upload).
 *
 * Runs the REAL GuidedPhotoSession component tree, PatientContext,
 * detection/probe/upload libs, and the Progress + Check-in entry points
 * under Node via react-test-renderer, with native modules remapped to
 * scripts/guided-photo-stubs (see tsconfig.guided-photos.json).
 *
 * Countdown/probe timing is dialed down through the injectable module
 * knobs so full three-angle sessions run in tens of milliseconds.
 *
 * Sections:
 *   1. Handoff contract (create / claim / settle semantics)
 *   2. Subject detector unit behavior (light, walk-in, off-center, hold)
 *   3. PNG luma decode + camera probe pipeline
 *   4. Upload pipeline unit behavior (presign → PUT → finalize, failures)
 *   5. Web demo: full auto session (setup → positioning → countdown ×3 → review)
 *   6. Web demo: per-angle reshoot + save (uploads, grid entries, settle)
 *   7. Upload failure → inline error → retry uploads only failed angles
 *   8. Hide-instructions persistence (toggle + skip-straight-to-capture)
 *   9. Manual "Start now" fallback
 *  10. Native: tilt meter states, probe options, capture quality, save
 *  11. Native: capture failure recovers into positioning
 *  12. Native: probe-unavailable timed fallback
 *  13. Native: permission fallback (ask / settings / close / auto-ask)
 *  14. Progress screen entry point, saved snackbar, grid objectPath sources
 *  15. Check-in entry point + saved announcement
 */
import { deflateSync } from 'node:zlib';
import React from 'react';
import { act } from 'react';

process.env.EXPO_PUBLIC_DOMAIN = 'guided-photos.internal';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── localStorage polyfill (web-platform storage for contexts + prefs) ────
const localStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
  setItem: (key: string, value: string) => void localStore.set(key, String(value)),
  removeItem: (key: string) => void localStore.delete(key),
  clear: () => void localStore.clear(),
  key: (index: number) => [...localStore.keys()][index] ?? null,
  get length() {
    return localStore.size;
  },
};

// ── Console noise filter (act() warnings, deliberate failure logs) ───────
const SWALLOWED_LOG_PREFIXES = [
  'Warning:',
  'react-test-renderer is deprecated',
  'Guided capture failed',
  'Progress photo upload failed',
  'The above error occurred',
];
const realConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (SWALLOWED_LOG_PREFIXES.some(prefix => first.startsWith(prefix))) return;
  if (first.includes('act(')) return;
  realConsoleError(...args);
};

// ── Stubs (same module instances the components see via tsconfig paths) ──
import { announcements, Platform } from './guided-photo-stubs/react-native';
import { openSettingsCalls } from './meal-photo-stubs/react-native';
import { cameraState, resetCameraStub } from './guided-photo-stubs/expo-camera';
import { motionState } from './guided-photo-stubs/expo-sensors';
import { audioState, StubAudioPlayer } from './guided-photo-stubs/expo-audio';
import { routerCalls, clearRouterCalls, routerState } from './meal-photo-stubs/expo-router';
import AsyncStorageStub from './meal-photo-stubs/async-storage';

// ── App modules under test ───────────────────────────────────────────────
import {
  COUNTDOWN_SECONDS,
  GUIDED_ANGLES,
  GUIDED_ANGLE_LABELS,
  HIDE_INSTRUCTIONS_KEY,
  claimGuidedPhotoRequest,
  createGuidedPhotoRequest,
  setGuidedProbeIntervalMs,
  setGuidedTickIntervalMs,
  type GuidedSessionOutcome,
} from '../lib/guided-photos';
import {
  BODY_HEIGHT_READY_MAX,
  BODY_HEIGHT_READY_MIN,
  READY_HOLD_PROBES,
  createSubjectDetector,
  makeSimulatedFrame,
  type LumaFrame,
} from '../lib/photo-detection';
import { decodeBase64, decodePngToLuma, probeCameraFrame } from '../lib/photo-probe';
import { progressPhotoDisplayUrl, uploadGuidedShots } from '../lib/progress-photo-upload';
import { ENROLLMENT_DAYS, TODAY_KEY } from '../data/patient-data';
import * as SessionModule from '../components/patient/GuidedPhotoSession';
import { PatientProvider, usePatient } from '../context/PatientContext';
import { AppModeProvider } from '../context/AppModeContext';
import * as ProgressModule from '../app/(patient)/progress';
import * as CheckInModule from '../app/check-in';

type SessionProps = { onSettle: (outcome: GuidedSessionOutcome | null) => void };
const GuidedPhotoSession = ((SessionModule as Record<string, unknown>).default ??
  (SessionModule as Record<string, unknown>).GuidedPhotoSession) as React.ComponentType<SessionProps>;
const ProgressScreen = (ProgressModule as Record<string, unknown>)
  .default as React.ComponentType<Record<string, never>>;
const CheckInScreen = (CheckInModule as Record<string, unknown>)
  .default as React.ComponentType<Record<string, never>>;

const h = React.createElement;

// ── Tally ────────────────────────────────────────────────────────────────
let checks = 0;
let failures = 0;

function fail(label: string, detail?: unknown): void {
  failures += 1;
  console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${String(detail)}`}`);
}

function assert(condition: boolean, label: string, detail?: unknown): void {
  checks += 1;
  if (condition) return;
  fail(label, detail);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  checks += 1;
  if (Object.is(actual, expected)) return;
  fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string): void {
  console.log(`\n== ${title}`);
}

function finish(): never {
  console.log(`\n${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── React test helpers ───────────────────────────────────────────────────
// Loose structural types for react-test-renderer instances.
interface TInstance {
  type: unknown;
  props: Record<string, any>;
  children: Array<TInstance | string>;
}
interface TRenderer {
  root: TInstance & { findAll(fn: (node: TInstance) => boolean): TInstance[] };
  unmount(): void;
}

let TestRendererCreate: (el: React.ReactElement) => TRenderer;

async function actSettle(mutate?: () => unknown): Promise<void> {
  await act(async () => {
    await mutate?.();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function actSleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      assert(true, label);
      return true;
    }
    if (Date.now() > deadline) {
      assert(false, label, 'timed out waiting');
      return false;
    }
    await actSleep(10);
  }
}

function allByTestID(renderer: TRenderer, testID: string): TInstance[] {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props?.testID === testID,
  );
}

function byTestID(renderer: TRenderer, testID: string): TInstance | null {
  return allByTestID(renderer, testID)[0] ?? null;
}

function present(renderer: TRenderer, testID: string): boolean {
  return allByTestID(renderer, testID).length > 0;
}

function collectText(node: TInstance | string): string[] {
  if (typeof node === 'string') return [node];
  const out: string[] = [];
  for (const child of node.children ?? []) out.push(...collectText(child));
  return out;
}

function textOf(node: TInstance | null): string {
  return node ? collectText(node).join(' ') : '';
}

function surfaceText(renderer: TRenderer): string {
  return collectText(renderer.root as unknown as TInstance).join(' ');
}

async function tap(renderer: TRenderer, testID: string, label: string): Promise<void> {
  const node = byTestID(renderer, testID);
  if (!node) {
    assert(false, label, `no node with testID ${testID}`);
    return;
  }
  const disabled = node.props.disabled === true || node.props['aria-disabled'] === true;
  if (disabled) {
    assert(false, label, `${testID} is disabled`);
    return;
  }
  if (typeof node.props.onPress !== 'function') {
    assert(false, label, `${testID} has no onPress`);
    return;
  }
  await actSettle(() => node.props.onPress());
  assert(true, label);
}

function checkedOf(node: TInstance | null): unknown {
  if (!node) return undefined;
  return node.props.accessibilityState?.checked ?? node.props['aria-checked'];
}

function countAnnounced(text: string): number {
  return announcements.filter(entry => entry === text).length;
}

function announcedIncluding(fragment: string): number {
  return announcements.filter(entry => entry.includes(fragment)).length;
}

// ── Patient context probe ────────────────────────────────────────────────
let patientCtx: ReturnType<typeof usePatient> | null = null;
function PatientProbe(): null {
  patientCtx = usePatient();
  return null;
}

// ── PNG encoder (grayscale + truecolor, filter None) ─────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes a luma frame as a PNG (grayscale type 0 or RGB type 2), base64. */
function encodePng(frame: LumaFrame, colorType: 0 | 2): string {
  const { width, height, luma } = frame;
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const channels = colorType === 2 ? 3 : 1;
  const raw = new Uint8Array(height * (1 + width * channels));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const value = luma[y * width + x];
      for (let c = 0; c < channels; c++) raw[offset++] = value;
    }
  }
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = new Uint8Array(deflateSync(raw));
  const total = new Uint8Array(
    signature.length + 12 + 13 + 12 + idat.length + 12,
  );
  let pos = 0;
  for (const part of [
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ]) {
    total.set(part, pos);
    pos += part.length;
  }
  return Buffer.from(total).toString('base64');
}

function customFrame(
  width: number,
  height: number,
  background: number,
  paint?: (x: number, y: number) => number | null,
): LumaFrame {
  const luma = new Uint8Array(width * height).fill(background);
  if (paint) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = paint(x, y);
        if (value !== null) luma[y * width + x] = value;
      }
    }
  }
  return { width, height, luma };
}

// ── Scripted upload endpoints ────────────────────────────────────────────
const uploadLog = {
  uploadUrlPosts: [] as Array<{ angle: string; contentType: string; sizeBytes: number }>,
  puts: [] as Array<{ angle: string; bytes: number }>,
  finalizes: [] as Array<{ objectPath: string }>,
};
const uploadFailures = {
  uploadUrl: new Set<string>(),
  put: new Set<string>(),
  finalize: new Set<string>(),
};

function resetUploadScript(): void {
  uploadLog.uploadUrlPosts.length = 0;
  uploadLog.puts.length = 0;
  uploadLog.finalizes.length = 0;
  uploadFailures.uploadUrl.clear();
  uploadFailures.put.clear();
  uploadFailures.finalize.clear();
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function angleFromObjectPath(objectPath: string): string {
  const match = /progress-photos\/(front|side|back)/.exec(objectPath);
  return match?.[1] ?? 'unknown';
}

globalThis.fetch = (async (input: unknown, init?: Record<string, any>) => {
  const url =
    typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input);
  const method = String(init?.method ?? 'GET').toUpperCase();
  if (url === 'https://guided-photos.internal/api/progress-photos/upload-url' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    uploadLog.uploadUrlPosts.push(body);
    if (uploadFailures.uploadUrl.has(body.angle)) {
      return jsonResponse(500, { error: 'Storage rejected the request' });
    }
    return jsonResponse(200, {
      uploadUrl: `https://storage.guided.test/put/${body.angle}?sig=abc`,
      objectPath: `/objects/progress-photos/${body.angle}-fixed`,
    });
  }
  if (url.startsWith('https://storage.guided.test/put/') && method === 'PUT') {
    const angle = url.slice('https://storage.guided.test/put/'.length).split('?')[0];
    const body = init?.body;
    let bytes = 0;
    if (body instanceof ArrayBuffer) bytes = body.byteLength;
    else if (ArrayBuffer.isView(body)) bytes = (body as ArrayBufferView).byteLength;
    else if (typeof body === 'string') bytes = body.length;
    uploadLog.puts.push({ angle, bytes });
    if (uploadFailures.put.has(angle)) return jsonResponse(503, { error: 'PUT failed' });
    return new Response('', { status: 200 });
  }
  if (url === 'https://guided-photos.internal/api/progress-photos/finalize' && method === 'POST') {
    const body = JSON.parse(String(init?.body ?? '{}'));
    uploadLog.finalizes.push(body);
    const angle = angleFromObjectPath(String(body.objectPath ?? ''));
    if (uploadFailures.finalize.has(angle)) return jsonResponse(422, { error: 'Object missing' });
    return jsonResponse(200, { objectPath: body.objectPath, sizeBytes: 128 });
  }
  throw new Error(`Unexpected fetch in guided-photos suite: ${method} ${url}`);
}) as typeof fetch;

// ── Shared scenario plumbing ─────────────────────────────────────────────
const PATIENT_STATE_KEY = 'thinnr_patient_state_v1';

async function seedQuietPatientState(): Promise<void> {
  const seeded = JSON.stringify({ nudgeOptOut: true });
  localStore.set(PATIENT_STATE_KEY, seeded);
  await AsyncStorageStub.setItem(PATIENT_STATE_KEY, seeded);
}

async function resetScenario(platform: 'web' | 'ios'): Promise<void> {
  (Platform as { OS: string }).OS = platform;
  announcements.length = 0;
  audioState.reset();
  resetCameraStub();
  motionState.reset();
  clearRouterCalls();
  resetUploadScript();
  openSettingsCalls.count = 0;
  routerState.pathname = '/guided-photos';
  localStore.delete(HIDE_INSTRUCTIONS_KEY);
  await AsyncStorageStub.removeItem(HIDE_INSTRUCTIONS_KEY);
  await seedQuietPatientState();
  // drain any pending handoff so scenarios stay independent
  claimGuidedPhotoRequest()?.settle(null);
}

interface MountedSession {
  renderer: TRenderer;
  outcomes: Array<GuidedSessionOutcome | null>;
}

async function mountSession(): Promise<MountedSession> {
  const outcomes: Array<GuidedSessionOutcome | null> = [];
  let renderer!: TRenderer;
  await actSettle(() => {
    renderer = TestRendererCreate(
      h(
        PatientProvider,
        null,
        h(PatientProbe),
        h(GuidedPhotoSession, { onSettle: outcome => outcomes.push(outcome) }),
      ),
    );
  });
  return { renderer, outcomes };
}

function tickPlayer(): StubAudioPlayer | null {
  return (
    audioState.players.find(p => (p.source as { sound?: string })?.sound === 'tick') ?? null
  );
}

function tonePlayer(): StubAudioPlayer | null {
  return (
    audioState.players.find(p => (p.source as { sound?: string })?.sound === 'capture-tone') ??
    null
  );
}

/** Camera handler: probe calls walk the simulated frames; captures return JPEG data URIs. */
function scriptNativeCamera(options?: {
  failCaptureAttempts?: number;
  probeUri?: (probeIndex: number) => string | null;
}): { captures: () => number } {
  let probeStep = 0;
  let captureCount = 0;
  let failuresLeft = options?.failCaptureAttempts ?? 0;
  cameraState.handler = callOptions => {
    if (callOptions.quality === 1) {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('shutter jam');
      }
      captureCount += 1;
      const payload = Buffer.from(`CAPTURE-${captureCount}`).toString('base64');
      return {
        uri: `data:image/jpeg;base64,${payload}`,
        width: 1200,
        height: 1600,
      };
    }
    const index = probeStep;
    probeStep += 1;
    if (options?.probeUri) {
      const uri = options.probeUri(index);
      return { uri: uri ?? '', width: 18, height: 24 };
    }
    const frame = makeSimulatedFrame(Math.min(index, 6));
    return {
      uri: `data:image/png;base64,${encodePng(frame, 0)}`,
      width: frame.width,
      height: frame.height,
    };
  };
  return { captures: () => captureCount };
}

// ═════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const trModule = (await import('react-test-renderer')) as Record<string, any>;
  const TestRenderer = trModule.default ?? trModule;
  TestRendererCreate = (element: React.ReactElement) => TestRenderer.create(element);

  setGuidedTickIntervalMs(20);
  setGuidedProbeIntervalMs(20);

  // ── 1. Handoff contract ────────────────────────────────────────────────
  section('1. Handoff contract');
  {
    assertEqual(claimGuidedPhotoRequest(), null, 'claim with nothing pending is null');

    let firstResult: GuidedSessionOutcome | null | 'unset' = 'unset';
    const first = createGuidedPhotoRequest();
    void first.then(value => (firstResult = value));
    const second = createGuidedPhotoRequest();
    await Promise.resolve();
    await Promise.resolve();
    assertEqual(firstResult, null, 'second create settles orphaned predecessor with null');

    const claim = claimGuidedPhotoRequest();
    assert(claim !== null, 'pending request claimable');
    assertEqual(claimGuidedPhotoRequest(), null, 'claim is once-only');

    let secondResult: GuidedSessionOutcome | null | 'unset' = 'unset';
    void second.then(value => (secondResult = value));
    claim!.settle({ savedCount: 2 });
    claim!.settle({ savedCount: 9 }); // idempotent — first settle wins
    await Promise.resolve();
    await Promise.resolve();
    assert(
      secondResult !== 'unset' && secondResult !== null && secondResult.savedCount === 2,
      'settle resolves caller once (extra settles ignored)',
      JSON.stringify(secondResult),
    );
  }

  // ── 2. Subject detector ────────────────────────────────────────────────
  section('2. Subject detector');
  {
    const detector = createSubjectDetector();
    const bg = makeSimulatedFrame(0);
    assertEqual(detector.push(bg).status, 'not-detected', 'first frame seeds background');
    assertEqual(
      detector.push(customFrame(18, 24, 20)).status,
      'too-dark',
      'dark frame wins over position',
    );
    assertEqual(
      detector.push(customFrame(18, 24, 245)).status,
      'too-bright',
      'bright frame flagged',
    );

    const walk = createSubjectDetector();
    const statuses: string[] = [];
    const readings = [];
    for (let step = 0; step <= 6; step++) {
      const reading = walk.push(makeSimulatedFrame(step));
      statuses.push(reading.status);
      readings.push(reading);
    }
    assertEqual(
      statuses.join(','),
      'not-detected,not-detected,too-far,too-far,ready,ready,ready',
      'walk-in status sequence',
    );
    assertEqual(readings[4].readyStreak, 1, 'first ready probe streak 1');
    assertEqual(readings[4].shouldStartCountdown, false, 'streak 1 does not start');
    assertEqual(readings[6].readyStreak, READY_HOLD_PROBES, 'third ready probe hits hold');
    assertEqual(readings[6].shouldStartCountdown, true, 'ready hold starts countdown');
    assert(
      readings[6].bodyHeightFraction !== null &&
        readings[6].bodyHeightFraction! >= BODY_HEIGHT_READY_MIN &&
        readings[6].bodyHeightFraction! <= BODY_HEIGHT_READY_MAX,
      'ready body height within window',
      readings[6].bodyHeightFraction,
    );
    assert(
      readings[6].centerOffsetFraction !== null && Math.abs(readings[6].centerOffsetFraction!) < 0.23,
      'centered subject has small offset',
      readings[6].centerOffsetFraction,
    );

    walk.resetHold();
    const afterReset = walk.push(makeSimulatedFrame(6));
    assertEqual(afterReset.readyStreak, 1, 'resetHold clears the ready streak');
    assertEqual(afterReset.shouldStartCountdown, false, 'no start right after reset');

    const offCenter = createSubjectDetector();
    offCenter.push(customFrame(18, 24, 150));
    const offReading = offCenter.push(
      customFrame(18, 24, 150, (x, y) => (x <= 3 && y >= 6 ? 70 : null)),
    );
    assertEqual(offReading.status, 'off-center', 'left-edge subject reads off-center');

    const close = createSubjectDetector();
    close.push(customFrame(18, 24, 150));
    const closeReading = close.push(
      customFrame(18, 24, 150, (x) => (x >= 6 && x <= 11 ? 70 : null)),
    );
    assertEqual(closeReading.status, 'too-close', 'full-height subject reads too-close');
  }

  // ── 3. PNG decode + probe pipeline ─────────────────────────────────────
  section('3. PNG decode + camera probe');
  {
    const source = makeSimulatedFrame(6);
    const gray = decodePngToLuma(decodeBase64(encodePng(source, 0)));
    assertEqual(gray.width, source.width, 'gray decode width');
    assertEqual(gray.height, source.height, 'gray decode height');
    assert(
      gray.luma.length === source.luma.length &&
        gray.luma.every((value, index) => value === source.luma[index]),
      'grayscale roundtrip is lossless',
    );

    const rgb = decodePngToLuma(decodeBase64(encodePng(source, 2)));
    assert(
      rgb.luma.every((value, index) => Math.abs(value - source.luma[index]) <= 1),
      'RGB roundtrip luma matches within rounding',
    );

    const fakeCamera = (uri: string) =>
      ({
        takePictureAsync: async () => ({ uri, width: 18, height: 24 }),
      }) as unknown as Parameters<typeof probeCameraFrame>[0];

    const probed = await probeCameraFrame(
      fakeCamera(`data:image/png;base64,${encodePng(source, 0)}`),
    );
    assert(
      probed !== null && probed.width === 18 && probed.luma[0] === source.luma[0],
      'probe pipeline decodes camera frame',
    );
    assertEqual(await probeCameraFrame(fakeCamera('')), null, 'empty uri probes null');
    assertEqual(
      await probeCameraFrame(fakeCamera('data:image/png;base64,AAAA')),
      null,
      'garbage bytes probe null',
    );
    const throwing = {
      takePictureAsync: async () => {
        throw new Error('camera busy');
      },
    } as unknown as Parameters<typeof probeCameraFrame>[0];
    assertEqual(await probeCameraFrame(throwing), null, 'camera error probes null');
  }

  // ── 4. Upload pipeline units ───────────────────────────────────────────
  section('4. Upload pipeline');
  {
    assertEqual(
      progressPhotoDisplayUrl('/objects/progress-photos/demo-1'),
      'https://guided-photos.internal/api/progress-photos/file?path=%2Fobjects%2Fprogress-photos%2Fdemo-1',
      'display url shape',
    );

    resetUploadScript();
    const shots = GUIDED_ANGLES.map(angle => ({
      angle,
      uri: `data:image/jpeg;base64,${Buffer.from(`SHOT-${angle}`).toString('base64')}`,
      width: 900,
      height: 1200,
    }));
    const result = await uploadGuidedShots(shots);
    assertEqual(result.failed.length, 0, 'all uploads succeed');
    assertEqual(result.uploaded.length, 3, 'three uploaded refs');
    assertEqual(
      result.uploaded.map(ref => ref.objectPath).join(','),
      '/objects/progress-photos/front-fixed,/objects/progress-photos/side-fixed,/objects/progress-photos/back-fixed',
      'object paths from presign are preserved',
    );
    assertEqual(
      uploadLog.uploadUrlPosts.map(post => post.angle).join(','),
      'front,side,back',
      'presigns requested per angle in order',
    );
    assert(
      uploadLog.uploadUrlPosts.every(
        post => post.contentType === 'image/jpeg' && post.sizeBytes > 0,
      ),
      'presign posts carry jpeg content type + size',
    );
    assert(
      uploadLog.puts.length === 3 && uploadLog.puts.every(put => put.bytes > 0),
      'PUT bodies carry bytes',
    );
    assertEqual(uploadLog.finalizes.length, 3, 'finalize per angle');

    resetUploadScript();
    uploadFailures.put.add('side');
    const partial = await uploadGuidedShots(shots);
    assertEqual(partial.failed.join(','), 'side', 'failed PUT reports its angle');
    assertEqual(partial.uploaded.length, 2, 'other angles still land');

    resetUploadScript();
    uploadFailures.finalize.add('back');
    const finalizeFail = await uploadGuidedShots(shots);
    assertEqual(finalizeFail.failed.join(','), 'back', 'failed finalize reports its angle');
  }

  // ── 5. Web demo: full auto session ─────────────────────────────────────
  section('5. Web demo: setup → auto positioning → countdown ×3 → review');
  let webSession: MountedSession;
  {
    await resetScenario('web');
    webSession = await mountSession();
    const { renderer } = webSession;

    await waitUntil('setup card appears', () => present(renderer, 'guided-begin'));
    assert(present(renderer, 'guided-hide-instructions'), 'hide-instructions checkbox present');
    const setupCopy = surfaceText(renderer);
    assert(/floor/i.test(setupCopy), 'setup mentions floor placement');
    assert(/six feet|6 feet/i.test(setupCopy), 'setup mentions six feet');
    assert(/front camera/i.test(setupCopy), 'setup mentions front camera');

    const tilt = byTestID(renderer, 'guided-tilt');
    assert(tilt !== null, 'tilt meter rendered');
    assertEqual(
      tilt?.props.accessibilityLabel,
      'Tilt the phone back a little more.',
      'web tilt script starts in tilt-back',
    );

    await tap(renderer, 'guided-begin', 'tap Start session');
    await waitUntil('positioning stage shows angle banner', () =>
      present(renderer, 'guided-angle-banner'),
    );
    assert(/front/i.test(textOf(byTestID(renderer, 'guided-angle-banner'))), 'banner names FRONT');
    assert(present(renderer, 'guided-outline'), 'body outline overlay present');
    assert(present(renderer, 'guided-start-now'), 'manual Start now available');
    assert(
      announcements.some(a => a.startsWith('Front photo first.')),
      'positioning intro announced',
    );

    await waitUntil('simulated probes auto-start the countdown', () =>
      present(renderer, 'guided-countdown'),
    );
    assertEqual(
      countAnnounced('In position. Hold still.'),
      1,
      'ready status announced once for front',
    );
    assert(
      announcements.includes(
        `In position. Taking the front photo in ${COUNTDOWN_SECONDS} seconds. Hold still.`,
      ),
      'countdown start announced',
    );

    await waitUntil('all three angles captured → review', () =>
      present(renderer, 'guided-review-save'),
    );
    for (const angle of GUIDED_ANGLES) {
      assertEqual(
        countAnnounced(`${GUIDED_ANGLE_LABELS[angle]} photo captured.`),
        1,
        `${angle} capture announced once`,
      );
    }
    assert(
      announcements.includes('Now the side photo. Turn, then hold still in the outline.'),
      'side transition announced',
    );
    assert(
      announcements.includes('Now the back photo. Turn, then hold still in the outline.'),
      'back transition announced',
    );
    assertEqual(countAnnounced('All photos captured. Review your shots.'), 1, 'review announced');
    for (let second = COUNTDOWN_SECONDS; second >= 1; second--) {
      assertEqual(
        countAnnounced(String(second)),
        3,
        `countdown "${second}" announced once per angle`,
      );
    }
    assertEqual(tickPlayer()?.plays, 21, 'tick sound per countdown second (7 × 3)');
    assertEqual(tonePlayer()?.plays, 3, 'capture tone once per shot');

    for (const angle of GUIDED_ANGLES) {
      const image = renderer.root.findAll(
        node =>
          typeof node.type === 'string' && node.props?.source?.uri === `asset://pose-${angle}`,
      );
      assert(image.length > 0, `review shows ${angle} shot from demo asset`);
    }
  }

  // ── 6. Web demo: reshoot side only, then save ──────────────────────────
  section('6. Per-angle reshoot + save');
  {
    const { renderer, outcomes } = webSession;

    assert(!present(renderer, 'guided-review-reshoot'), 'reshoot CTA hidden with no selection');
    await tap(renderer, 'guided-reshoot-side', 'select Side for reshoot');
    assertEqual(checkedOf(byTestID(renderer, 'guided-reshoot-side')), true, 'side tile checked');
    assert(
      announcements.includes('Side selected for reshoot. 1 selected.'),
      'selection announced',
    );
    await tap(renderer, 'guided-reshoot-side', 'unselect Side');
    assert(
      announcements.includes('Side unselected for reshoot. 0 selected.'),
      'unselection announced',
    );
    assert(!present(renderer, 'guided-review-reshoot'), 'reshoot CTA hides again at 0 selected');
    await tap(renderer, 'guided-reshoot-side', 'reselect Side');
    assert(present(renderer, 'guided-review-reshoot'), 'reshoot CTA appears with selection');

    await tap(renderer, 'guided-review-reshoot', 'begin reshoot');
    await waitUntil('reshoot repositions for SIDE', () =>
      present(renderer, 'guided-angle-banner'),
    );
    assert(/side/i.test(textOf(byTestID(renderer, 'guided-angle-banner'))), 'banner names SIDE');
    await waitUntil('reshoot returns to review', () => present(renderer, 'guided-review-save'));
    assertEqual(countAnnounced('Side photo captured.'), 2, 'side captured twice overall');
    assertEqual(countAnnounced('Front photo captured.'), 1, 'front untouched by reshoot');
    assertEqual(countAnnounced('Back photo captured.'), 1, 'back untouched by reshoot');
    assertEqual(tickPlayer()?.plays, 28, 'reshoot adds one more full countdown of ticks');
    assertEqual(tonePlayer()?.plays, 4, 'reshoot adds one more capture tone');

    resetUploadScript();
    const photosBefore = patientCtx!.photos.length;
    await tap(renderer, 'guided-review-save', 'tap Save');
    assert(announcements.includes('Saving your photos.'), 'saving announced');
    await waitUntil('session settles with an outcome', () => outcomes.length === 1);
    assert(
      outcomes[0] !== null && outcomes[0]!.savedCount === 3,
      'outcome reports 3 saved photos',
      JSON.stringify(outcomes[0]),
    );
    assertEqual(
      uploadLog.uploadUrlPosts.map(post => post.angle).join(','),
      'front,side,back',
      'save uploads all three angles',
    );
    assertEqual(uploadLog.finalizes.length, 3, 'save finalizes all three');
    assertEqual(countAnnounced('3 progress photos saved.'), 1, 'save success announced');

    const photos = patientCtx!.photos;
    assertEqual(photos.length, photosBefore + 3, 'three photos added to the grid');
    const week = Math.ceil(ENROLLMENT_DAYS / 7);
    const added = photos.slice(-3);
    for (let i = 0; i < GUIDED_ANGLES.length; i++) {
      const angle = GUIDED_ANGLES[i];
      const entry = added.find(photo => (photo as { angle?: string }).angle === angle) as
        | Record<string, unknown>
        | undefined;
      assert(entry !== undefined, `grid entry exists for ${angle}`);
      if (!entry) continue;
      assertEqual(
        entry.objectPath,
        `/objects/progress-photos/${angle}-fixed`,
        `${angle} entry stores object path (not a URL)`,
      );
      assertEqual(
        entry.label,
        `Week ${week} ${GUIDED_ANGLE_LABELS[angle]}`,
        `${angle} entry label`,
      );
      assertEqual(entry.dateKey, TODAY_KEY, `${angle} entry dated today`);
    }
    await actSettle(() => webSession.renderer.unmount());
  }

  // ── 7. Upload failure → retry only failed angles ───────────────────────
  section('7. Upload failure keeps shots + retry sends only failed angles');
  {
    await resetScenario('web');
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1'); // also exercises skip-straight-to-capture
    const { renderer, outcomes } = await mountSession();

    await waitUntil('hidden instructions skip straight to positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    assert(!present(renderer, 'guided-begin'), 'setup card skipped for returning user');
    await waitUntil('auto session reaches review', () => present(renderer, 'guided-review-save'));

    uploadFailures.uploadUrl.add('side');
    await tap(renderer, 'guided-review-save', 'save with side presign failing');
    await waitUntil('inline upload error appears', () => present(renderer, 'guided-upload-error'));
    assertEqual(
      textOf(byTestID(renderer, 'guided-upload-error')).trim(),
      'Side photo could not be uploaded. Your shots are still here — try Save again.',
      'error names the failed angle and keeps shots',
    );
    assertEqual(outcomes.length, 0, 'no settle on failed save');
    assert(present(renderer, 'guided-review-save'), 'save stays available for retry');
    for (const angle of GUIDED_ANGLES) {
      const image = renderer.root.findAll(
        node =>
          typeof node.type === 'string' && node.props?.source?.uri === `asset://pose-${angle}`,
      );
      assert(image.length > 0, `${angle} shot still on review after failure`);
    }

    uploadFailures.uploadUrl.clear();
    uploadLog.uploadUrlPosts.length = 0;
    uploadLog.puts.length = 0;
    uploadLog.finalizes.length = 0;
    await tap(renderer, 'guided-review-save', 'retry save');
    await waitUntil('retry settles', () => outcomes.length === 1);
    assertEqual(
      uploadLog.uploadUrlPosts.map(post => post.angle).join(','),
      'side',
      'retry uploads ONLY the failed angle',
    );
    assert(
      outcomes[0] !== null && outcomes[0]!.savedCount === 3,
      'retry still saves the full set of three',
    );
    await actSettle(() => renderer.unmount());
  }

  // ── 8. Hide-instructions persistence ───────────────────────────────────
  section('8. Hide-instructions checkbox persists');
  {
    await resetScenario('web');
    const { renderer } = await mountSession();
    await waitUntil('setup card for pref toggle', () => present(renderer, 'guided-begin'));
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-hide-instructions')),
      false,
      'checkbox starts unchecked',
    );
    await tap(renderer, 'guided-hide-instructions', 'check hide-instructions');
    assertEqual(localStore.get(HIDE_INSTRUCTIONS_KEY), '1', 'pref persisted to storage');
    await actSleep(30);
    assert(
      present(renderer, 'guided-begin'),
      'ticking the box does not launch the session out from under the user',
    );
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-hide-instructions')),
      true,
      'checkbox reflects checked',
    );
    await tap(renderer, 'guided-hide-instructions', 'uncheck hide-instructions');
    assertEqual(localStore.has(HIDE_INSTRUCTIONS_KEY), false, 'pref cleared from storage');
    await actSettle(() => renderer.unmount());
  }

  // ── 9. Manual "Start now" ──────────────────────────────────────────────
  section('9. Manual Start now skips the positioning gate');
  {
    await resetScenario('web');
    setGuidedProbeIntervalMs(500); // slow probes so auto-start cannot win the race
    const { renderer } = await mountSession();
    await waitUntil('setup for manual start', () => present(renderer, 'guided-begin'));
    await tap(renderer, 'guided-begin', 'begin session');
    await waitUntil('positioning for manual start', () => present(renderer, 'guided-start-now'));
    assert(!present(renderer, 'guided-countdown'), 'countdown not yet running');
    await tap(renderer, 'guided-start-now', 'tap Start now');
    await waitUntil('manual start begins countdown', () => present(renderer, 'guided-countdown'));
    assert(
      announcements.includes(
        `In position. Taking the front photo in ${COUNTDOWN_SECONDS} seconds. Hold still.`,
      ),
      'manual start announces countdown',
    );
    await actSettle(() => renderer.unmount());
    setGuidedProbeIntervalMs(20);
  }

  // ── 10. Native: tilt, probes, capture, save ────────────────────────────
  section('10. Native flow: tilt states, probe options, capture, save');
  {
    await resetScenario('ios');
    const camera = scriptNativeCamera();
    const { renderer, outcomes } = await mountSession();

    await waitUntil('native setup card', () => present(renderer, 'guided-begin'));
    await waitUntil('tilt meter listening', () => motionState.listeners.size > 0);
    assert(motionState.updateIntervals.includes(250), 'DeviceMotion update interval set');
    const tiltLabel = () => byTestID(renderer, 'guided-tilt')?.props.accessibilityLabel;
    await actSettle(() => motionState.emitBetaDegrees(88)); // lean 2°
    assertEqual(tiltLabel(), 'Tilt the phone back a little more.', 'lean 2° → tilt-back');
    await actSettle(() => motionState.emitBetaDegrees(40)); // lean 50°
    assertEqual(tiltLabel(), 'Phone is tilted too far back.', 'lean 50° → too far');
    await actSettle(() => motionState.emitBetaDegrees(70)); // lean 20°
    assertEqual(tiltLabel(), 'Phone angle is good.', 'lean 20° → ready');

    await tap(renderer, 'guided-begin', 'native begin');
    await waitUntil('native camera mounts', () => cameraState.mounted > 0);
    const cameraNode = renderer.root.findAll(
      node => typeof node.type === 'string' && node.type === 'CameraView',
    )[0];
    assert(cameraNode !== undefined, 'CameraView rendered');
    assertEqual(cameraNode?.props.facing, 'front', 'front camera selected');

    await waitUntil('native probes auto-start countdown', () =>
      present(renderer, 'guided-countdown'),
    );
    const probeCalls = cameraState.calls.filter(call => call.quality !== 1);
    assert(probeCalls.length >= 7, 'probe stills taken (~1 per interval)', probeCalls.length);
    assert(
      probeCalls.every(call => call.quality === 0.2 && call.shutterSound === false),
      'probes are cheap and silent (quality 0.2, no shutter sound)',
    );

    await waitUntil('native session reaches review', () => present(renderer, 'guided-review-save'));
    assertEqual(camera.captures(), 3, 'three real captures');
    assertEqual(
      cameraState.calls.filter(call => call.quality === 1).length,
      3,
      'captures use full quality',
    );
    assertEqual(tickPlayer()?.plays, 21, 'native ticks 7 × 3');
    assertEqual(tonePlayer()?.plays, 3, 'native capture tones');

    resetUploadScript();
    const photosBefore = patientCtx!.photos.length;
    await tap(renderer, 'guided-review-save', 'native save');
    await waitUntil('native save settles', () => outcomes.length === 1);
    assert(outcomes[0] !== null && outcomes[0]!.savedCount === 3, 'native outcome savedCount 3');
    assert(
      uploadLog.puts.length === 3 && uploadLog.puts.every(put => put.bytes > 0),
      'native PUTs carry the captured bytes',
    );
    assertEqual(patientCtx!.photos.length, photosBefore + 3, 'native grid gains 3 photos');
    await actSettle(() => renderer.unmount());
  }

  // ── 11. Native: capture failure recovers ───────────────────────────────
  section('11. Capture failure recovers into positioning');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    const camera = scriptNativeCamera({ failCaptureAttempts: 1 });
    const { renderer } = await mountSession();

    await waitUntil('failure scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    await waitUntil('capture error appears after shutter jam', () =>
      present(renderer, 'guided-capture-error'),
    );
    assertEqual(
      textOf(byTestID(renderer, 'guided-capture-error')).trim(),
      'That shot did not go through. Get back into position and it will retry.',
      'capture error copy',
    );
    await waitUntil('failed capture retries through to review', () =>
      present(renderer, 'guided-review-save'),
    );
    assertEqual(camera.captures(), 3, 'three successful captures despite the jam');
    assertEqual(countAnnounced('Front photo captured.'), 1, 'front announced once (after retry)');
    await actSettle(() => renderer.unmount());
  }

  // ── 12. Native: probe-unavailable timed fallback ───────────────────────
  section('12. Probe-unavailable timed fallback');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    const camera = scriptNativeCamera({ probeUri: () => null }); // every probe fails
    const { renderer } = await mountSession();

    await waitUntil('fallback announced after repeated probe misses', () =>
      announcedIncluding('Automatic position check unavailable') > 0,
    );
    await waitUntil('timed fallback starts the countdown anyway', () =>
      present(renderer, 'guided-countdown'),
    );
    await waitUntil('timed fallback completes all angles', () =>
      present(renderer, 'guided-review-save'),
    );
    assertEqual(camera.captures(), 3, 'captures still fire on the timer');
    assertEqual(
      announcements.filter(a => a.startsWith('Automatic position check unavailable')).length,
      1,
      'unavailable note announced only once',
    );
    await actSettle(() => renderer.unmount());
  }

  // ── 13. Native: permission fallback ────────────────────────────────────
  section('13. Permission fallback');
  {
    await resetScenario('ios');
    cameraState.permission = { granted: false, canAskAgain: true, status: 'denied' };
    cameraState.requestOutcome = { granted: true, canAskAgain: true, status: 'granted' };
    const denied = await mountSession();
    await waitUntil('denied permission shows fallback', () =>
      present(denied.renderer, 'guided-fallback'),
    );
    assert(!present(denied.renderer, 'guided-begin'), 'setup hidden while denied');
    await tap(denied.renderer, 'guided-fallback-ask', 'tap Allow camera access');
    assertEqual(cameraState.requestCount, 1, 'permission requested');
    await waitUntil('granting dismisses fallback', () => present(denied.renderer, 'guided-begin'));
    await actSettle(() => denied.renderer.unmount());

    await resetScenario('ios');
    cameraState.permission = { granted: false, canAskAgain: false, status: 'denied' };
    const settings = await mountSession();
    await waitUntil('hard-denied shows settings path', () =>
      present(settings.renderer, 'guided-fallback-settings'),
    );
    await tap(settings.renderer, 'guided-fallback-settings', 'tap Open Settings');
    assertEqual(openSettingsCalls.count, 1, 'system settings opened');
    await tap(settings.renderer, 'guided-fallback-close', 'tap Not now');
    assertEqual(settings.outcomes.length, 1, 'closing settles the handoff');
    assertEqual(settings.outcomes[0], null, 'closed session settles null');
    await actSettle(() => settings.renderer.unmount());

    await resetScenario('ios');
    cameraState.permission = { granted: false, canAskAgain: true, status: 'undetermined' };
    cameraState.requestOutcome = { granted: true, canAskAgain: true, status: 'granted' };
    const auto = await mountSession();
    await waitUntil('undetermined permission auto-asks once', () => cameraState.requestCount === 1);
    await waitUntil('auto-granted shows setup', () => present(auto.renderer, 'guided-begin'));
    await actSettle(() => auto.renderer.unmount());
  }

  // ── 14. Progress screen entry point ────────────────────────────────────
  section('14. Progress screen entry point + snackbar + grid sources');
  {
    await resetScenario('web');
    routerState.pathname = '/progress';
    let renderer!: TRenderer;
    await actSettle(() => {
      renderer = TestRendererCreate(
        h(PatientProvider, null, h(PatientProbe), h(ProgressScreen)),
      );
    });
    await waitUntil('guided session button on Progress', () =>
      present(renderer, 'progress-guided-session'),
    );
    assert(
      /hands-free/i.test(surfaceText(renderer)),
      'button explains the hands-free session',
    );

    await tap(renderer, 'progress-guided-session', 'open guided session from Progress');
    assert(
      routerCalls.some(call => call.method === 'push' && call.target === '/guided-photos'),
      'navigates to /guided-photos',
    );
    const claim = claimGuidedPhotoRequest();
    assert(claim !== null, 'entry point registered a pending request');
    await actSettle(() => claim!.settle({ savedCount: 2 }));
    await waitUntil('saved snackbar appears', () => present(renderer, 'guided-saved-snackbar'));
    assert(
      textOf(byTestID(renderer, 'guided-saved-snackbar')).includes('2 photos saved to your grid.'),
      'snackbar counts saved photos',
    );
    assert(
      announcements.includes('2 photos saved to your grid.'),
      'saved notice announced',
    );
    await tap(renderer, 'guided-saved-ok', 'dismiss snackbar');
    assert(!present(renderer, 'guided-saved-snackbar'), 'snackbar dismissed');

    // A second run that closes without saving must not raise the snackbar.
    await tap(renderer, 'progress-guided-session', 'open guided session again');
    const secondClaim = claimGuidedPhotoRequest();
    await actSettle(() => secondClaim!.settle(null));
    await actSleep(30);
    assert(!present(renderer, 'guided-saved-snackbar'), 'no snackbar when closed without saving');

    const objectPath = '/objects/progress-photos/grid-demo';
    await actSettle(() =>
      patientCtx!.addPhotos([
        { dateKey: TODAY_KEY, label: 'Week 12 Front', angle: 'front', objectPath },
      ]),
    );
    await waitUntil('grid resolves objectPath through the API file route', () =>
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props?.source?.uri === progressPhotoDisplayUrl(objectPath),
      ).length > 0,
    );
    await actSettle(() => renderer.unmount());
  }

  // ── 15. Check-in entry point ───────────────────────────────────────────
  section('15. Check-in entry point');
  {
    await resetScenario('web');
    routerState.pathname = '/check-in';
    localStore.set('thinnr_app_mode_v1', 'patient');
    let renderer!: TRenderer;
    await actSettle(() => {
      renderer = TestRendererCreate(
        h(
          AppModeProvider,
          null,
          h(PatientProvider, null, h(PatientProbe), h(CheckInScreen)),
        ),
      );
    });
    await waitUntil('guided link on check-in screen', () =>
      present(renderer, 'checkin-guided-photos'),
    );
    assert(
      textOf(byTestID(renderer, 'checkin-guided-photos')).includes(
        'Add progress photos — guided session',
      ),
      'check-in link labeled',
    );
    await tap(renderer, 'checkin-guided-photos', 'open guided session from check-in');
    assert(
      routerCalls.some(call => call.method === 'push' && call.target === '/guided-photos'),
      'check-in navigates to /guided-photos',
    );
    const claim = claimGuidedPhotoRequest();
    assert(claim !== null, 'check-in registered a pending request');
    await actSettle(() => claim!.settle({ savedCount: 1 }));
    await actSleep(20);
    assert(
      announcements.includes('1 progress photo saved.'),
      'singular saved announcement from check-in',
    );
    await actSettle(() => renderer.unmount());
  }

  finish();
}

main().catch(error => {
  console.error('Suite crashed:', error);
  process.exit(1);
});
