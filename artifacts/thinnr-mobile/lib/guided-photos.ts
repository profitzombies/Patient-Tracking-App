/**
 * Handoff between a guided-session entry point and the guided photo route
 * (app/guided-photos) — the same module-promise convention as
 * lib/food-camera: the entry point creates a request and navigates; the
 * route claims it, runs the whole session (setup → per-angle countdown
 * capture → review → upload/save), and settles with the outcome (null when
 * the patient closed without saving). One request pending at a time,
 * claiming is once-only, settling is idempotent.
 *
 * Countdown/probe timing lives here as injectable module state so the
 * verification suite can run the full three-angle sequence in milliseconds
 * while the app keeps the real 7-second cadence.
 */

/** The three shots a session produces, in capture order. */
export type GuidedAngle = 'front' | 'side' | 'back';

export const GUIDED_ANGLES: readonly GuidedAngle[] = ['front', 'side', 'back'];

export const GUIDED_ANGLE_LABELS: Record<GuidedAngle, string> = {
  front: 'Front',
  side: 'Side',
  back: 'Back',
};

/** One captured (not yet uploaded) shot, held on-device until Save. */
export interface GuidedShot {
  angle: GuidedAngle;
  /** Local file URI (native) or data/bundled URI (web demo). */
  uri: string;
  width: number;
  height: number;
  /** Raw JPEG base64 when the capture provided it (upload path). */
  base64?: string;
}

/** What the entry point learns when the session settles. */
export interface GuidedSessionOutcome {
  /** Number of photos committed to the progress grid. */
  savedCount: number;
}

type Settle = (outcome: GuidedSessionOutcome | null) => void;

let pending: Settle | null = null;

/**
 * Registers intent to run a guided session and resolves with the outcome
 * (null when the screen closed without saving). Call right before pushing
 * /guided-photos.
 */
export function createGuidedPhotoRequest(): Promise<GuidedSessionOutcome | null> {
  pending?.(null);
  return new Promise<GuidedSessionOutcome | null>(resolve => {
    pending = resolve;
  });
}

export interface GuidedPhotoHandoff {
  /** Resolves the caller's promise; extra calls are no-ops. */
  settle: Settle;
}

/**
 * Claims the pending request (once). Returns null when nothing is pending —
 * the route was reached without a caller (deep link, refresh) and should
 * redirect instead of running a session into the void.
 */
export function claimGuidedPhotoRequest(): GuidedPhotoHandoff | null {
  const resolve = pending;
  if (!resolve) return null;
  pending = null;
  let settled = false;
  return {
    settle(outcome) {
      if (settled) return;
      settled = true;
      resolve(outcome);
    },
  };
}

/** Seconds counted down before each angle's auto-capture. */
export const COUNTDOWN_SECONDS = 7;

/**
 * Real-time milliseconds per countdown second / per positioning probe.
 * The suite dials these down to run the whole session in tens of ms.
 */
let tickIntervalMs = 1000;
let probeIntervalMs = 1000;

export function setGuidedTickIntervalMs(ms: number): void {
  tickIntervalMs = ms;
}

export function getGuidedTickIntervalMs(): number {
  return tickIntervalMs;
}

export function setGuidedProbeIntervalMs(ms: number): void {
  probeIntervalMs = ms;
}

export function getGuidedProbeIntervalMs(): number {
  return probeIntervalMs;
}

/**
 * Steady-gate timing: how long every line-up check must hold green before
 * the countdown starts, how often the gate re-evaluates, and how long the
 * line-up may stay unsatisfied before the "Start anyway" escape appears.
 * Injectable for the same reason as the tick/probe intervals.
 */
let holdSteadyMs = 5000;
let gateTickMs = 100;
let escapeAfterMs = 20000;

export function setGuidedHoldMs(ms: number): void {
  holdSteadyMs = ms;
}

export function getGuidedHoldMs(): number {
  return holdSteadyMs;
}

export function setGuidedGateTickMs(ms: number): void {
  gateTickMs = ms;
}

export function getGuidedGateTickMs(): number {
  return gateTickMs;
}

export function setGuidedEscapeMs(ms: number): void {
  escapeAfterMs = ms;
}

export function getGuidedEscapeMs(): number {
  return escapeAfterMs;
}

/**
 * Pacing for the spoken coach and the on-screen verdict:
 *  - cueSettleMs: the beat of silence after a cue finishes before the next
 *    one may start (the pacer re-derives the situation across it).
 *  - speechGuardMs: safety net for a platform TTS that never reports the
 *    end of an utterance — the pacer resumes anyway rather than going mute.
 *  - statusConfirmMs: how long a line-up verdict must persist before it
 *    counts as the DISPLAYED and SPOKEN truth. Display-only: the steady
 *    gate keeps consuming raw verdicts, so readiness rules are unchanged.
 *  - motionStaleMs: no trustworthy gravity sample for this long means the
 *    phone is being moved — the level shows "settling" and the hold cannot
 *    bank on an angle nobody is measuring.
 * Injectable for the same reason as the tick/probe intervals.
 */
let cueSettleMs = 900;
let speechGuardMs = 9000;
let statusConfirmMs = 700;
let motionStaleMs = 400;

export function setGuidedCueSettleMs(ms: number): void {
  cueSettleMs = ms;
}

export function getGuidedCueSettleMs(): number {
  return cueSettleMs;
}

export function setGuidedSpeechGuardMs(ms: number): void {
  speechGuardMs = ms;
}

export function getGuidedSpeechGuardMs(): number {
  return speechGuardMs;
}

export function setGuidedStatusConfirmMs(ms: number): void {
  statusConfirmMs = ms;
}

export function getGuidedStatusConfirmMs(): number {
  return statusConfirmMs;
}

export function setGuidedMotionStaleMs(ms: number): void {
  motionStaleMs = ms;
}

export function getGuidedMotionStaleMs(): number {
  return motionStaleMs;
}

/**
 * Storage key for the persisted "Hide these instructions" preference —
 * localStorage on web, AsyncStorage native (mirrors PatientContext's
 * storage split).
 */
export const HIDE_INSTRUCTIONS_KEY = 'thinnr_guided_photo_hide_instructions_v1';
