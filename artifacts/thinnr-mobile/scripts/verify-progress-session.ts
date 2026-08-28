/**
 * Guided progress-photo session regression check (no AI anywhere).
 *
 * Drives the REAL pieces behind the hands-free three-angle photo flow
 * under Node (tsconfig.progress-session.json maps native-only modules to
 * stubs):
 *
 *   1. Session reducer: countdown ticks, auto-capture handoff, per-angle
 *      reshoot queues in canonical order, save progress/failure phases,
 *      and events arriving in the wrong phase being ignored.
 *   2. No-AI photo analysis: brightness verdicts per shot, cross-shot
 *      differencing for presence/distance, the jpeg-js encode→decode
 *      roundtrip the native path uses, missing-shot flagging, and the
 *      plain-language reasons + preselected reshoot angles the review
 *      screen shows. The web sim's synthetic frames MUST come out clean —
 *      that is the demo path.
 *   3. Session tones: the generated WAV data URIs are valid PCM mono
 *      files (RIFF structure, sane sample rate, exact chunk sizes).
 *   4. Upload client: compress → upload-url → PUT → finalize per angle,
 *      progress callbacks, typed stage/angle failures, and resume that
 *      skips angles already uploaded.
 *   5. Full react-test-renderer runs of GuidedSessionSurface inside the
 *      real PatientProvider on the web (simulated camera) path: spoken
 *      cues and audible ticks, countdown → review with clean verdicts, a
 *      per-angle reshoot run, saving through a scripted fetch into the
 *      patient record (one commit, labeled "Week N · Front/Side/Back"),
 *      a finalize failure surfacing the announced retryable error with
 *      shots intact, and the persisted hide-instructions preference —
 *      including hydrating a legacy snapshot saved before that field
 *      existed.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// PatientContext persists via globalThis.localStorage on the web platform
// path (which the react-native stub reports) — install the shim before any
// component code runs.
const localStore = new Map<string, string>();
const localStorageShim = {
  getItem(key: string): string | null {
    return localStore.has(key) ? (localStore.get(key) as string) : null;
  },
  setItem(key: string, value: string): void {
    localStore.set(key, String(value));
  },
  removeItem(key: string): void {
    localStore.delete(key);
  },
  clear(): void {
    localStore.clear();
  },
  key(index: number): string | null {
    return Array.from(localStore.keys())[index] ?? null;
  },
  get length(): number {
    return localStore.size;
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageShim,
  configurable: true,
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// apiBase() derives the API origin from this at call time.
process.env.EXPO_PUBLIC_DOMAIN = process.env.EXPO_PUBLIC_DOMAIN || 'thinnr-demo.test';

/** The persistence contract the Progress grid and this flow share. */
const PATIENT_STORAGE_KEY = 'thinnr_patient_state_v1';

import {
  ANGLE_META,
  SESSION_ANGLES,
  activeAngle,
  buildPhotoLabel,
  reshootQueue,
  sessionReducer,
  type SessionAngle,
  type SessionPhase,
} from '@/lib/progress-session';
import {
  LIGHTING_MESSAGES,
  MISSING_SHOT_MESSAGE,
  SUBJECT_MESSAGES,
  analyzeSession,
  assessLighting,
  assessSubject,
  base64ToBytes,
  decodeJpegBase64ToGray,
  encodeGrayToJpegBase64,
  type GrayFrame,
} from '@/lib/photo-analysis';
import { buildSimulatedGrayFrame, buildSimulatedShotDataUri } from '@/lib/sim-camera';
import { ALERT_TONE_URI, CAPTURE_TONE_URI, TICK_TONE_URI } from '@/lib/session-tones';
import {
  ProgressUploadError,
  uploadProgressShots,
  type ShotToUpload,
} from '@/lib/progress-upload';
import { TILT_ALMOST_MIN_DEG, TILT_READY_MAX_DEG, TILT_READY_MIN_DEG, classifyTilt } from '@/lib/tilt';
import { PatientProvider, usePatient } from '@/context/PatientContext';
import { ENROLLMENT_DAYS, TODAY_KEY } from '@/data/patient-data';
import { GuidedSessionSurface } from '@/components/patient/GuidedSessionSurface';
import { BodyOutline } from '@/components/patient/BodyOutline';
import { spoken, resetSpeechLog } from 'expo-speech';
import { audioLog, resetAudioLog } from 'expo-audio';

const h = React.createElement;

// ── Tiny harness ───────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.error('  ✗ ' + label);
  }
}

function section(name: string): void {
  console.log('\n== ' + name + ' ==');
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function pump(ms = 12): Promise<void> {
  await act(async () => {
    await sleep(ms);
  });
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for ' + label);
    await pump();
  }
}

type AnyNode = {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
  findAll(predicate: (node: AnyNode) => boolean): AnyNode[];
};

function byIdAll(tree: ReactTestRenderer, id: string): AnyNode[] {
  // Restrict to host elements: stub components are function components, so
  // without this each testID would match twice (composite + host).
  return (tree.root as unknown as AnyNode).findAll(
    node => typeof node.type === 'string' && node.props?.testID === id,
  );
}

function byId(tree: ReactTestRenderer, id: string): AnyNode {
  const all = byIdAll(tree, id);
  if (all.length !== 1) throw new Error(`expected exactly one ${id}, found ${all.length}`);
  return all[0];
}

function textOf(node: AnyNode): string {
  const parts: string[] = [];
  const visit = (child: unknown): void => {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (child && typeof child === 'object' && 'children' in (child as AnyNode)) {
      visit((child as AnyNode).children);
    }
  };
  visit(node.children);
  return parts.join('');
}

async function press(node: AnyNode): Promise<void> {
  await act(async () => {
    (node.props.onPress as (() => void) | undefined)?.();
    await sleep(0);
  });
}

// ── Section A: session reducer ─────────────────────────────────────────

function testReducer(): void {
  section('A. Session reducer');

  const setup: SessionPhase = { kind: 'setup' };
  check(
    sessionReducer(setup, { type: 'BEGIN', queue: [], countdownSeconds: 7 }) === setup,
    'BEGIN with an empty queue is a no-op',
  );

  let phase = sessionReducer(setup, { type: 'BEGIN', queue: SESSION_ANGLES, countdownSeconds: 7 });
  check(
    phase.kind === 'countdown' && phase.index === 0 && phase.secondsLeft === 7,
    'BEGIN enters the first countdown at the configured seconds',
  );
  check(activeAngle(phase) === 'front', 'activeAngle reports front during the first countdown');

  for (let expected = 6; expected >= 2; expected -= 1) {
    phase = sessionReducer(phase, { type: 'TICK' });
    check(
      phase.kind === 'countdown' && phase.secondsLeft === expected,
      `TICK decrements to ${expected}`,
    );
  }
  phase = sessionReducer(phase, { type: 'TICK' });
  check(phase.kind === 'countdown' && phase.secondsLeft === 1, 'TICK reaches the final second');
  phase = sessionReducer(phase, { type: 'TICK' });
  check(phase.kind === 'capturing', 'the TICK taken at 1 moves to capturing');
  check(activeAngle(phase) === 'front', 'activeAngle reports front while capturing');

  phase = sessionReducer(phase, { type: 'SHOT_DONE', countdownSeconds: 7 });
  check(
    phase.kind === 'countdown' && phase.index === 1 && phase.secondsLeft === 7,
    'SHOT_DONE advances to the side countdown',
  );

  phase = { kind: 'capturing', queue: SESSION_ANGLES, index: 2 };
  phase = sessionReducer(phase, { type: 'SHOT_DONE', countdownSeconds: 7 });
  check(phase.kind === 'review', 'SHOT_DONE on the last angle lands in review');

  check(
    sessionReducer({ kind: 'setup' }, { type: 'TICK' }).kind === 'setup' &&
      sessionReducer({ kind: 'review' }, { type: 'SHOT_DONE', countdownSeconds: 7 }).kind ===
        'review' &&
      sessionReducer({ kind: 'setup' }, { type: 'SAVE_DONE' }).kind === 'setup',
    'events in the wrong phase are ignored',
  );

  const zero = sessionReducer(setup, { type: 'BEGIN', queue: ['side'], countdownSeconds: 0 });
  check(
    zero.kind === 'countdown' && zero.secondsLeft === 1,
    'a zero-second config still shows at least one countdown second',
  );

  let saving = sessionReducer({ kind: 'review' }, { type: 'SAVE_START', total: 3 });
  check(saving.kind === 'saving' && saving.done === 0 && saving.total === 3, 'SAVE_START enters saving');
  saving = sessionReducer(saving, { type: 'SAVE_PROGRESS' });
  saving = sessionReducer(saving, { type: 'SAVE_PROGRESS' });
  saving = sessionReducer(saving, { type: 'SAVE_PROGRESS' });
  saving = sessionReducer(saving, { type: 'SAVE_PROGRESS' });
  check(saving.kind === 'saving' && saving.done === 3, 'SAVE_PROGRESS clamps at the total');
  check(sessionReducer(saving, { type: 'SAVE_DONE' }).kind === 'saved', 'SAVE_DONE lands in saved');
  check(
    sessionReducer(saving, { type: 'SAVE_FAILED' }).kind === 'review',
    'SAVE_FAILED returns to review with shots intact',
  );

  check(
    reshootQueue({ back: true, front: true }).join(',') === 'front,back',
    'reshootQueue returns canonical front→back order regardless of tap order',
  );
  check(reshootQueue({}).length === 0, 'reshootQueue is empty with nothing selected');
  check(
    buildPhotoLabel(18, 'front') === 'Week 18 · Front' && buildPhotoLabel(3, 'back') === 'Week 3 · Back',
    'buildPhotoLabel formats "Week N · Angle"',
  );

  check(
    classifyTilt(null) === 'unavailable' &&
      classifyTilt(TILT_ALMOST_MIN_DEG - 1) === 'too_flat' &&
      classifyTilt(TILT_READY_MIN_DEG - 1) === 'almost' &&
      classifyTilt(TILT_READY_MIN_DEG) === 'ready' &&
      classifyTilt(TILT_READY_MAX_DEG) === 'ready' &&
      classifyTilt(TILT_READY_MAX_DEG + 2) === 'too_upright',
    'classifyTilt zones follow the exported thresholds',
  );
}

// ── Section B: no-AI photo analysis ────────────────────────────────────

function flatFrame(fill: number, width = 96, height = 128): GrayFrame {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

function paintRect(
  frame: GrayFrame,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: number,
): GrayFrame {
  const data = new Uint8Array(frame.data);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      data[y * frame.width + x] = value;
    }
  }
  return { width: frame.width, height: frame.height, data };
}

function meanOf(frame: GrayFrame): number {
  let sum = 0;
  for (const v of frame.data) sum += v;
  return sum / frame.data.length;
}

function testAnalysis(): void {
  section('B. No-AI photo analysis');

  check(assessLighting(flatFrame(30)).kind === 'too_dark', 'a dim frame reads too_dark');
  check(assessLighting(flatFrame(235)).kind === 'too_bright', 'a blown-out frame reads too_bright');
  check(assessLighting(flatFrame(120)).kind === 'ok', 'a mid frame reads ok');

  // jpeg-js roundtrip — the exact native path (capture → small JPEG →
  // decode → gray) must preserve overall luminance.
  const gradient: GrayFrame = { width: 96, height: 128, data: new Uint8Array(96 * 128) };
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 96; x += 1) {
      gradient.data[y * 96 + x] = Math.min(255, 30 + x + Math.floor(y / 2));
    }
  }
  const rounded = decodeJpegBase64ToGray(encodeGrayToJpegBase64(gradient));
  check(
    rounded.width === 96 && rounded.height === 128,
    'jpeg roundtrip preserves analysis dimensions',
  );
  check(
    Math.abs(meanOf(rounded) - meanOf(gradient)) < 8,
    'jpeg roundtrip preserves mean luminance',
  );

  // Subject via cross-shot differencing: a person-sized block that moves
  // between shots (the patient rotates) at a plausible height.
  const base = flatFrame(150);
  const okTrio = [
    paintRect(base, 34, 18, 62, 112, 60),
    paintRect(base, 42, 18, 54, 112, 60),
    paintRect(base, 30, 18, 58, 112, 60),
  ];
  const okVerdict = assessSubject(okTrio);
  check(okVerdict?.kind === 'ok', 'a moving person-sized block reads ok');
  check(
    okVerdict !== null && okVerdict.heightFrac > 0.6 && okVerdict.heightFrac < 0.9,
    'subject height fraction lands in the plausible band',
  );

  check(
    assessSubject([base, base, base])?.kind === 'not_detected',
    'three identical shots read not_detected (nobody stepped in)',
  );
  const closeTrio = [
    paintRect(base, 4, 0, 92, 128, 60),
    paintRect(base, 10, 0, 86, 128, 95),
    paintRect(base, 2, 0, 88, 128, 70),
  ];
  check(assessSubject(closeTrio)?.kind === 'too_close', 'a frame-filling subject reads too_close');
  const farTrio = [
    paintRect(base, 40, 70, 52, 100, 60),
    paintRect(base, 48, 70, 60, 100, 60),
    paintRect(base, 36, 70, 48, 100, 60),
  ];
  check(assessSubject(farTrio)?.kind === 'too_far', 'a small distant subject reads too_far');
  check(assessSubject([base]) === null, 'fewer than two shots yields no subject verdict');

  // Session rollup: missing shots, per-shot lighting, session-level subject.
  const missing = analyzeSession(SESSION_ANGLES, { front: okTrio[0], side: okTrio[1] });
  check(
    missing.reasons.back.includes(MISSING_SHOT_MESSAGE) && missing.preselect.back,
    'an angle without a frame gets the missing-shot reason, preselected',
  );
  check(!missing.preselect.front, 'present clean shots stay unselected when another is missing');

  const darkFront = analyzeSession(SESSION_ANGLES, {
    front: paintRect(flatFrame(30), 34, 18, 62, 112, 8),
    side: okTrio[1],
    back: okTrio[2],
  });
  check(
    darkFront.reasons.front.includes(LIGHTING_MESSAGES.too_dark) && darkFront.preselect.front,
    'a dark shot gets the lighting reason on that angle only',
  );
  check(
    !darkFront.reasons.side.includes(LIGHTING_MESSAGES.too_dark),
    'clean angles do not inherit lighting reasons',
  );

  const nobody = analyzeSession(SESSION_ANGLES, { front: base, side: base, back: base });
  check(
    SESSION_ANGLES.every(
      angle =>
        nobody.reasons[angle].includes(SUBJECT_MESSAGES.not_detected) && nobody.preselect[angle],
    ),
    'a session-level subject problem flags every captured angle',
  );

  // The web demo path: simulated frames must sail through with zero flags.
  const simFrames = {
    front: buildSimulatedGrayFrame('front'),
    side: buildSimulatedGrayFrame('side'),
    back: buildSimulatedGrayFrame('back'),
  };
  const sim = analyzeSession(SESSION_ANGLES, simFrames);
  check(
    SESSION_ANGLES.every(angle => sim.reasons[angle].length === 0 && !sim.preselect[angle]),
    'simulated camera frames pass every check (the web demo stays clean)',
  );
  check(sim.subject?.kind === 'ok', 'simulated frames read a plausible subject');

  // And the native-path variant of the same frames: encode → decode.
  const reFront = decodeJpegBase64ToGray(encodeGrayToJpegBase64(simFrames.front));
  const reSide = decodeJpegBase64ToGray(encodeGrayToJpegBase64(simFrames.side));
  const reBack = decodeJpegBase64ToGray(encodeGrayToJpegBase64(simFrames.back));
  const reSim = analyzeSession(SESSION_ANGLES, { front: reFront, side: reSide, back: reBack });
  check(
    SESSION_ANGLES.every(angle => reSim.reasons[angle].length === 0),
    'sim frames survive the jpeg roundtrip still clean',
  );
}

// ── Section C: session tones ───────────────────────────────────────────

function checkWav(label: string, uri: string): void {
  check(uri.startsWith('data:audio/wav;base64,'), `${label} is a WAV data uri`);
  const bytes = base64ToBytes(uri);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    Array.from(bytes.slice(offset, offset + length))
      .map(b => String.fromCharCode(b))
      .join('');
  check(ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE', `${label} has RIFF/WAVE magic`);
  check(view.getUint32(4, true) === bytes.byteLength - 8, `${label} RIFF size matches`);
  check(ascii(12, 4) === 'fmt ', `${label} has a fmt chunk`);
  check(
    view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1,
    `${label} is PCM mono`,
  );
  const rate = view.getUint32(24, true);
  check(rate >= 8000 && rate <= 48000, `${label} sample rate is sane (${rate})`);
  check(
    ascii(36, 4) === 'data' && view.getUint32(40, true) === bytes.byteLength - 44,
    `${label} data chunk size matches`,
  );
}

function testTones(): void {
  section('C. Session tones');
  checkWav('tick tone', TICK_TONE_URI);
  checkWav('capture tone', CAPTURE_TONE_URI);
  checkWav('alert tone', ALERT_TONE_URI);
}

// ── Section D: upload client ───────────────────────────────────────────

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

function json200(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function scriptedFetch(script: { failAt?: 'request' | 'put' | 'finalize' }) {
  const calls: string[] = [];
  const impl = async (...[input, init]: FetchArgs): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
    if (url.includes('/progress-photos/upload-url')) {
      const body = JSON.parse(String(init?.body)) as { angle: SessionAngle; sizeBytes: number };
      check(body.sizeBytes > 0, 'upload-url request carries a positive sizeBytes');
      if (script.failAt === 'request') return new Response('nope', { status: 500 });
      return json200({
        uploadUrl: `https://storage.test/put/${body.angle}`,
        objectPath: `/objects/progress-photos/2026-08/${body.angle}-test`,
      });
    }
    if (url.startsWith('https://storage.test/put/')) {
      if (script.failAt === 'put') return new Response(null, { status: 503 });
      return new Response(null, { status: 200 });
    }
    if (url.includes('/progress-photos/finalize')) {
      if (script.failAt === 'finalize') {
        script.failAt = undefined; // fail exactly once
        return new Response('bad', { status: 502 });
      }
      return json200({ objectPath: 'ok', size: 1 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { impl: impl as never, calls };
}

function simShots(): ShotToUpload[] {
  return SESSION_ANGLES.map(angle => ({
    angle,
    uri: buildSimulatedShotDataUri(angle),
    width: 384,
  }));
}

async function testUploadClient(): Promise<void> {
  section('D. Upload client');

  {
    const { impl, calls } = scriptedFetch({});
    const progress: Array<[number, number]> = [];
    const paths = await uploadProgressShots(
      simShots(),
      {},
      (done, total) => progress.push([done, total]),
      impl,
    );
    check(
      SESSION_ANGLES.every(angle => paths[angle] === `/objects/progress-photos/2026-08/${angle}-test`),
      'happy path returns an object path per angle',
    );
    check(calls.length === 9, 'happy path makes exactly three calls per angle');
    const frontIdx = calls.findIndex(c => c.includes('upload-url'));
    check(
      calls[frontIdx + 1]?.startsWith('PUT') && calls[frontIdx + 2]?.includes('finalize'),
      'each angle runs upload-url → PUT → finalize in order',
    );
    check(
      JSON.stringify(progress) === JSON.stringify([[1, 3], [2, 3], [3, 3]]),
      'progress advances once per finished angle',
    );
  }

  {
    const { impl } = scriptedFetch({ failAt: 'request' });
    try {
      await uploadProgressShots(simShots(), {}, undefined, impl);
      check(false, 'a failed upload-url call must throw');
    } catch (error) {
      check(
        error instanceof ProgressUploadError && error.stage === 'request' && error.angle === 'front',
        'upload-url failure throws a typed request-stage error for the angle',
      );
    }
  }

  {
    const { impl } = scriptedFetch({ failAt: 'put' });
    try {
      await uploadProgressShots(simShots(), {}, undefined, impl);
      check(false, 'a failed PUT must throw');
    } catch (error) {
      check(
        error instanceof ProgressUploadError && error.stage === 'put',
        'storage PUT failure throws a typed put-stage error',
      );
    }
  }

  {
    const { impl } = scriptedFetch({ failAt: 'finalize' });
    try {
      await uploadProgressShots(simShots(), {}, undefined, impl);
      check(false, 'a failed finalize must throw');
    } catch (error) {
      check(
        error instanceof ProgressUploadError && error.stage === 'finalize',
        'finalize failure throws a typed finalize-stage error',
      );
    }
  }

  {
    const { impl, calls } = scriptedFetch({});
    const progress: Array<[number, number]> = [];
    const paths = await uploadProgressShots(
      simShots(),
      { front: '/objects/progress-photos/2026-08/front-done' },
      (done, total) => progress.push([done, total]),
      impl,
    );
    check(
      paths.front === '/objects/progress-photos/2026-08/front-done',
      'resume keeps the already-uploaded path',
    );
    check(
      calls.length === 6 && calls.every(c => !c.includes('/put/front')),
      'resume skips the uploaded angle entirely',
    );
    check(
      JSON.stringify(progress[0]) === JSON.stringify([1, 3]),
      'resume reports the skipped angle as already done',
    );
  }
}

// ── Section E: full surface runs (react-test-renderer, web sim path) ───

let patientRef: ReturnType<typeof usePatient> | null = null;
function Probe(): null {
  patientRef = usePatient();
  return null;
}

interface RtrRun {
  tree: ReactTestRenderer;
  doneCount: () => number;
}

async function mountSurface(timing: { countdownSeconds: number; tickMs: number }): Promise<RtrRun> {
  let done = 0;
  const onDone = () => {
    done += 1;
  };
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      h(
        PatientProvider,
        null,
        h(Probe, null),
        h(GuidedSessionSurface, { onDone, timing }),
      ),
    );
  });
  return { tree, doneCount: () => done };
}

function userPhotos() {
  return (patientRef?.photos ?? []).filter(photo => photo.source === 'user');
}

/** Scripted global fetch feeding the surface's default expo/fetch path. */
const rtrFetchState = { failNextFinalize: false, uploadUrlCalls: 0 };
function installRtrFetch(): void {
  rtrFetchState.failNextFinalize = false;
  rtrFetchState.uploadUrlCalls = 0;
  globalThis.fetch = (async (...[input, init]: FetchArgs): Promise<Response> => {
    const url = String(input);
    if (url.includes('/progress-photos/upload-url')) {
      rtrFetchState.uploadUrlCalls += 1;
      const body = JSON.parse(String(init?.body)) as { angle: SessionAngle };
      return json200({
        uploadUrl: `https://storage.test/put/${body.angle}`,
        objectPath: `/objects/progress-photos/2026-08/${body.angle}-live`,
      });
    }
    if (url.startsWith('https://storage.test/put/')) return new Response(null, { status: 200 });
    if (url.includes('/progress-photos/finalize')) {
      if (rtrFetchState.failNextFinalize) {
        rtrFetchState.failNextFinalize = false;
        return new Response('bad', { status: 502 });
      }
      return json200({ objectPath: 'ok', size: 1 });
    }
    throw new Error('unexpected fetch ' + url);
  }) as typeof fetch;
}

async function testCountdownPresentation(): Promise<void> {
  section('E0. Countdown presentation (slow clock, no races)');
  localStore.clear();
  resetSpeechLog();
  resetAudioLog();
  const run = await mountSurface({ countdownSeconds: 30, tickMs: 1000 });
  try {
    await waitFor(() => byIdAll(run.tree, 'guided-start').length === 1, 'setup screen');
    check(byIdAll(run.tree, 'guided-instructions').length === 1, 'instructions show by default');
    check(byIdAll(run.tree, 'guided-tilt-meter').length === 0, 'no tilt meter on the web path');
    await press(byId(run.tree, 'guided-start'));
    await waitFor(
      () => byIdAll(run.tree, 'guided-countdown-number').length === 1,
      'countdown to appear',
    );
    check(textOf(byId(run.tree, 'guided-countdown-number')) === '30', 'giant numeral shows the full countdown');
    check(textOf(byId(run.tree, 'guided-angle-title')) === 'FRONT', 'giant angle title reads FRONT');
    check(
      textOf(byId(run.tree, 'guided-photo-index')) === 'PHOTO 1 OF 3',
      'progress kicker reads PHOTO 1 OF 3',
    );
    check(byIdAll(run.tree, 'guided-sim-note').length === 1, 'web run is labeled as a simulated camera');
    check(
      spoken.some(line => line === ANGLE_META.front.spoken),
      'the front pose is announced out loud',
    );
    check(
      audioLog.modeCalls.some(mode => (mode as { playsInSilentMode?: boolean }).playsInSilentMode === true),
      'audio opts into playing through the silent switch',
    );
  } finally {
    await act(async () => run.tree.unmount());
  }
}

async function testFullSessionRun(): Promise<void> {
  section('E1. Full session: capture → review → reshoot → save');
  localStore.clear();
  resetSpeechLog();
  resetAudioLog();
  installRtrFetch();
  const run = await mountSurface({ countdownSeconds: 2, tickMs: 20 });
  try {
    await waitFor(() => byIdAll(run.tree, 'guided-start').length === 1, 'setup screen');
    await press(byId(run.tree, 'guided-start'));
    await waitFor(() => byIdAll(run.tree, 'guided-save').length === 1, 'review after three shots');

    const okLabels = (run.tree.root as unknown as AnyNode).findAll(
      node => node.type === 'Text' && textOf(node) === 'Looks good',
    );
    check(okLabels.length === 3, 'all three sim shots pass the checks at review');
    check(
      SESSION_ANGLES.every(angle => byId(run.tree, `guided-retake-${angle}`).props['aria-checked'] === false),
      'no retakes are preselected for clean shots',
    );
    check(
      spoken.includes(ANGLE_META.side.spoken) && spoken.includes(ANGLE_META.back.spoken),
      'side and back poses were announced',
    );
    check(
      spoken.includes('All three photos look good. Review and save.'),
      'the clean review verdict is spoken',
    );
    check(
      (audioLog.plays.get(TICK_TONE_URI) ?? 0) >= 6,
      'the countdown ticked audibly (two ticks per angle at 2s)',
    );
    check((audioLog.plays.get(CAPTURE_TONE_URI) ?? 0) >= 3, 'each auto-capture chimed');
    check(byIdAll(run.tree, 'guided-retake-selected').length === 0, 'no retake button with nothing selected');

    // Reshoot just the side photo.
    await press(byId(run.tree, 'guided-retake-side'));
    check(byId(run.tree, 'guided-retake-side').props['aria-checked'] === true, 'ticking a retake checks it');
    await waitFor(() => byIdAll(run.tree, 'guided-retake-selected').length === 1, 'retake button to appear');
    await press(byId(run.tree, 'guided-retake-selected'));
    await waitFor(
      () =>
        byIdAll(run.tree, 'guided-photo-index').length === 1 &&
        textOf(byId(run.tree, 'guided-photo-index')) === 'PHOTO 1 OF 1',
      'a solo side reshoot run',
    );
    check(textOf(byId(run.tree, 'guided-angle-title')) === 'SIDE', 'the reshoot counts down the side pose');
    await waitFor(() => byIdAll(run.tree, 'guided-save').length === 1, 'review after the reshoot');
    check(
      (run.tree.root as unknown as AnyNode).findAll(
        node => node.type === 'Text' && textOf(node) === 'Looks good',
      ).length === 3,
      'the reshoot session is clean again at review',
    );

    // Save: three uploads, one patient commit, spoken confirmation.
    await press(byId(run.tree, 'guided-save'));
    await waitFor(() => byIdAll(run.tree, 'guided-saved').length === 1, 'saved confirmation');
    check(rtrFetchState.uploadUrlCalls === 3, 'exactly one upload per angle despite the reshoot');
    const photos = userPhotos();
    check(photos.length === 3, 'three photos land in the patient record');
    const week = Math.ceil(ENROLLMENT_DAYS / 7);
    check(
      SESSION_ANGLES.every(angle =>
        photos.some(
          photo =>
            photo.angle === angle &&
            photo.label === buildPhotoLabel(week, angle) &&
            photo.dateKey === TODAY_KEY &&
            photo.objectPath === `/objects/progress-photos/2026-08/${angle}-live` &&
            typeof photo.uri === 'string' &&
            photo.uri.startsWith('data:image/jpeg;base64,'),
        ),
      ),
      'each angle saves with its label, date, local uri, and storage path',
    );
    const persisted = localStore.get(PATIENT_STORAGE_KEY) ?? '';
    check(
      persisted.includes('"angle":"front"') && persisted.includes('progress-photos'),
      'the session persists under the shared patient storage key',
    );
    check(spoken.includes('Photos saved.'), 'the save is confirmed out loud');
    await waitFor(() => run.doneCount() === 1, 'the surface to close itself after saving');
  } finally {
    await act(async () => run.tree.unmount());
  }
}

async function testSaveFailureRecovery(): Promise<void> {
  section('E2. Save failure: announced, retryable, nothing lost');
  localStore.clear();
  resetSpeechLog();
  resetAudioLog();
  installRtrFetch();
  rtrFetchState.failNextFinalize = true;
  const run = await mountSurface({ countdownSeconds: 2, tickMs: 20 });
  try {
    await waitFor(() => byIdAll(run.tree, 'guided-start').length === 1, 'setup screen');
    await press(byId(run.tree, 'guided-start'));
    await waitFor(() => byIdAll(run.tree, 'guided-save').length === 1, 'review');
    await press(byId(run.tree, 'guided-save'));
    await waitFor(() => byIdAll(run.tree, 'guided-error').length === 1, 'the announced error box');
    const errorBox = byId(run.tree, 'guided-error');
    check(
      textOf(errorBox).includes('could not be confirmed') && textOf(errorBox).includes('still here'),
      'the error says what failed and that the photos are safe',
    );
    check(errorBox.props.accessibilityRole === 'alert', 'the error box announces itself');
    check(userPhotos().length === 0, 'nothing lands in the record on a failed save');
    check(byIdAll(run.tree, 'guided-save').length === 1, 'review (with shots) survives the failure');
    check((audioLog.plays.get(ALERT_TONE_URI) ?? 0) >= 1, 'the failure plays the alert tone');

    await press(byId(run.tree, 'guided-save'));
    await waitFor(() => byIdAll(run.tree, 'guided-saved').length === 1, 'retry succeeding');
    check(userPhotos().length === 3, 'the retry lands all three photos');
    check(
      rtrFetchState.uploadUrlCalls === 4,
      'the failed angle re-uploads; a finalize failure does not mark it done',
    );
  } finally {
    await act(async () => run.tree.unmount());
  }
}

async function testInstructionPreference(): Promise<void> {
  section('E3. Hide-instructions preference + legacy snapshot hydrate');
  localStore.clear();
  const first = await mountSurface({ countdownSeconds: 2, tickMs: 20 });
  try {
    await waitFor(() => byIdAll(first.tree, 'guided-instructions').length === 1, 'instructions visible');
    await press(byId(first.tree, 'guided-hide-instructions'));
    await waitFor(
      () => patientRef?.hideSessionInstructions === true,
      'the preference to persist in context',
    );
    await waitFor(
      () => (localStore.get(PATIENT_STORAGE_KEY) ?? '').includes('"hideSessionInstructions":true'),
      'the preference to persist in storage',
    );
  } finally {
    await act(async () => first.tree.unmount());
  }

  // Second mount: preference respected, with an explicit way back.
  const second = await mountSurface({ countdownSeconds: 2, tickMs: 20 });
  try {
    await waitFor(
      () => byIdAll(second.tree, 'guided-show-instructions').length === 1,
      'the compact setup with a "show me the steps" link',
    );
    check(byIdAll(second.tree, 'guided-instructions').length === 0, 'instructions stay hidden once opted out');
    await press(byId(second.tree, 'guided-show-instructions'));
    await waitFor(
      () => byIdAll(second.tree, 'guided-instructions').length === 1,
      'the link to bring the steps back for this visit',
    );
  } finally {
    await act(async () => second.tree.unmount());
  }

  // Legacy snapshot: a patient state saved before this feature existed
  // (no hideSessionInstructions field, plus a marker photo to detect
  // hydration) must hydrate cleanly with the default OFF.
  const snapshot = JSON.parse(localStore.get(PATIENT_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
  delete snapshot.hideSessionInstructions;
  snapshot.photos = [
    { id: 'photo-legacy', dateKey: TODAY_KEY, label: 'Legacy', source: 'user', uri: 'data:image/jpeg;base64,AA==' },
  ];
  localStore.set(PATIENT_STORAGE_KEY, JSON.stringify(snapshot));

  const third = await mountSurface({ countdownSeconds: 2, tickMs: 20 });
  try {
    await waitFor(
      () => (patientRef?.photos ?? []).some(photo => photo.id === 'photo-legacy'),
      'the legacy snapshot to hydrate',
    );
    check(
      patientRef?.hideSessionInstructions === false,
      'a legacy snapshot without the field hydrates to instructions ON',
    );
    check(
      byIdAll(third.tree, 'guided-instructions').length === 1,
      'the surface shows instructions for a legacy snapshot',
    );
  } finally {
    await act(async () => third.tree.unmount());
  }
}

// ── Section F: PatientContext session commit ───────────────────────────

async function testPatientContextCommit(): Promise<void> {
  section('F. PatientContext.addPhotoSession');
  localStore.clear();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(h(PatientProvider, null, h(Probe, null)));
  });
  try {
    await waitFor(() => patientRef !== null, 'the provider to mount');
    await act(async () => {
      await patientRef!.addPhotoSession([]);
    });
    check(userPhotos().length === 0, 'an empty session is a no-op');

    const week = Math.ceil(ENROLLMENT_DAYS / 7);
    await act(async () => {
      await patientRef!.addPhotoSession(
        SESSION_ANGLES.map(angle => ({
          dateKey: TODAY_KEY,
          uri: `data:image/jpeg;base64,${angle}`,
          label: buildPhotoLabel(week, angle),
          angle,
          objectPath: `/objects/progress-photos/2026-08/${angle}-f`,
        })),
      );
    });
    const photos = userPhotos();
    check(photos.length === 3, 'a session commits all three photos at once');
    check(
      new Set(photos.map(photo => photo.id)).size === 3,
      'each session photo gets its own id',
    );
    check(
      photos.every(photo => photo.angle !== undefined && photo.objectPath !== undefined),
      'session photos carry angle and storage path',
    );

    const persisted = JSON.parse(localStore.get(PATIENT_STORAGE_KEY) ?? '{}') as {
      photos?: unknown[];
    };
    check((persisted.photos ?? []).length === 3, 'one snapshot write holds the whole session');
  } finally {
    await act(async () => tree.unmount());
  }
}

// ── Runner ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  testReducer();
  testAnalysis();
  testTones();
  await testUploadClient();

  // BodyOutline renders per angle (layout-driven sizing is e2e territory).
  {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(h(BodyOutline, { angle: 'front', height: 400 }));
    });
    check(byIdAll(tree, 'body-outline-front').length === 1, 'BodyOutline renders its angle testID');
    await act(async () => tree.unmount());
  }

  const scenarios: Array<[string, () => Promise<void>]> = [
    ['countdown presentation', testCountdownPresentation],
    ['full session run', testFullSessionRun],
    ['save failure recovery', testSaveFailureRecovery],
    ['instruction preference', testInstructionPreference],
    ['patient context commit', testPatientContextCommit],
  ];
  for (const [name, scenario] of scenarios) {
    try {
      await scenario();
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message}`);
      console.error(`  ✗ scenario "${name}" threw: ${(error as Error).message}`);
    }
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.error('\nFailed checks:');
    for (const failure of failures) console.error('  - ' + failure);
    process.exit(1);
  }
}

void main();
