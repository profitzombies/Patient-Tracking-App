/**
 * The line-up gate for the guided photo session: combines the tilt model,
 * the light/framing detector, and probe availability into one status the
 * UI renders, plus the steady-hold tracker that decides when the countdown
 * may start.
 *
 * Pure and deterministic — the same functions run under the native sensor
 * loop, the web preview feed, and the verification suite.
 */

import type { PositioningReading, PositioningStatus } from './photo-detection';
import { classifyLean } from './tilt';

/**
 * Everything the line-up can ask the patient to fix. Tilt outranks framing
 * — the angle is fixed at the phone, and there is no point centering
 * yourself for a camera that stares at the floor; light already outranks
 * framing inside the detector. 'tilt-unavailable' is terminal: without a
 * live angle the gate never auto-starts, and only the explicit delayed
 * escape (or the announced probes-gone timed fallback) can begin capture.
 */
export type LineupStatus =
  | 'tilt-unavailable'
  | 'tilt-face-down'
  | 'tilt-back-more'
  | 'tilt-too-far'
  | PositioningStatus;

export interface LineupInputs {
  /** Smoothed lean-back degrees; null when no tilt signal has arrived. */
  leanDeg: number | null;
  /** false once tilt is known unavailable; null while undetermined. */
  tiltAvailable: boolean | null;
  /** Latest detector reading; null before the first probe lands. */
  reading: PositioningReading | null;
  /** false once probing is known unavailable; null while undetermined. */
  probesAvailable: boolean | null;
}

export function lineupStatus({ leanDeg, tiltAvailable, reading, probesAvailable }: LineupInputs): LineupStatus {
  if (leanDeg === null) {
    // No live tilt sample → NEVER green. A degraded sensor path must not
    // guess an angle (iOS rotation.beta folds face-down onto leaned-back —
    // the false green this gate exists to kill), so readiness strictly
    // requires a real gravity-derived lean. Known-unavailable says so;
    // still-undetermined keeps the quiet step-in status for the moment
    // the first sample takes to arrive.
    return tiltAvailable === false ? 'tilt-unavailable' : 'not-detected';
  }
  const zone = classifyLean(leanDeg);
  if (zone === 'face-down') return 'tilt-face-down';
  if (zone === 'tilt-back') return 'tilt-back-more';
  if (zone === 'too-far') return 'tilt-too-far';
  // Tilt is green. Framing next; when the camera cannot be probed the tilt
  // gate is all we can honestly check.
  if (probesAvailable === false) return 'ready';
  if (!reading) return 'not-detected';
  return reading.status;
}

/** Fraction of the hold whose loss counts as a break (audible cue). */
export const HOLD_BREAK_FRACTION = 0.08;

export interface HoldSnapshot {
  /** 0–1 fraction of the required steady time banked so far. */
  progress: number;
  /** True on the update that completes the hold. */
  satisfied: boolean;
  /** True on an update that threw away meaningful banked progress. */
  broke: boolean;
}

export interface SteadyHold {
  update(ready: boolean, nowMs: number, holdMs: number): HoldSnapshot;
  reset(): void;
}

/**
 * Tracks "everything green for N continuous milliseconds". Losing the lock
 * resets the bank to zero; `broke` flags the loss (once) so the UI can play
 * the hold-lost cue without re-deriving state. Brief flickers below
 * HOLD_BREAK_FRACTION reset silently — no blip spam while the patient is
 * still settling.
 */
export function createSteadyHold(): SteadyHold {
  let since: number | null = null;

  return {
    update(ready: boolean, nowMs: number, holdMs: number): HoldSnapshot {
      if (!ready) {
        const banked = since === null ? 0 : nowMs - since;
        since = null;
        const broke = holdMs > 0 ? banked >= holdMs * HOLD_BREAK_FRACTION : banked > 0;
        return { progress: 0, satisfied: false, broke };
      }
      if (since === null) since = nowMs;
      const progress = holdMs <= 0 ? 1 : Math.min(1, (nowMs - since) / holdMs);
      return { progress, satisfied: progress >= 1, broke: false };
    },
    reset() {
      since = null;
    },
  };
}
