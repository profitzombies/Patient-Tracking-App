/**
 * Guided progress-photo session verification (tasks: hands-free countdown
 * capture with per-angle reshoot + App Storage upload, and the line-up
 * gate — level bar, subject check, steady hold — that precedes every
 * countdown).
 *
 * Runs the REAL GuidedPhotoSession component tree, PatientContext,
 * tilt/line-up/detection/probe/upload libs, and the Progress + Check-in
 * entry points under Node via react-test-renderer, with native modules
 * remapped to scripts/guided-photo-stubs (see tsconfig.guided-photos.json).
 *
 * Countdown/probe/hold timing is dialed down through the injectable module
 * knobs so full three-angle sessions run in tens of milliseconds.
 *
 * Sections:
 *   1. Handoff contract (create / claim / settle semantics)
 *   2. Subject detector (light, walk-in, ready-freeze, vacate, absorb)
 *   3. Tilt model (signed lean, hemisphere fold, gravity-only trust —
 *      beta never consulted, zones, bar mapping, smoother, sim curve)
 *   4. Line-up gate (status priority matrix + steady-hold semantics)
 *   5. Guidance maps stay total + outline art is curved and distinct
 *   6. PNG luma decode + camera probe pipeline
 *   7. Upload pipeline unit behavior (presign → PUT → finalize, failures)
 *   8. Web demo: full auto session (setup → line-up → countdown ×3 → review)
 *   9. Web demo: per-angle reshoot + save (uploads, grid entries, settle)
 *  10. Upload failure → inline error → retry uploads only failed angles
 *  11. Hide-instructions persistence (toggle + skip-straight-to-capture)
 *  12. Escape hatch: "Start anyway" appears only after prolonged failure
 *      (+ spoken cues stay silent under a screen reader)
 *  13. Native: tilt gates the countdown, probe options, capture, save
 *  14. Native: losing the hold resets progress with an audible cue
 *  15. Native: capture failure recovers into positioning
 *  16. Native: probe-unavailable — timed fallback and tilt-only gate
 *  17. Native: permission fallback (ask / settings / close / auto-ask)
 *  18. Progress screen entry point, saved snackbar, grid objectPath sources
 *  19. Check-in entry point + saved announcement
 *  20. Native: beta-only motion (no gravity) can never start the countdown
 *  21. app.json ships the iOS motion permission (NSMotionUsageDescription)
 */
import { readFileSync, statSync } from 'node:fs';
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
import { announcements, Platform, screenReaderState } from './guided-photo-stubs/react-native';
import { openSettingsCalls } from './meal-photo-stubs/react-native';
import { cameraState, resetCameraStub } from './guided-photo-stubs/expo-camera';
import { motionState } from './guided-photo-stubs/expo-sensors';
import { audioState, StubAudioPlayer } from './guided-photo-stubs/expo-audio';
import { speechState } from './guided-photo-stubs/expo-speech';
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
  setGuidedCueSettleMs,
  setGuidedEscapeMs,
  setGuidedGateTickMs,
  setGuidedMotionStaleMs,
  setGuidedSpeechGuardMs,
  setGuidedStatusConfirmMs,
  setGuidedVoiceHandoffMs,
  setGuidedHoldMs,
  setGuidedProbeIntervalMs,
  setGuidedTickIntervalMs,
  type GuidedSessionOutcome,
} from '../lib/guided-photos';
import { PhotoLightbox } from '../components/ui/PhotoLightbox';
import {
  ABSORB_PROBES,
  BODY_HEIGHT_READY_MAX,
  BODY_HEIGHT_READY_MIN,
  createSubjectDetector,
  makeSimulatedFrame,
  type LumaFrame,
  type PositioningReading,
} from '../lib/photo-detection';
import {
  SIM_LEAN_SETTLE_MS,
  TILT_BAND_HYSTERESIS_DEG,
  TILT_BAR_BOTTOM_DEG,
  TILT_BAR_TOP_DEG,
  TILT_FACE_DOWN_DEG,
  TILT_IDEAL_DEG,
  TILT_READY_MAX_DEG,
  TILT_READY_MIN_DEG,
  classifyLean,
  createLeanSmoother,
  inReadyBandDisplay,
  leanBackDegrees,
  leanToBarFraction,
  simulatedLeanAt,
  type MotionSample,
} from '../lib/tilt';
import { createSteadyHold, lineupStatus, type LineupStatus } from '../lib/lineup';
import { LINEUP_ANNOUNCEMENTS, LINEUP_HINTS, createCuePacer } from '../lib/session-feedback';
import {
  ALL_CAPTURED_LINE,
  angleIntroLine,
  countdownLine,
  ESCAPE_LINE,
  nextAngleLine,
  RECORDED_LINES,
  TILT_FALLBACK_LINE,
  voiceClipKeyFor,
  type VoiceClipKey,
} from '../lib/session-lines';
import { OUTLINE_PATHS } from '../components/patient/BodyOutline';
import { decodeBase64, decodePngToLuma, probeCameraFrame } from '../lib/photo-probe';
import { progressPhotoDisplayUrl, uploadGuidedShots } from '../lib/progress-photo-upload';
import { setConnectivityOverride } from '../lib/connectivity';
import { ENROLLMENT_DAYS, TODAY_KEY } from '../data/patient-data';
import { localTodayKey } from '../lib/live-patient-entry';
import * as SessionModule from '../components/patient/GuidedPhotoSession';
import { PatientProvider, usePatient } from '../context/PatientContext';
import { WRITE_QUEUE_TUNING } from '../lib/patient-write-queue';
import {
  PatientAccountContext,
  type PatientAccountState,
  type PatientDataApi,
  type PatientServerState,
  type ProgressPhotoWire,
} from '../context/PatientAccountContext';
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

/**
 * Waits like `waitUntil`, but keeps a propped phone's gravity feed running
 * underneath — a still device reports ~20 samples a second, and the
 * session treats a gap in that feed as "the phone is being moved".
 */
async function waitUntilHolding(
  label: string,
  predicate: () => boolean,
  leanDeg: number,
  timeoutMs = 8000,
): Promise<boolean> {
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
    await actSettle(() => motionState.emitLean(leanDeg));
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

/** textOf with runs of whitespace collapsed — interpolated JSX text ("{n} of
 * {total}") arrives as separate children, so raw textOf double-spaces it. */
function compactText(node: TInstance | null): string {
  return textOf(node).replace(/\s+/g, ' ').trim();
}

/**
 * Resolves a RN style prop — a function (Pressable), an array, or a plain
 * object — into the single flat object the platform would apply.
 */
function flattenStyle(style: unknown): Record<string, unknown> {
  const resolved = typeof style === 'function' ? (style as (s: unknown) => unknown)({ pressed: false }) : style;
  const out: Record<string, unknown> = {};
  const visit = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === 'object') Object.assign(out, value as Record<string, unknown>);
  };
  visit(resolved);
  return out;
}

/** Pose illustrations currently drawn on screen (the web feed used one). */
function countPoseImages(renderer: TRenderer): number {
  return renderer.root.findAll(node => node.type === 'ExpoImage').length;
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

// ── No-network guard ─────────────────────────────────────────────────────
// The demo persona never touches the network: guided saves keep their shots
// on-device, and only a signed-in account uploads — through its own media
// rail, which section 10 fakes in-process. Any fetch here is a regression,
// so the guard records it and throws.
const fetchCalls: string[] = [];

globalThis.fetch = (async (input: unknown, init?: Record<string, any>) => {
  const url =
    typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input);
  const method = String(init?.method ?? 'GET').toUpperCase();
  fetchCalls.push(`${method} ${url}`);
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
  speechState.reset();
  screenReaderState.reset();
  clearRouterCalls();
  fetchCalls.length = 0;
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

/** Everything the guided flow touches on the account rail, recorded. */
interface FakeRail {
  state: PatientAccountState;
  uploads: string[];
  photoWrites: ProgressPhotoWire[][];
  /** 1-based upload call numbers that reject. */
  failUploadsAt: Set<number>;
  /** 1-based grid-write call numbers that reject. */
  failPhotoWritesAt: Set<number>;
  /** Paths handed to cleanupProgressUploads, one entry per call. */
  cleanups: string[][];
}

/**
 * A signed-in account for the session to save through: a hand-built
 * PatientDataApi whose rail methods record calls and mint object paths, so
 * the REAL component + context stack runs with zero network. Methods the
 * guided flow never touches are absent on purpose — reaching one is a bug
 * this suite should crash on.
 */
function makeFakeRail(): FakeRail {
  const uploads: string[] = [];
  /** Upload id each rail call pinned (null = unpinned). */
  const uploadIds: Array<string | null> = [];
  const photoWrites: ProgressPhotoWire[][] = [];
  const failUploadsAt = new Set<number>();
  const failPhotoWritesAt = new Set<number>();
  const cleanups: string[][] = [];
  const emptyState: PatientServerState = {
    entries: [],
    water: {},
    targets: {},
    favorites: [],
    recents: [],
    customFoods: [],
    savedRecipes: [],
    photos: [],
    checkIns: [],
    flags: {
      nudgeOptOut: false,
      nudgeEngaged: false,
      nudgeLastSentKey: null,
      nudgeLastCrossingKey: null,
      onboardingComplete: false,
    },
  };
  const api = {
    async fetchState() {
      return emptyState;
    },
    async uploadProgressPhoto(dataUri: string, options?: { uploadId?: string }) {
      const call = uploads.push(dataUri);
      uploadIds.push(options?.uploadId ?? null);
      if (failUploadsAt.has(call)) throw new Error('The photo upload was declined.');
      const photoPath = `/objects/patient-media/p-real/progress-${call}`;
      return { photoPath, photoUri: progressPhotoDisplayUrl(photoPath) };
    },
    async writeProgressPhotos(photos: ProgressPhotoWire[]) {
      const call = photoWrites.push(photos);
      if (failPhotoWritesAt.has(call)) {
        throw new Error('Couldn’t save your photos right now. Please try again.');
      }
    },
    async cleanupProgressUploads(paths: string[]) {
      cleanups.push(paths);
    },
  } as unknown as PatientDataApi;
  return {
    state: {
      resolving: false,
      account: { kind: 'real', patientId: 'p-real', api },
      accountNotice: null,
      retryResolve: () => {},
    },
    uploads,
    uploadIds,
    photoWrites,
    failUploadsAt,
    failPhotoWritesAt,
    cleanups,
  };
}

/** Drops the fake account's persisted offline queue/snapshot between sections. */
function clearQueueStorage(): void {
  for (const key of Array.from(localStore.keys())) {
    if (key.includes(':queue_') || key.includes(':snapshot_') || key.includes(':blob_')) {
      localStore.delete(key);
    }
  }
}

/** mountSession, but signed in: the fake account rail wraps the tree. */
async function mountRealSession(rail: FakeRail): Promise<MountedSession> {
  const outcomes: Array<GuidedSessionOutcome | null> = [];
  let renderer!: TRenderer;
  await actSettle(() => {
    renderer = TestRendererCreate(
      h(
        PatientAccountContext.Provider,
        { value: rail.state },
        h(
          PatientProvider,
          null,
          h(PatientProbe),
          h(GuidedPhotoSession, { onSettle: outcome => outcomes.push(outcome) }),
        ),
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

function holdLostPlayer(): StubAudioPlayer | null {
  return (
    audioState.players.find(p => (p.source as { sound?: string })?.sound === 'hold-lost') ??
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
  setGuidedHoldMs(120);
  setGuidedGateTickMs(10);
  setGuidedEscapeMs(60000); // escape hatch stays out of the way unless a scenario wants it
  setGuidedStatusConfirmMs(30); // verdicts still have to persist, just briefly
  setGuidedCueSettleMs(5);
  setGuidedSpeechGuardMs(1000);
  setGuidedVoiceHandoffMs(5); // the camera hands the audio over instantly here
  // Under a full render tree a 50 ms sensor loop can slip; scenarios that
  // exercise the settling behaviour lower this deliberately.
  setGuidedMotionStaleMs(2000);

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
    const readings: PositioningReading[] = [];
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
    assertEqual(readings[6].readyStreak, 3, 'streak counts consecutive ready probes');
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

    // The steady gate can hold for many seconds: a ready subject standing
    // still must NEVER dissolve into the background, however many probes
    // pass. (Before the freeze, ABSORB_PROBES identical frames would eat
    // the patient and flip the reading back to not-detected.)
    let frozen = afterReset;
    for (let i = 0; i < ABSORB_PROBES * 3; i++) frozen = walk.push(makeSimulatedFrame(6));
    assertEqual(frozen.status, 'ready', 'still subject stays detected far past ABSORB_PROBES');
    assert(
      frozen.readyStreak >= ABSORB_PROBES * 3,
      'ready streak keeps counting through the freeze',
      frozen.readyStreak,
    );

    // …and because the background never absorbed them, the person leaving
    // reads not-detected on the very next probe.
    assertEqual(
      walk.push(makeSimulatedFrame(0)).status,
      'not-detected',
      'vacated scene reads not-detected immediately',
    );

    // Non-ready scene changes still get adopted: the at-phone close-up
    // vacating re-learns as background after ABSORB_PROBES.
    const moved = createSubjectDetector();
    moved.push(customFrame(18, 24, 70)); // seeded with the at-phone close-up
    let sceneReading = moved.push(customFrame(18, 24, 150));
    assertEqual(sceneReading.status, 'too-close', 'whole-frame change first reads too-close');
    for (let i = 0; i < ABSORB_PROBES + 2 && sceneReading.status !== 'not-detected'; i++) {
      sceneReading = moved.push(customFrame(18, 24, 150));
    }
    assertEqual(sceneReading.status, 'not-detected', 'scene change absorbs after ABSORB_PROBES');

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

  // ── 3. Tilt model ──────────────────────────────────────────────────────
  section('3. Tilt model: signed lean, zones, bar mapping, smoothing, sim');
  {
    const G = 9.81;
    const grav = (leanDeg: number): MotionSample => ({
      gravityY: G * Math.cos((leanDeg * Math.PI) / 180),
      gravityZ: G * Math.sin((leanDeg * Math.PI) / 180),
    });

    for (const lean of [-30, -8, -1.6, 0, 5, 12, 15, 18, 25, 40]) {
      const measured = leanBackDegrees(grav(lean));
      assert(
        measured !== null && Math.abs(measured - lean) < 0.001,
        `gravity lean ${lean}° measures signed and continuous`,
        measured,
      );
    }

    // Apple-style (un-negated) gravity lands 180° away — the hemisphere
    // fold brings a clearly propped phone back to its true lean.
    const flipped = grav(15);
    const folded = leanBackDegrees({
      gravityY: -(flipped.gravityY as number),
      gravityZ: -(flipped.gravityZ as number),
    });
    assert(
      folded !== null && Math.abs(folded - 15) < 0.001,
      'far-hemisphere gravity folds back to the true lean',
      folded,
    );

    // Weak gravity (device shaken / freefall) is untrusted → NO signal.
    // There is deliberately no rotation.beta fallback: iOS beta folds at
    // 90°, so a face-down phone reports the same beta as a leaned-back one
    // and a beta-derived lean could fabricate green face-down. A degraded
    // sensor path must read null — never a guess.
    assertEqual(
      leanBackDegrees({ gravityY: 0.3, gravityZ: 0.1 }),
      null,
      'weak gravity yields null — nothing may invent a lean',
    );

    // THE demo-run regression, restated on the trusted signal: the two
    // poses that share a folded beta measure with OPPOSITE gravity signs.
    const faceDown = leanBackDegrees(grav(-8));
    const leanedBack = leanBackDegrees(grav(8));
    assert(
      faceDown !== null && faceDown < TILT_FACE_DOWN_DEG,
      'face-down phone reads negative from gravity alone',
      faceDown,
    );
    assert(
      leanedBack !== null && Math.abs(leanedBack - 8) < 0.001,
      'leaned-back phone reads +8° from the mirrored gravity',
      leanedBack,
    );
    assertEqual(leanBackDegrees({}), null, 'no usable signal → null');

    // Zones: green only inside the tight leaned-back band.
    const zoneCases: Array<[number, string]> = [
      [-30, 'face-down'],
      [-2, 'face-down'],
      [-1, 'tilt-back'],
      [0, 'tilt-back'],
      [11.9, 'tilt-back'],
      [12, 'ready'],
      [15, 'ready'],
      [18, 'ready'],
      [18.1, 'too-far'],
      [40, 'too-far'],
    ];
    for (const [lean, zone] of zoneCases) {
      assertEqual(classifyLean(lean), zone, `zone at ${lean}°`);
    }
    assert(
      TILT_READY_MAX_DEG - TILT_READY_MIN_DEG <= 6,
      'ready band is tight (a few degrees)',
      TILT_READY_MAX_DEG - TILT_READY_MIN_DEG,
    );
    assert(
      TILT_READY_MIN_DEG > 0 &&
        TILT_IDEAL_DEG > TILT_READY_MIN_DEG &&
        TILT_IDEAL_DEG < TILT_READY_MAX_DEG,
      'ideal lean sits inside a leaned-BACK band (never upright or forward)',
    );

    // Bar mapping: continuous and strictly monotonic — the level glides.
    assertEqual(leanToBarFraction(TILT_IDEAL_DEG), 0.5, 'ideal lean centers the bar');
    assertEqual(leanToBarFraction(TILT_BAR_TOP_DEG), 0, 'max displayed lean pins the top');
    assertEqual(leanToBarFraction(TILT_BAR_BOTTOM_DEG), 1, 'min displayed lean pins the bottom');
    let previous = leanToBarFraction(TILT_BAR_BOTTOM_DEG);
    let monotonic = true;
    for (let lean = TILT_BAR_BOTTOM_DEG + 0.1; lean <= TILT_BAR_TOP_DEG; lean += 0.1) {
      const fraction = leanToBarFraction(lean);
      if (!(fraction < previous)) {
        monotonic = false;
        break;
      }
      previous = fraction;
    }
    assert(monotonic, 'bar fraction moves for every 0.1° — continuous, never stepped');

    // Smoother: glides toward samples, converges, resets clean.
    const smoother = createLeanSmoother();
    assertEqual(smoother.value(), null, 'smoother starts empty');
    assertEqual(smoother.push(10), 10, 'first sample passes through raw');
    const eased = smoother.push(20);
    assert(eased > 10 && eased < 20, 'smoother eases toward new samples', eased);
    let settled = eased;
    for (let i = 0; i < 40; i++) settled = smoother.push(20);
    assert(Math.abs(settled - 20) < 0.01, 'smoother converges on a held angle', settled);
    smoother.reset();
    assertEqual(smoother.value(), null, 'reset clears the smoother');

    // Scripted web lean: starts tipped forward, settles inside the band,
    // keeps floating (never parks) without leaving the band.
    assert(
      simulatedLeanAt(0) < TILT_FACE_DOWN_DEG,
      'sim lean starts tipped forward (face-down guidance shows first)',
      simulatedLeanAt(0),
    );
    const midway = simulatedLeanAt(SIM_LEAN_SETTLE_MS / 2);
    assert(
      midway > simulatedLeanAt(0) && midway < TILT_READY_MIN_DEG,
      'sim lean eases back through the middle',
      midway,
    );
    for (const at of [SIM_LEAN_SETTLE_MS, SIM_LEAN_SETTLE_MS + 500, SIM_LEAN_SETTLE_MS * 3]) {
      const lean = simulatedLeanAt(at);
      assert(
        lean > TILT_READY_MIN_DEG && lean < TILT_READY_MAX_DEG,
        `sim lean in-band at ${at}ms`,
        lean,
      );
    }
    assert(
      Math.abs(simulatedLeanAt(SIM_LEAN_SETTLE_MS + 200) - simulatedLeanAt(SIM_LEAN_SETTLE_MS + 700)) > 0.01,
      'settled sim lean still wobbles like a live sensor',
    );
  }

  // ── 4. Line-up gate ────────────────────────────────────────────────────
  section('4. Line-up gate: status priority + steady hold');
  {
    const readyReading: PositioningReading = {
      status: 'ready',
      meanLuma: 128,
      bodyHeightFraction: 0.7,
      centerOffsetFraction: 0,
      readyStreak: 1,
    };
    const tooFarReading: PositioningReading = { ...readyReading, status: 'too-far' };

    assertEqual(
      lineupStatus({ leanDeg: -6, tiltAvailable: true, reading: readyReading, probesAvailable: true }),
      'tilt-face-down',
      'face-down outranks a ready frame',
    );
    assertEqual(
      lineupStatus({ leanDeg: 5, tiltAvailable: true, reading: readyReading, probesAvailable: true }),
      'tilt-back-more',
      'under-leaned outranks framing',
    );
    assertEqual(
      lineupStatus({ leanDeg: 30, tiltAvailable: true, reading: readyReading, probesAvailable: true }),
      'tilt-too-far',
      'over-leaned outranks framing',
    );
    assertEqual(
      lineupStatus({ leanDeg: 15, tiltAvailable: true, reading: tooFarReading, probesAvailable: true }),
      'too-far',
      'green tilt lets framing speak',
    );
    assertEqual(
      lineupStatus({ leanDeg: 15, tiltAvailable: true, reading: readyReading, probesAvailable: true }),
      'ready',
      'green tilt + ready frame = ready',
    );
    assertEqual(
      lineupStatus({ leanDeg: 15, tiltAvailable: true, reading: null, probesAvailable: false }),
      'ready',
      'probes unavailable → tilt is the whole gate',
    );
    assertEqual(
      lineupStatus({ leanDeg: 2, tiltAvailable: true, reading: null, probesAvailable: false }),
      'tilt-back-more',
      'probes unavailable still respects tilt',
    );
    // A missing live angle is NEVER green — the reviewer regression: a
    // degraded sensor path (beta-only, weak gravity, dead sensor) must not
    // let a perfectly framed patient auto-start at an unknown camera angle.
    assertEqual(
      lineupStatus({ leanDeg: null, tiltAvailable: null, reading: readyReading, probesAvailable: true }),
      'not-detected',
      'tilt undetermined + ready frame stays un-green (quiet intro status)',
    );
    assertEqual(
      lineupStatus({ leanDeg: null, tiltAvailable: false, reading: readyReading, probesAvailable: true }),
      'tilt-unavailable',
      'tilt known unavailable + ready frame → says so, never ready',
    );
    assertEqual(
      lineupStatus({ leanDeg: null, tiltAvailable: false, reading: tooFarReading, probesAvailable: true }),
      'tilt-unavailable',
      'tilt-unavailable outranks framing guidance',
    );
    assertEqual(
      lineupStatus({ leanDeg: null, tiltAvailable: false, reading: null, probesAvailable: false }),
      'tilt-unavailable',
      'nothing at all still never yields ready',
    );
    assertEqual(
      lineupStatus({ leanDeg: null, tiltAvailable: null, reading: null, probesAvailable: null }),
      'not-detected',
      'nothing yet → not-detected',
    );

    const hold = createSteadyHold();
    let snap = hold.update(true, 1000, 5000);
    assertEqual(snap.progress, 0, 'hold starts banking from zero');
    snap = hold.update(true, 3500, 5000);
    assertEqual(snap.progress, 0.5, 'progress tracks continuous time');
    assertEqual(snap.satisfied, false, 'halfway is not satisfied');
    snap = hold.update(true, 6000, 5000);
    assert(snap.progress === 1 && snap.satisfied, 'full steady time satisfies the hold');

    hold.reset();
    hold.update(true, 10000, 5000);
    snap = hold.update(false, 10100, 5000); // 100ms banked < 8% of 5000
    assertEqual(snap.broke, false, 'sub-threshold flicker resets silently');
    assertEqual(snap.progress, 0, 'flicker still zeroes the bank');
    hold.update(true, 10200, 5000);
    snap = hold.update(false, 11000, 5000); // 800ms banked ≥ 8% of 5000
    assertEqual(snap.broke, true, 'losing meaningful banked progress flags a break');
    snap = hold.update(false, 11100, 5000);
    assertEqual(snap.broke, false, 'already-broken stays quiet');
    snap = hold.update(true, 12000, 5000);
    assertEqual(snap.progress, 0, 're-green restarts the bank at zero');
  }

  // ── 5. Guidance maps + outline art ─────────────────────────────────────
  section('5. Guidance maps stay total + outline art');
  {
    const universe: LineupStatus[] = [
      'tilt-unavailable',
      'tilt-face-down',
      'tilt-back-more',
      'tilt-too-far',
      'too-dark',
      'too-bright',
      'not-detected',
      'too-far',
      'too-close',
      'off-center',
      'ready',
    ];
    for (const status of universe) {
      assert(
        typeof LINEUP_HINTS[status] === 'string' && LINEUP_HINTS[status].length > 0,
        `hint exists for ${status}`,
      );
      assert(
        typeof LINEUP_ANNOUNCEMENTS[status] === 'string' && LINEUP_ANNOUNCEMENTS[status].length > 0,
        `announcement exists for ${status}`,
      );
    }
    assertEqual(Object.keys(LINEUP_HINTS).length, universe.length, 'no stray hint keys');
    assertEqual(
      Object.keys(LINEUP_ANNOUNCEMENTS).length,
      universe.length,
      'no stray announcement keys',
    );
    assertEqual(LINEUP_ANNOUNCEMENTS.ready, 'In position. Hold still.', 'ready announcement wording');
    assert(
      /floor/i.test(LINEUP_ANNOUNCEMENTS['tilt-face-down']),
      'face-down announcement names the floor',
    );
    assert(/back/i.test(LINEUP_HINTS['too-close']), 'too-close asks to step back');
    assert(/closer/i.test(LINEUP_HINTS['too-far']), 'too-far asks to come closer');
    assert(
      /start/i.test(LINEUP_HINTS['tilt-unavailable']),
      'tilt-unavailable hint points at the start-anyway escape',
    );

    const joinedByAngle: Record<string, string> = {};
    for (const angle of GUIDED_ANGLES) {
      const paths = OUTLINE_PATHS[angle];
      assert(Array.isArray(paths) && paths.length > 0, `${angle} outline has paths`);
      const joined = paths.join(' ');
      joinedByAngle[angle] = joined;
      assert(
        paths.every(p => p.startsWith('M')), 
        `${angle} outline paths start with a move`,
      );
      assert(
        !/[LHVlhv]/.test(joined),
        `${angle} outline has no straight-line commands (all curves)`,
      );
      const curveCount = (joined.match(/C/g) ?? []).length;
      assert(curveCount >= 12, `${angle} outline is richly curved`, curveCount);
      assert(/Z/.test(joined), `${angle} silhouette closes`);
    }
    assert(
      joinedByAngle.front !== joinedByAngle.side &&
        joinedByAngle.side !== joinedByAngle.back &&
        joinedByAngle.front !== joinedByAngle.back,
      'three distinct silhouettes (front, side, back)',
    );
  }

  // ── 6. PNG decode + probe pipeline ─────────────────────────────────────
  section('6. PNG decode + camera probe');
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

  // ── 7. Upload pipeline units ───────────────────────────────────────────
  section('7. Upload pipeline');
  {
    assertEqual(
      progressPhotoDisplayUrl('/objects/progress-photos/demo-1'),
      'https://guided-photos.internal/api/progress-photos/file?path=%2Fobjects%2Fprogress-photos%2Fdemo-1',
      'legacy display url routes through the read-only file route',
    );
    assertEqual(
      progressPhotoDisplayUrl('/objects/patient-media/p-1/progress-abc'),
      'https://guided-photos.internal/api/patient-media/file?path=%2Fobjects%2Fpatient-media%2Fp-1%2Fprogress-abc',
      'account display url routes through the patient media rail',
    );

    const shots = GUIDED_ANGLES.map(angle => ({
      angle,
      uri: `data:image/jpeg;base64,${Buffer.from(`SHOT-${angle}`).toString('base64')}`,
      width: 900,
      height: 1200,
    }));

    // Demo persona: no uploader. Shots keep their on-device uris, nothing
    // can fail, and the network is never touched (any fetch throws here).
    fetchCalls.length = 0;
    const demo = await uploadGuidedShots(shots);
    assertEqual(demo.failed.length, 0, 'demo save cannot fail');
    assertEqual(demo.uploaded.length, 3, 'three demo refs');
    assert(
      demo.uploaded.every(
        (ref, index) => ref.uri === shots[index].uri && ref.objectPath === undefined,
      ),
      'demo refs keep the capture uri and mint no object path',
    );
    assertEqual(fetchCalls.length, 0, 'demo upload pipeline touches no network');

    // Signed-in account: the injected uploader (the account media rail)
    // receives PREPARED jpegs and hands back per-photo object paths.
    const uploaderCalls: string[] = [];
    const real = await uploadGuidedShots(shots, async dataUri => {
      uploaderCalls.push(dataUri);
      return { photoPath: `/objects/patient-media/p-1/progress-${uploaderCalls.length}` };
    });
    assertEqual(real.failed.length, 0, 'account upload succeeds');
    assertEqual(
      real.uploaded.map(ref => ref.objectPath).join(','),
      '/objects/patient-media/p-1/progress-1,/objects/patient-media/p-1/progress-2,/objects/patient-media/p-1/progress-3',
      'account refs carry the rail object paths in angle order',
    );
    assert(
      real.uploaded.every(ref => ref.uri === undefined),
      'account refs drop the local uri once the object is stored',
    );
    assertEqual(
      uploaderCalls.join('|'),
      shots.map(shot => shot.uri).join('|'),
      'uploader receives one prepared jpeg per shot (bytes preserved by the prep stub)',
    );

    // Per-angle upload failure: the shot is not lost — its ref keeps the
    // prepared data URI and is flagged deferred so addPhotos hands it to the
    // offline queue; the rest land with object paths as before.
    let uploadCall = 0;
    const partial = await uploadGuidedShots(shots, async () => {
      uploadCall += 1;
      if (uploadCall === 2) throw new Error('rail rejected the upload');
      return { photoPath: `/objects/patient-media/p-1/progress-retry-${uploadCall}` };
    });
    assertEqual(partial.failed.length, 0, 'an upload failure is deferred, not failed');
    assertEqual(partial.uploaded.length, 3, 'every angle yields a ref');
    assert(
      partial.uploaded[1].deferred === true &&
        partial.uploaded[1].objectPath === undefined &&
        typeof partial.uploaded[1].uri === 'string',
      'the refused shot keeps its prepared uri as a deferred upload',
    );
    assert(
      partial.uploaded[0].objectPath !== undefined && partial.uploaded[2].objectPath !== undefined,
      'the other angles still land on the rail',
    );

    // Offline device: no upload attempt at all — every shot is deferred.
    setConnectivityOverride(false);
    let offlineCalls = 0;
    const offline = await uploadGuidedShots(shots, async () => {
      offlineCalls += 1;
      return { photoPath: '/objects/patient-media/p-1/never' };
    });
    setConnectivityOverride(null);
    assertEqual(offlineCalls, 0, 'offline save never calls the uploader');
    assertEqual(offline.failed.length, 0, 'offline save fails nothing');
    assert(offline.uploaded.every(ref => ref.deferred === true && typeof ref.uri === 'string'), 'offline refs are all deferred');

    // Pinned upload ids: the uploader receives one per angle, stored and
    // deferred refs both carry it, so a cut-off upload and its later queued
    // retry name the same server object.
    const pinnedIds: Array<string | undefined> = [];
    let pinnedCall = 0;
    const pinned = await uploadGuidedShots(
      shots,
      async (_uri, options) => {
        pinnedCall += 1;
        pinnedIds.push(options?.uploadId);
        if (pinnedCall === 3) throw new Error('response lost');
        return { photoPath: `/objects/patient-media/p-1/progress-pinned-${pinnedCall}` };
      },
      angle => `gp_test.${angle}`,
    );
    assertEqual(pinnedIds.join(','), 'gp_test.front,gp_test.side,gp_test.back', 'the uploader is handed the per-angle upload id');
    assert(
      pinned.uploaded.every(ref => ref.uploadId === `gp_test.${ref.angle}`),
      'stored AND deferred refs carry their upload id',
    );
    assert(pinned.uploaded[2].deferred === true && pinned.uploaded[2].uploadId === 'gp_test.back', 'the cut-off shot is deferred with its id intact');
    // Without an id provider (demo) nothing is pinned.
    assert(offline.uploaded.every(ref => ref.uploadId === undefined), 'no ids without a provider');
  }

  // ── 8. Web demo: full auto session ─────────────────────────────────────
  section('8. Web demo: setup → line-up gate → countdown ×3 → review');
  let webSession: MountedSession;
  {
    await resetScenario('web');
    webSession = await mountSession();
    const { renderer } = webSession;

    await waitUntil('setup card appears', () => present(renderer, 'guided-begin'));
    assert(present(renderer, 'guided-hide-instructions'), 'hide-instructions checkbox present');
    assert(!present(renderer, 'guided-level-bar'), 'level bar waits for the live stage');
    const setupCopy = surfaceText(renderer);
    assert(/floor/i.test(setupCopy), 'setup mentions floor placement');
    assert(/six feet|6 feet/i.test(setupCopy), 'setup mentions six feet');
    assert(/front camera/i.test(setupCopy), 'setup mentions front camera');
    assert(/level bar|line up|line-up/i.test(setupCopy), 'setup mentions the line-up stage');

    await tap(renderer, 'guided-begin', 'tap Start session');
    await waitUntil('positioning stage shows angle banner', () =>
      present(renderer, 'guided-angle-banner'),
    );
    assert(/front/i.test(textOf(byTestID(renderer, 'guided-angle-banner'))), 'banner names FRONT');
    assert(present(renderer, 'guided-outline'), 'body outline overlay present');
    assert(present(renderer, 'guided-positioning-hint'), 'guidance hint band present');
    assert(
      !present(renderer, 'guided-start-anyway'),
      'no escape button while the gate is fresh — nothing shoots early',
    );
    assert(!present(renderer, 'guided-countdown'), 'countdown gated behind line-up');
    assert(
      announcements.some(a => a.startsWith('Front photo first.')),
      'positioning intro announced',
    );

    await waitUntil('level bar appears over the live preview', () =>
      present(renderer, 'guided-level-bar'),
    );
    await waitUntil('level readout shows continuous degrees', () =>
      /-?\d+\.\d°/.test(textOf(byTestID(renderer, 'guided-level-bar'))),
    );
    await waitUntil('gate goes green (ready hint shows)', () =>
      textOf(byTestID(renderer, 'guided-positioning-hint')).includes('hold still'),
    );

    await waitUntil('steady hold auto-starts the countdown', () =>
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
    assert(
      present(renderer, 'guided-outline'),
      'outline stays on screen (dimmed) behind the countdown numeral',
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

    // Spoken cues ride the same messages as the announcements. The closing
    // line waits a beat for the camera to hand the audio over, so give the
    // handover its (shortened) moment before looking for it.
    await actSleep(30);

    assert(
      speechState.spoken.some(t => t.startsWith('Front photo first.')),
      'line-up intro spoken aloud',
    );
    assert(speechState.spoken.includes('In position. Hold still.'), 'ready cue spoken aloud');
    assert(
      speechState.spoken.includes('All photos captured. Review your shots.'),
      'review arrival spoken aloud',
    );

    for (const angle of GUIDED_ANGLES) {
      const image = renderer.root.findAll(
        node =>
          typeof node.type === 'string' && node.props?.source?.uri === `asset://pose-${angle}`,
      );
      assert(image.length > 0, `review shows ${angle} shot from demo asset`);
    }
  }

  // ── 9. Web demo: reshoot side only, then save ──────────────────────────
  section('9. Per-angle reshoot + save');
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

    fetchCalls.length = 0;
    const photosBefore = patientCtx!.photos.length;
    await tap(renderer, 'guided-review-save', 'tap Save');
    assert(announcements.includes('Saving your photos.'), 'saving announced');
    await waitUntil('session settles with an outcome', () => outcomes.length === 1);
    assert(
      outcomes[0] !== null && outcomes[0]!.savedCount === 3,
      'outcome reports 3 saved photos',
      JSON.stringify(outcomes[0]),
    );
    assertEqual(fetchCalls.length, 0, 'demo save never touches the network');
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
      assert(
        typeof entry.uri === 'string' && (entry.uri as string).length > 0,
        `${angle} entry keeps its on-device uri`,
      );
      assertEqual(entry.objectPath, undefined, `${angle} entry mints no object path (demo)`);
      assertEqual(
        entry.label,
        `Week ${week} ${GUIDED_ANGLE_LABELS[angle]}`,
        `${angle} entry label`,
      );
      // Demo persona stays byte-identical on the seeded anchor day.
      assertEqual(entry.dateKey, TODAY_KEY, `${angle} entry dated today`);
    }
    await actSettle(() => webSession.renderer.unmount());
  }

  // ── 10. Account save: rail failure → shot deferred to the offline queue ──
  // A refused upload no longer blocks Save: the session records every shot
  // at once (stored shots by object path, the refused one by its prepared
  // bytes) and the account's write queue uploads the deferred shot itself.
  section('10. Account save: rail failure defers the shot; the queue uploads it');
  {
    await resetScenario('web');
    clearQueueStorage();
    WRITE_QUEUE_TUNING.baseDelayMs = 5;
    WRITE_QUEUE_TUNING.maxDelayMs = 20;
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1'); // also exercises skip-straight-to-capture
    const rail = makeFakeRail();
    rail.failUploadsAt.add(2); // shots upload in angle order → call #2 is Side
    const { renderer, outcomes } = await mountRealSession(rail);

    await waitUntil('hidden instructions skip straight to positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    assert(!present(renderer, 'guided-begin'), 'setup card skipped for returning user');
    await waitUntil('auto session reaches review', () => present(renderer, 'guided-review-save'));

    await tap(renderer, 'guided-review-save', 'save with the Side upload failing');
    await waitUntil('save settles despite the refused upload', () => outcomes.length === 1);
    assert(
      outcomes[0] !== null && outcomes[0]!.savedCount === 3,
      'outcome reports all three photos saved',
    );
    assert(!present(renderer, 'guided-upload-error'), 'no inline upload error for a deferred shot');
    assertEqual(
      countAnnounced('3 progress photos saved. They will upload when you are back online.'),
      1,
      'save announces the deferred upload in plain words',
    );
    assert(rail.uploads.length >= 3, 'every shot attempted the account rail at save');
    assert(
      rail.uploads.every(uri => uri.startsWith('data:image/jpeg;base64,')),
      'the rail receives prepared jpeg data uris',
    );
    assert(
      GUIDED_ANGLES.every(angle =>
        patientCtx!.photos.some(photo => (photo as { angle?: string }).angle === angle),
      ),
      'all three angles are on the grid immediately',
    );

    // The queue: one grid write for the two stored shots, then the deferred
    // Side shot is uploaded and recorded on its own.
    await waitUntil('the queue re-uploads the deferred shot', () => rail.uploads.length === 4);
    await waitUntil('the queue records the deferred shot', () => rail.photoWrites.length === 2);
    await actSleep(30);
    assertEqual(
      (rail.photoWrites[0] ?? []).map(photo => photo.angle).join(','),
      'front,back',
      'first grid write carries the two stored shots in order',
    );
    assertEqual(
      (rail.photoWrites[1] ?? []).map(photo => photo.angle).join(','),
      'side',
      'the deferred shot follows in its own grid write',
    );
    // Every in-session upload was pinned to a (session, angle) id, and the
    // queue's re-upload of the deferred Side shot re-used Side's id exactly:
    // if the refused call had in fact landed server-side, the retry lands on
    // that same object instead of leaking a second one.
    assert(
      rail.uploadIds.slice(0, 3).every((id, index) => typeof id === 'string' && id.endsWith(`.${GUIDED_ANGLES[index]}`)),
      'in-session uploads pin a per-angle upload id',
    );
    assertEqual(
      rail.uploadIds[3],
      rail.uploadIds[1],
      'the queued re-upload re-uses the deferred shot’s session upload id',
    );
    assert(
      new Set(rail.uploadIds.slice(0, 3).map(id => id?.split('.')[0])).size === 1,
      'all angles share one session prefix',
    );
    const railWeek = Math.ceil(ENROLLMENT_DAYS / 7);
    assert(
      rail.photoWrites.flat().every(
        photo =>
          typeof photo.id === 'string' &&
          photo.id.length > 0 &&
          photo.dateKey === localTodayKey() &&
          photo.label ===
            `Week ${railWeek} ${GUIDED_ANGLE_LABELS[photo.angle as (typeof GUIDED_ANGLES)[number]]}` &&
          typeof photo.objectPath === 'string' &&
          photo.objectPath.startsWith('/objects/patient-media/p-real/progress-'),
      ),
      'grid write rows carry ids, labels, dates, and rail object paths',
    );
    assert(
      rail.photoWrites.flat().every(photo => !('uri' in photo) || photo.uri === undefined),
      'no photo bytes ride a grid write',
    );
    assert(
      GUIDED_ANGLES.every(angle =>
        patientCtx!.photos.some(
          photo =>
            (photo as { angle?: string }).angle === angle &&
            String((photo as { objectPath?: string }).objectPath ?? '').startsWith(
              '/objects/patient-media/p-real/progress-',
            ),
        ),
      ),
      'patient grid rows reference the stored objects once synced',
    );
    assertEqual(rail.cleanups.length, 0, 'a completed save never discards its own uploads');
    assertEqual(fetchCalls.length, 0, 'the in-process rail means zero raw fetches');
    await actSettle(() => renderer.unmount());
  }

  // ── 10b. Account save: grid-write failure → queued, retried, lands ──────
  section('10b. Account save: grid-write failure queues the write; the retry lands');
  {
    await resetScenario('web');
    clearQueueStorage();
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1');
    const rail = makeFakeRail();
    rail.failPhotoWritesAt.add(1); // uploads land; the FIRST grid write fails
    const { renderer, outcomes } = await mountRealSession(rail);
    await waitUntil('auto session reaches review', () => present(renderer, 'guided-review-save'));

    await tap(renderer, 'guided-review-save', 'save with the grid write failing');
    await waitUntil('save settles — the grid row is queued, not lost', () => outcomes.length === 1);
    assert(
      outcomes[0] !== null && outcomes[0]!.savedCount === 3,
      'outcome reports the full set of three',
    );
    assertEqual(countAnnounced('3 progress photos saved.'), 1, 'plain success announcement (no deferral)');
    assertEqual(rail.uploads.length, 3, 'all three uploads landed');
    await waitUntil('the queue retries the grid write', () => rail.photoWrites.length === 2);
    await actSleep(30);
    assertEqual(
      (rail.photoWrites[1] ?? []).map(photo => photo.angle).join(','),
      'front,side,back',
      'the retried grid write carries all three angles',
    );
    assertEqual(rail.cleanups.length, 0, 'a queued save never discards its own uploads');
    await actSettle(() => renderer.unmount());
  }

  // ── 10c. Offline save: nothing touches the rail until connectivity ──────
  section('10c. Offline save queues every shot; reconnecting uploads and records them');
  {
    await resetScenario('web');
    clearQueueStorage();
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1');
    const rail = makeFakeRail();
    const { renderer, outcomes } = await mountRealSession(rail);
    await waitUntil('auto session reaches review', () => present(renderer, 'guided-review-save'));

    setConnectivityOverride(false);
    await tap(renderer, 'guided-review-save', 'save while offline');
    await waitUntil('offline save settles', () => outcomes.length === 1);
    assert(outcomes[0] !== null && outcomes[0]!.savedCount === 3, 'offline save reports three photos');
    assertEqual(
      countAnnounced('3 progress photos saved. They will upload when you are back online.'),
      1,
      'offline save says the photos will upload later',
    );
    await actSleep(60);
    assertEqual(rail.uploads.length, 0, 'offline: the rail is never called');
    assertEqual(rail.photoWrites.length, 0, 'offline: no grid write is attempted');
    assert(
      GUIDED_ANGLES.every(angle =>
        patientCtx!.photos.some(
          photo =>
            (photo as { angle?: string }).angle === angle &&
            typeof (photo as { uri?: string }).uri === 'string',
        ),
      ),
      'offline: all three shots are on the grid from their local bytes',
    );

    setConnectivityOverride(true);
    await waitUntil('reconnecting uploads every shot', () => rail.uploads.length === 3);
    await waitUntil('reconnecting records every shot', () => rail.photoWrites.length === 3);
    await actSleep(30);
    assertEqual(
      rail.photoWrites.map(write => write.map(photo => photo.angle).join(',')).join('|'),
      'front|side|back',
      'shots are recorded in capture order, one grid write each',
    );
    assert(
      GUIDED_ANGLES.every(angle =>
        patientCtx!.photos.some(
          photo =>
            (photo as { angle?: string }).angle === angle &&
            String((photo as { objectPath?: string }).objectPath ?? '').startsWith(
              '/objects/patient-media/p-real/progress-',
            ) &&
            (photo as { uri?: string }).uri === undefined,
        ),
      ),
      'once synced the grid rows reference stored objects and drop the local bytes',
    );
    assertEqual(rail.cleanups.length, 0, 'nothing to discard after a clean sync');
    setConnectivityOverride(null);
    await actSettle(() => renderer.unmount());
  }

  // ── 11. Hide-instructions persistence ──────────────────────────────────
  section('11. Hide-instructions checkbox persists');
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

  // ── 12. Escape hatch + screen-reader silence ───────────────────────────
  section('12. Escape hatch appears only after prolonged failure');
  {
    await resetScenario('web');
    setGuidedProbeIntervalMs(400); // slow probes: neither framing nor sim lean can go green quickly
    setGuidedEscapeMs(250);
    screenReaderState.enabled = true; // spoken cues must stay silent under a screen reader
    const { renderer } = await mountSession();
    await waitUntil('setup for escape scenario', () => present(renderer, 'guided-begin'));
    await tap(renderer, 'guided-begin', 'begin session');
    await waitUntil('positioning for escape scenario', () =>
      present(renderer, 'guided-angle-banner'),
    );
    assert(!present(renderer, 'guided-start-anyway'), 'escape hidden while the gate is fresh');
    assert(!present(renderer, 'guided-countdown'), 'countdown still gated');
    await waitUntil('escape appears after the configured delay', () =>
      present(renderer, 'guided-start-anyway'),
    );
    assert(announcedIncluding('start the countdown anyway') > 0, 'escape offer announced');
    assert(!present(renderer, 'guided-countdown'), 'no auto countdown before the tap');
    await tap(renderer, 'guided-start-anyway', 'tap Start anyway');
    await waitUntil('escape starts the countdown', () => present(renderer, 'guided-countdown'));
    assert(
      announcements.includes(
        `In position. Taking the front photo in ${COUNTDOWN_SECONDS} seconds. Hold still.`,
      ),
      'escape start announces countdown',
    );
    assertEqual(
      speechState.spoken.length,
      0,
      'spoken cues suppressed while a screen reader runs',
    );
    assert(announcements.length > 0, 'screen-reader announcements still flow');
    await actSettle(() => renderer.unmount());
    screenReaderState.reset();
    setGuidedProbeIntervalMs(20);
    setGuidedEscapeMs(60000);
  }

  // ── 13. Native: tilt gates the countdown, probes, capture, save ────────
  section('13. Native flow: tilt gates the countdown, cheap probes, save');
  {
    await resetScenario('ios');
    const camera = scriptNativeCamera();
    const { renderer, outcomes } = await mountSession();

    await waitUntil('native setup card', () => present(renderer, 'guided-begin'));
    assertEqual(
      motionState.listeners.size,
      0,
      'no motion listener during setup — the line-up stage owns tilt now',
    );

    await tap(renderer, 'guided-begin', 'native begin');
    await waitUntil('native camera mounts', () => cameraState.mounted > 0);
    const cameraNode = renderer.root.findAll(
      node => typeof node.type === 'string' && node.type === 'CameraView',
    )[0];
    assert(cameraNode !== undefined, 'CameraView rendered');
    assertEqual(cameraNode?.props.facing, 'front', 'front camera selected');

    await waitUntil('motion listener attached for line-up', () => motionState.listeners.size > 0);
    assert(
      motionState.updateIntervals.includes(50),
      'DeviceMotion sampled fast enough for a fluid bar',
      motionState.updateIntervals.join(','),
    );

    // Face-down first — the demo-run regression: frames go ready but the
    // wrong lean must hold the gate shut.
    await actSettle(() => motionState.emitLean(-8));
    await waitUntil('face-down hint shows', () =>
      textOf(byTestID(renderer, 'guided-positioning-hint')).includes('facing the floor'),
    );
    await actSleep(250); // frames are long ready by now; tilt alone blocks
    assert(!present(renderer, 'guided-countdown'), 'face-down phone never starts the countdown');
    assert(announcedIncluding('tipped toward the floor') > 0, 'face-down announced');
    assert(present(renderer, 'guided-level-bar'), 'level bar overlays the live preview');
    assert(
      /-?\d+\.\d°/.test(textOf(byTestID(renderer, 'guided-level-bar'))),
      'live readout shows continuous degrees',
      textOf(byTestID(renderer, 'guided-level-bar')),
    );

    // Lean back into the tight band → smoother settles → gate passes.
    for (let i = 0; i < 10; i++) await actSettle(() => motionState.emitLean(15.5));
    await waitUntil('in-band lean starts the countdown', () =>
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

    fetchCalls.length = 0;
    const photosBefore = patientCtx!.photos.length;
    await tap(renderer, 'guided-review-save', 'native save');
    await waitUntil('native save settles', () => outcomes.length === 1);
    assert(outcomes[0] !== null && outcomes[0]!.savedCount === 3, 'native outcome savedCount 3');
    assertEqual(fetchCalls.length, 0, 'native demo save touches no network');
    assert(
      patientCtx!.photos
        .slice(-3)
        .every(photo => typeof (photo as { uri?: string }).uri === 'string'),
      'native demo grid rows keep their captured uris',
    );
    assertEqual(patientCtx!.photos.length, photosBefore + 3, 'native grid gains 3 photos');
    await actSettle(() => renderer.unmount());
  }

  // ── 14. Native: hold lost resets with a cue ────────────────────────────
  section('14. Losing the hold resets progress with an audible cue');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedHoldMs(2000); // long enough to observe banking, break, and restart
    // This scenario drives motion in bursts rather than a live 20 Hz feed,
    // so the settling window stays out of the way (section 23 owns it).
    setGuidedMotionStaleMs(60000);
    scriptNativeCamera();
    const { renderer } = await mountSession();

    await waitUntil('hold scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    await waitUntil('motion listening for hold scenario', () => motionState.listeners.size > 0);
    for (let i = 0; i < 10; i++) await actSettle(() => motionState.emitLean(15));
    await waitUntil('gate goes green', () =>
      textOf(byTestID(renderer, 'guided-positioning-hint')).includes('hold still'),
    );
    await waitUntil('hold progress becomes visible while banking', () =>
      present(renderer, 'guided-hold-progress'),
    );
    await actSleep(400); // bank ~20% of the 2000ms hold — past the break threshold
    assert(!present(renderer, 'guided-countdown'), 'countdown still gated mid-hold');

    await actSettle(() => motionState.emitLean(-9)); // one push knocks the smoothed lean out of band
    await waitUntil('hold-lost cue plays', () => (holdLostPlayer()?.plays ?? 0) >= 1);
    assert(!present(renderer, 'guided-countdown'), 'break resets — no countdown');
    await waitUntil('hold progress clears after the break', () =>
      !present(renderer, 'guided-hold-progress'),
    );
    // Coaching waits out the confirmation window: a verdict has to persist
    // before the patient is told about it.
    await waitUntil(
      'break re-announces what to fix',
      () => countAnnounced('Lean the phone back a little more.') >= 1,
      2000,
    );

    // Re-green: the bank must restart from zero (full steady time again).
    for (let i = 0; i < 10; i++) await actSettle(() => motionState.emitLean(15));
    const regreenAt = Date.now();
    await waitUntil(
      'countdown only after a fresh full hold',
      () => present(renderer, 'guided-countdown'),
      15000,
    );
    assert(
      Date.now() - regreenAt >= 1500,
      'restarted hold takes the full steady time again',
      Date.now() - regreenAt,
    );
    await actSettle(() => renderer.unmount());
    setGuidedHoldMs(120);
    setGuidedMotionStaleMs(2000);
  }

  // ── 15. Native: capture failure recovers ───────────────────────────────
  section('15. Capture failure recovers into positioning');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    const camera = scriptNativeCamera({ failCaptureAttempts: 1 });
    const { renderer } = await mountSession();

    await waitUntil('failure scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    // The gate now strictly requires a live angle, so prop the phone.
    await waitUntil('failure scenario listening for motion', () => motionState.listeners.size > 0);
    await actSettle(() => motionState.emitLean(15));
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

  // ── 16. Native: probe-unavailable fallbacks ────────────────────────────
  section('16. Probe-unavailable: timed fallback, and tilt-only gate');
  {
    // A) No probes AND no tilt signal → original timed fallback.
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedProbeIntervalMs(100); // widen the window between "unavailable" and the timer
    const camera = scriptNativeCamera({ probeUri: () => null }); // every probe fails
    const { renderer } = await mountSession();

    await waitUntil('fallback announced after repeated probe misses', () =>
      announcedIncluding('Automatic position check unavailable') > 0,
    );
    assert(
      textOf(byTestID(renderer, 'guided-positioning-hint')).includes('Get set'),
      'no-probe hint shows get-set copy',
      textOf(byTestID(renderer, 'guided-positioning-hint')),
    );
    await waitUntil('timed fallback starts the countdown anyway', () =>
      present(renderer, 'guided-countdown'),
    );
    await waitUntil('timed fallback completes all angles', () =>
      present(renderer, 'guided-review-save'),
    );
    assertEqual(camera.captures(), 3, 'captures still fire on the timer');
    assertEqual(
      countAnnounced(
        'Automatic position check unavailable. Get set — the countdown starts on its own in a few seconds.',
      ),
      1,
      'unavailable note announced only once',
    );
    await actSettle(() => renderer.unmount());

    // B) No probes but tilt works → the level gate runs the show instead.
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    const tiltCamera = scriptNativeCamera({ probeUri: () => null });
    const tiltRun = await mountSession();
    await waitUntil('tilt variant reaches positioning', () =>
      present(tiltRun.renderer, 'guided-angle-banner'),
    );
    await waitUntil('motion listening (tilt variant)', () => motionState.listeners.size > 0);
    await actSettle(() => motionState.emitLean(15));
    await waitUntil('tilt-aware unavailable note announced', () =>
      countAnnounced(
        'Automatic position check unavailable. The countdown starts once the phone angle holds steady.',
      ) === 1,
    );
    assertEqual(
      announcedIncluding('starts on its own'),
      0,
      'timed-fallback wording not used when tilt still gates',
    );
    await waitUntil('tilt-only gate starts the countdown', () =>
      present(tiltRun.renderer, 'guided-countdown'),
    );
    await waitUntil('tilt-only session completes all angles', () =>
      present(tiltRun.renderer, 'guided-review-save'),
    );
    assertEqual(tiltCamera.captures(), 3, 'tilt-only gate still captures all three');
    await actSettle(() => tiltRun.renderer.unmount());
    setGuidedProbeIntervalMs(20);
  }

  // ── 17. Native: permission fallback ────────────────────────────────────
  section('17. Permission fallback');
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

  // ── 18. Progress screen entry point ────────────────────────────────────
  section('18. Progress screen entry point + snackbar + grid sources');
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

  // ── 19. Check-in entry point ───────────────────────────────────────────
  section('19. Check-in entry point');
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

  // ── 20. Beta-only motion can never start the countdown ────────────────
  section('20. Native: beta-only motion (no gravity) never auto-starts');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedEscapeMs(300);
    scriptNativeCamera(); // probes WORK and frame a ready subject
    const { renderer } = await mountSession();
    await waitUntil('beta-only: motion listening', () => motionState.listeners.size > 0);

    // A face-down phone whose gravity vector never arrives: rotation-only
    // measurements carrying the folded beta that used to read green.
    const betaTimer = setInterval(() => motionState.emitBetaDegrees(82), 20);
    try {
      await waitUntil('tilt declared unavailable', () =>
        textOf(byTestID(renderer, 'guided-positioning-hint')).includes('Tilt check unavailable'),
      );
      assert(
        announcedIncluding('cannot check its tilt') > 0,
        'tilt-unavailable announced for screen readers',
      );
      assert(!present(renderer, 'guided-level-bar'), 'level bar hidden without a real angle');

      // Frames are ready and betas keep flowing — several full hold
      // windows pass and the gate must stay shut.
      await actSleep(600);
      assert(
        !present(renderer, 'guided-countdown'),
        'beta-only motion never auto-starts the countdown',
      );

      // Only the explicit escape may begin capture.
      await waitUntil('beta-only: escape offered', () => present(renderer, 'guided-start-anyway'));
      await tap(renderer, 'guided-start-anyway', 'beta-only Start anyway');
      await waitUntil('beta-only: escape starts the countdown', () =>
        present(renderer, 'guided-countdown'),
      );
    } finally {
      clearInterval(betaTimer);
    }
    await actSettle(() => renderer.unmount());
    setGuidedEscapeMs(60000);
  }

  // ── 21. Production iOS build config ────────────────────────────────────
  section('21. app.json ships the iOS motion permission');
  {
    // The Node suite stubs expo-sensors, so only this guard notices when
    // the build-time config goes missing: without the expo-sensors plugin
    // (NSMotionUsageDescription) a production iOS build cannot grant the
    // DeviceMotion permission the whole line-up gate depends on.
    const appJson = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
      expo?: { plugins?: unknown[] };
    };
    const plugins = appJson.expo?.plugins ?? [];
    const entry = plugins.find(
      (plugin): plugin is [string, { motionPermission?: unknown }] =>
        Array.isArray(plugin) && plugin[0] === 'expo-sensors',
    );
    assert(entry !== undefined, 'expo-sensors config plugin is registered');
    const motion = entry?.[1]?.motionPermission;
    assert(
      typeof motion === 'string' && motion.trim().length >= 20,
      'motionPermission carries a real usage description',
      motion,
    );
    assert(
      typeof motion === 'string' && /tilt|angle|motion/i.test(motion),
      'permission copy explains the tilt use',
    );
  }

  // ── 22. The spoken coach paces itself ──────────────────────────────────
  section('22. Cue pacer: one voice, no pile-up');
  {
    speechState.reset();
    speechState.autoFinishMs = 30;
    let muted = false;
    const pacer = createCuePacer({
      settleMs: () => 15,
      guardMs: () => 5000,
      muted: () => muted,
    });

    pacer.say(LINEUP_ANNOUNCEMENTS['too-far']);
    pacer.say(LINEUP_ANNOUNCEMENTS['too-close']);
    assertEqual(speechState.spoken.length, 1, 'a second cue waits instead of cutting the first off');
    assert(pacer.isSpeaking(), 'first cue is in flight');
    await actSleep(120);
    assertEqual(
      speechState.spoken.join(' | '),
      `${LINEUP_ANNOUNCEMENTS['too-far']} | ${LINEUP_ANNOUNCEMENTS['too-close']}`,
      'the waiting cue speaks after the settle beat',
    );
    assertEqual(speechState.overlaps, 0, 'no cue ever lands on top of another');
    assertEqual(speechState.stops, 0, 'nothing was cut off mid-sentence');

    // Only the LATEST advice waits: a burst while the mouth is busy
    // collapses to one cue rather than a backlog the patient hears late.
    speechState.reset();
    speechState.autoFinishMs = 30;
    pacer.say(LINEUP_ANNOUNCEMENTS['too-dark']);
    pacer.say(LINEUP_ANNOUNCEMENTS['off-center']);
    pacer.say(LINEUP_ANNOUNCEMENTS['not-detected']);
    pacer.say(LINEUP_ANNOUNCEMENTS['too-bright']);
    await actSleep(140);
    assertEqual(
      speechState.spoken.join(' | '),
      `${LINEUP_ANNOUNCEMENTS['too-dark']} | ${LINEUP_ANNOUNCEMENTS['too-bright']}`,
      'a burst of statuses collapses to the newest advice',
    );

    // A cue whose situation moved on while the previous sentence finished
    // is dropped rather than spoken late.
    speechState.reset();
    speechState.autoFinishMs = 30;
    let stillTrue = true;
    pacer.say(LINEUP_ANNOUNCEMENTS['too-far']);
    pacer.say(LINEUP_ANNOUNCEMENTS['too-close'], { stillTrue: () => stillTrue });
    stillTrue = false;
    await actSleep(120);
    assertEqual(speechState.spoken.length, 1, 'a stale cue is dropped, not spoken late');

    // Saying the same thing twice in a row adds nothing.
    speechState.reset();
    speechState.autoFinishMs = 30;
    pacer.say(LINEUP_ANNOUNCEMENTS['off-center']);
    await actSleep(80);
    pacer.say(LINEUP_ANNOUNCEMENTS['off-center']);
    await actSleep(80);
    assertEqual(speechState.spoken.length, 1, 'an identical repeat is dropped');

    // Capture-critical cues jump the queue and interrupt coaching.
    speechState.reset();
    speechState.autoFinishMs = 5000; // a long coaching sentence, still going
    pacer.say(LINEUP_ANNOUNCEMENTS['not-detected']);
    await actSleep(10);
    pacer.say('In position. Taking the front photo in 7 seconds. Hold still.', { priority: true });
    assertEqual(speechState.spoken.length, 2, 'the priority cue speaks immediately');
    assertEqual(
      speechState.interrupted.join(''),
      LINEUP_ANNOUNCEMENTS['not-detected'],
      'the coaching cue it interrupted was stopped first',
    );
    assertEqual(speechState.overlaps, 0, 'priority still never overlaps');
    pacer.cancel();

    // A platform that never reports the end of an utterance must not mute
    // the coach forever — the guard cuts it and the next cue lands.
    speechState.reset();
    speechState.autoFinishMs = 5000;
    // Nothing reports anything here, length included: this is the blind
    // case the guard exists for.
    speechState.reportsLength = false;
    const guarded = createCuePacer({ settleMs: () => 5, guardMs: () => 40, muted: () => false });
    guarded.say(LINEUP_ANNOUNCEMENTS['too-dark']);
    guarded.say(LINEUP_ANNOUNCEMENTS['too-bright']);
    await actSleep(140);
    assertEqual(speechState.spoken.length, 2, 'the guard releases a stuck utterance');
    assertEqual(speechState.overlaps, 0, 'the stuck utterance was stopped before the next one');
    guarded.cancel();

    // Screen readers: the pacer stays completely silent.
    speechState.reset();
    speechState.autoFinishMs = 5;
    muted = true;
    pacer.say(LINEUP_ANNOUNCEMENTS['too-far']);
    pacer.say('In position. Hold still.', { priority: true });
    await actSleep(40);
    assertEqual(speechState.spoken.length, 0, 'no spoken cues while a screen reader runs');
    muted = false;
    pacer.cancel();
    speechState.reset();
  }

  // ── 23. Band hysteresis + settling level ───────────────────────────────
  section('23. Level: band hysteresis and honest settling');
  {
    // Entering takes the strict band; leaving takes the margin, so a phone
    // resting on an edge cannot flicker. The GATE still uses classifyLean.
    assertEqual(
      inReadyBandDisplay(TILT_READY_MIN_DEG - 0.4, false),
      false,
      'just below the band does not turn the meter green',
    );
    assertEqual(
      inReadyBandDisplay(TILT_READY_MIN_DEG - 0.4, true),
      true,
      'a green meter tolerates a nudge below the band',
    );
    assertEqual(
      inReadyBandDisplay(TILT_READY_MAX_DEG + 0.4, true),
      true,
      'a green meter tolerates a nudge above the band',
    );
    assertEqual(
      inReadyBandDisplay(TILT_READY_MAX_DEG + TILT_BAND_HYSTERESIS_DEG + 0.3, true),
      false,
      'past the margin the meter honestly goes amber',
    );
    assertEqual(
      classifyLean(TILT_READY_MIN_DEG - 0.4),
      'tilt-back',
      'the gate band itself is untouched by display hysteresis',
    );

    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedHoldMs(4000); // stay in line-up long enough to watch the meter
    setGuidedMotionStaleMs(250);
    scriptNativeCamera();
    const { renderer } = await mountSession();
    await waitUntil('settling scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    await waitUntil('settling scenario listening for motion', () => motionState.listeners.size > 0);

    // A propped phone: gravity keeps arriving, so the angle stays live.
    await waitUntilHolding(
      'level reads a live angle',
      () => textOf(byTestID(renderer, 'guided-level-readout')).includes('°'),
      15,
    );
    await waitUntilHolding(
      'steady time banks while the angle is live',
      () => present(renderer, 'guided-hold-progress'),
      15,
    );

    // The phone is picked up: gravity stops being trustworthy, so samples
    // stop arriving. The meter must SAY it is settling rather than freeze
    // on a stale angle, and steady time must not keep banking.
    await waitUntil(
      'level says it is settling while the phone moves',
      () => textOf(byTestID(renderer, 'guided-level-readout')).includes('Settling'),
    );
    assert(
      !present(renderer, 'guided-hold-progress'),
      'steady time does not bank on an angle nobody is measuring',
    );
    assert(!present(renderer, 'guided-countdown'), 'no countdown starts while the phone is moving');

    // Set back down at a different angle: the reading resumes from where
    // the phone actually IS, not blended with where it was before.
    await actSettle(() => motionState.emitLean(5));
    await waitUntil(
      'the level resumes from the real angle after a gap (no stale blend)',
      () => textOf(byTestID(renderer, 'guided-level-readout')).trim() === '5.0°',
      1000,
    );
    await actSettle(() => renderer.unmount());
    setGuidedHoldMs(120);
    setGuidedMotionStaleMs(2000);
  }

  // ── 24. Guides clear once the patient is locked in ─────────────────────
  section('24. Guides fade when locked and return on a break');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedHoldMs(3000); // long enough to watch the fade before the countdown
    setGuidedMotionStaleMs(60000);
    scriptNativeCamera();
    const { renderer } = await mountSession();
    await waitUntil('fade scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    await waitUntil('fade scenario listening for motion', () => motionState.listeners.size > 0);

    const guidesHidden = (): boolean =>
      byTestID(renderer, 'guided-guides')?.props.accessibilityElementsHidden === true;
    /** The wrapper's live opacity (1 = fully drawn, 0 = faded away). */
    const guidesOpacity = (): number => {
      const value = flattenStyle(byTestID(renderer, 'guided-guides')?.props.style).opacity as
        | { value?: number }
        | undefined;
      return typeof value?.value === 'number' ? value.value : Number.NaN;
    };

    assert(present(renderer, 'guided-guides'), 'the guides render during line-up');
    assert(!guidesHidden(), 'guides are visible while the patient is still lining up');
    assertEqual(guidesOpacity(), 1, 'the outline is fully drawn while lining up');
    assert(!present(renderer, 'guided-hold-quiet'), 'no quiet hold indicator before the lock');

    for (let i = 0; i < 8; i++) await actSettle(() => motionState.emitLean(15));
    await waitUntil('fade scenario goes green', () =>
      textOf(byTestID(renderer, 'guided-positioning-hint')).includes('hold still'),
    );
    await waitUntil('guides clear once the hold is banking', guidesHidden);
    assertEqual(guidesOpacity(), 0, 'the outline actually fades off the screen, not just the a11y tree');
    assert(
      present(renderer, 'guided-hold-quiet'),
      'a quiet hold indicator replaces the faded guides',
    );
    assert(!present(renderer, 'guided-countdown'), 'the fade happens before the countdown, not after');

    // Break the angle: the guides must come straight back.
    await actSettle(() => motionState.emitLean(-9));
    await waitUntil('guides return the moment the line-up breaks', () => !guidesHidden());
    assertEqual(guidesOpacity(), 1, 'the outline is fully back the moment the line-up breaks');
    assert(
      !present(renderer, 'guided-hold-quiet'),
      'the quiet indicator goes away with the broken hold',
    );
    await actSettle(() => renderer.unmount());
    setGuidedHoldMs(120);
    setGuidedMotionStaleMs(2000);
  }

  // ── 25. One guide, and a reachable way out ─────────────────────────────
  section('25. One body guide + a reachable close control');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedHoldMs(4000);
    setGuidedMotionStaleMs(60000);
    scriptNativeCamera();
    const { renderer } = await mountSession();
    await waitUntil('exit scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );

    assertEqual(allByTestID(renderer, 'guided-outline').length, 1, 'exactly one body guide (native)');

    const closeStyle = flattenStyle(byTestID(renderer, 'guided-close')?.props.style);
    assert(
      Number(closeStyle.width) >= 44 && Number(closeStyle.height) >= 44,
      'the close control is a finger-sized target',
      JSON.stringify({ width: closeStyle.width, height: closeStyle.height }),
    );
    assert(
      Number(closeStyle.top) >= 44,
      'the close control clears the status bar and the top gesture strip',
      closeStyle.top,
    );
    await tap(renderer, 'guided-close', 'the close control still closes the session');
    await actSettle(() => renderer.unmount());

    // The simulated web feed must not add a second person-shaped guide.
    await resetScenario('web');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1');
    const web = await mountSession();
    await waitUntil('web line-up reached', () => present(web.renderer, 'guided-angle-banner'));
    assertEqual(
      allByTestID(web.renderer, 'guided-outline').length,
      1,
      'exactly one body guide on the simulated feed',
    );
    assertEqual(
      countPoseImages(web.renderer),
      0,
      'the simulated feed no longer draws its own pose illustration behind the outline',
    );
    await actSettle(() => web.renderer.unmount());
    setGuidedHoldMs(120);
    setGuidedMotionStaleMs(2000);
  }

  // ── 26. A screen reader switched on mid-sentence ───────────────────────
  section('26. Turning a screen reader on silences the cue in flight');
  {
    await resetScenario('ios');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    setGuidedHoldMs(4000);
    setGuidedMotionStaleMs(60000);
    speechState.autoFinishMs = 5000; // a long sentence, still being spoken
    scriptNativeCamera();
    const { renderer } = await mountSession();
    await waitUntil('mid-sentence scenario reaches positioning', () =>
      present(renderer, 'guided-angle-banner'),
    );
    await waitUntil('the coach starts talking', () => speechState.spoken.length > 0);
    const spokenBefore = speechState.spoken.length;

    await actSettle(() => screenReaderState.set(true));
    assert(speechState.stops >= 1, 'the sentence in flight is cut, not left running');
    assert(speechState.active === null, 'nothing is being spoken once VoiceOver takes over');

    // And nothing new starts talking over the screen reader.
    await waitUntil('motion listening for mid-sentence scenario', () => motionState.listeners.size > 0);
    for (let i = 0; i < 8; i++) await actSettle(() => motionState.emitLean(15));
    await actSleep(120);
    assertEqual(
      speechState.spoken.length,
      spokenBefore,
      'no further spoken cues while the screen reader runs',
    );
    assert(announcements.length > 0, 'screen-reader announcements still flow');
    await actSettle(() => renderer.unmount());
    screenReaderState.reset();
    speechState.reset();
    setGuidedHoldMs(120);
    setGuidedMotionStaleMs(2000);
  }

  // ── 27. Review: open a shot full screen, page it, mark it, come back ────
  section('27. Full-screen viewer on the review step');
  {
    await resetScenario('web');
    await AsyncStorageStub.setItem(HIDE_INSTRUCTIONS_KEY, '1');
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1');
    const { renderer } = await mountSession();
    await waitUntil('viewer scenario reaches review', () =>
      present(renderer, 'guided-review-save'),
    );

    assert(!present(renderer, 'guided-viewer'), 'the viewer stays closed until a shot is tapped');
    for (const angle of GUIDED_ANGLES) {
      assert(
        present(renderer, `guided-review-open-${angle}`),
        `${angle} thumbnail is tappable on the review card`,
      );
    }

    // Opening on SIDE: the label and position are on screen and spoken.
    await tap(renderer, 'guided-review-open-side', 'tap the side thumbnail');
    assert(present(renderer, 'guided-viewer'), 'the viewer opens full screen');
    assertEqual(textOf(byTestID(renderer, 'guided-viewer-label')), 'Side', 'viewer names the angle');
    assertEqual(
      compactText(byTestID(renderer, 'guided-viewer-position')),
      '2 of 3',
      'viewer shows the position in the set',
    );
    assert(announcements.includes('Side photo. 2 of 3.'), 'opening the viewer is announced');
    assertEqual(
      allByTestID(renderer, 'guided-viewer-page-front').length +
        allByTestID(renderer, 'guided-viewer-page-side').length +
        allByTestID(renderer, 'guided-viewer-page-back').length,
      3,
      'every captured angle is a page — none skipped, none duplicated',
    );

    // Paging forward with the Next control, then back with a real swipe.
    await tap(renderer, 'guided-viewer-next', 'page to the next photo');
    assertEqual(textOf(byTestID(renderer, 'guided-viewer-label')), 'Back', 'next lands on Back');
    assertEqual(
      compactText(byTestID(renderer, 'guided-viewer-position')),
      '3 of 3',
      'position follows',
    );
    assert(announcements.includes('Back photo. 3 of 3.'), 'the page change is announced');
    assertEqual(
      byTestID(renderer, 'guided-viewer-next')?.props['aria-disabled'],
      true,
      'Next is blocked on the last photo',
    );

    const pager = byTestID(renderer, 'guided-viewer-pager');
    assert(pager?.props.pagingEnabled === true, 'the pager snaps one photo per swipe');
    await actSettle(() =>
      pager!.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 0 } } }),
    );
    assertEqual(
      textOf(byTestID(renderer, 'guided-viewer-label')),
      'Front',
      'swiping back to the first page shows Front',
    );
    assert(announcements.includes('Front photo. 1 of 3.'), 'the swipe is announced too');
    assertEqual(
      byTestID(renderer, 'guided-viewer-prev')?.props['aria-disabled'],
      true,
      'Previous is blocked on the first photo',
    );

    // Marking a reshoot from inside the viewer drives the SAME selection
    // the review cards read.
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-viewer-reshoot-front')),
      false,
      'the front photo starts unmarked in the viewer',
    );
    await tap(renderer, 'guided-viewer-reshoot-front', 'mark Front for a reshoot from the viewer');
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-viewer-reshoot-front')),
      true,
      'the viewer toggle shows the mark',
    );
    assertEqual(
      textOf(byTestID(renderer, 'guided-viewer-caption')),
      'Marked for a reshoot',
      'the viewer caption states the mark',
    );
    assert(
      announcements.includes('Front selected for reshoot. 1 selected.'),
      'marking from the viewer announces like the review card does',
    );
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-reshoot-front')),
      true,
      'the review card behind the viewer holds the same selection',
    );

    // Closing returns to the review with the selection intact.
    await tap(renderer, 'guided-viewer-close', 'close the viewer');
    assert(!present(renderer, 'guided-viewer'), 'the viewer is gone');
    assert(present(renderer, 'guided-review-save'), 'the review step is back');
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-reshoot-front')),
      true,
      'the reshoot selection survives closing the viewer',
    );
    assert(
      /\(\s*1\s*\)/.test(textOf(byTestID(renderer, 'guided-review-reshoot'))),
      'the reshoot CTA still counts the selection',
      textOf(byTestID(renderer, 'guided-review-reshoot')),
    );

    // Unmarking from the review card clears the viewer's copy as well.
    await tap(renderer, 'guided-reshoot-front', 'unmark Front from the review card');
    await tap(renderer, 'guided-review-open-front', 'reopen the front photo');
    assertEqual(
      checkedOf(byTestID(renderer, 'guided-viewer-reshoot-front')),
      false,
      'one source of truth: the viewer reflects the card',
    );
    await tap(renderer, 'guided-viewer-close', 'close again');
    await actSettle(() => renderer.unmount());
  }

  // ── 28. The viewer itself is reusable outside the guided session ────────
  section('28. PhotoLightbox stands alone');
  {
    announcements.length = 0;
    let index = 0;
    let closed = 0;
    let renderer!: TRenderer;
    const photos = [
      { key: 'week-1', uri: 'asset://week-1', label: 'Week 1', caption: 'March 3' },
      { key: 'week-6', uri: 'asset://week-6', label: 'Week 6', caption: 'April 7' },
    ];
    const render = () =>
      h(PhotoLightbox, {
        testID: 'lb',
        visible: true,
        photos,
        index,
        onIndexChange: (next: number) => {
          index = next;
        },
        onClose: () => {
          closed += 1;
        },
      });
    await actSettle(() => {
      renderer = TestRendererCreate(render());
    });

    assertEqual(textOf(byTestID(renderer, 'lb-label')), 'Week 1', 'a non-guided caption renders');
    assertEqual(textOf(byTestID(renderer, 'lb-caption')), 'March 3', 'the secondary line renders');
    assertEqual(
      compactText(byTestID(renderer, 'lb-position')),
      '1 of 2',
      'position counts this list',
    );
    assert(announcements.includes('Week 1 photo. 1 of 2.'), 'opening announces the first photo');
    assert(!present(renderer, 'lb-action'), 'no action row without a caller-supplied control');

    await tap(renderer, 'lb-next', 'page a standalone viewer');
    assertEqual(index, 1, 'the caller owns the index');
    await actSettle(() => renderer.update(render()));
    assertEqual(textOf(byTestID(renderer, 'lb-label')), 'Week 6', 'the new page shows');
    assert(announcements.includes('Week 6 photo. 2 of 2.'), 'the page change is announced');

    await tap(renderer, 'lb-close', 'close a standalone viewer');
    assertEqual(closed, 1, 'the caller owns closing');
    await actSettle(() => renderer.unmount());
  }

  // ── 29. The recorded voice: script, clips, and lines that finish ───────
  section('29. Recorded coaching voice');
  {
    // Every sentence the session can say has to be one of the recorded
    // ones. A line that drifts from its clip still gets spoken by the
    // platform robot, which is exactly the regression this catches.
    const spokenByTheSession = [
      ...GUIDED_ANGLES.map(angleIntroLine),
      ...GUIDED_ANGLES.map(countdownLine),
      ...GUIDED_ANGLES.map(nextAngleLine),
      ...Object.values(LINEUP_ANNOUNCEMENTS),
      ESCAPE_LINE,
      TILT_FALLBACK_LINE,
      ALL_CAPTURED_LINE,
    ];
    for (const line of spokenByTheSession) {
      assert(voiceClipKeyFor(line) !== null, `recorded in the coach's voice: "${line}"`);
    }
    assertEqual(
      spokenByTheSession.length,
      Object.keys(RECORDED_LINES).length,
      'no recorded line is dead weight, none is missing',
    );

    // The clips themselves: one real file per line, wired by static
    // require() so Metro bundles them.
    const clipsSource = readFileSync(new URL('../data/guided-voice-clips.ts', import.meta.url), 'utf8');
    for (const key of Object.keys(RECORDED_LINES) as VoiceClipKey[]) {
      const wired = clipsSource.includes(`@/assets/audio/guided/${key}.mp3`);
      assert(wired, `${key} is required from the clips module`);
      let bytes = 0;
      try {
        bytes = statSync(new URL(`../assets/audio/guided/${key}.mp3`, import.meta.url)).size;
      } catch {
        bytes = 0;
      }
      assert(bytes > 4000, `${key}.mp3 is a real recording on disk`, String(bytes));
    }
    const requiredClips = clipsSource.match(/assets\/audio\/guided\/[a-z-]+\.mp3/g) ?? [];
    assertEqual(
      requiredClips.length,
      Object.keys(RECORDED_LINES).length,
      'the clips module wires exactly the recorded script',
    );

    // The bug this fixes: a line longer than the pacer's blind deadline
    // used to be cut off part way through. A recording reports its own
    // length, so the safety net is sized to the audio.
    speechState.reset();
    speechState.autoFinishMs = 300; // a long line, still playing
    const patient = createCuePacer({ settleMs: () => 5, guardMs: () => 40, muted: () => false });
    patient.say(ALL_CAPTURED_LINE, { priority: true });
    await actSleep(150); // well past the blind deadline
    assertEqual(speechState.stops, 0, 'a recorded line is never cut off by the safety net');
    assertEqual(speechState.interrupted.length, 0, 'the closing line is still playing');
    assert(patient.isSpeaking(), 'the pacer knows the line is still going');
    speechState.finish();
    await actSleep(30);
    assert(!patient.isSpeaking(), 'the pacer moves on when the recording actually ends');
    assertEqual(speechState.spoken.length, 1, 'nothing spoke over the closing line');
    patient.cancel();

    // A reshoot started inside the handover window must not be chased by
    // the closing line from the review the patient just left.
    setGuidedVoiceHandoffMs(150);
    await resetScenario('web');
    localStore.set(HIDE_INSTRUCTIONS_KEY, '1'); // straight into capture
    const { renderer: reshootRenderer } = await mountSession();
    await waitUntil('auto session reaches review', () =>
      present(reshootRenderer, 'guided-review-save'),
    );
    setGuidedHoldMs(5000); // the reshoot stays in positioning while we watch
    speechState.reset();
    speechState.autoFinishMs = 5;
    await tap(reshootRenderer, 'guided-reshoot-side', 'select Side');
    await tap(reshootRenderer, 'guided-review-reshoot', 'reshoot before the closing line lands');
    await actSleep(250); // past the handover the closing line was waiting on
    assert(
      present(reshootRenderer, 'guided-angle-banner'),
      'the reshoot is still lining up (the window we care about)',
    );
    assert(
      !speechState.spoken.includes(ALL_CAPTURED_LINE),
      'a cancelled closing line never chases the reshoot',
    );
    await actSettle(() => reshootRenderer.unmount());
    setGuidedHoldMs(120);
    setGuidedVoiceHandoffMs(5);
    localStore.delete(HIDE_INSTRUCTIONS_KEY);

    // Anything unrecorded still gets said rather than lost.
    speechState.reset();
    speechState.autoFinishMs = 5;
    const oddball = createCuePacer({ settleMs: () => 5, guardMs: () => 200, muted: () => false });
    oddball.say('An unrecorded sentence.', { priority: true });
    await actSleep(30);
    assertEqual(
      speechState.spoken.join(''),
      'An unrecorded sentence.',
      'a line without a clip falls back to the platform voice',
    );
    oddball.cancel();
    speechState.reset();
  }

  finish();
}

main().catch(error => {
  console.error('Suite crashed:', error);
  process.exit(1);
});
