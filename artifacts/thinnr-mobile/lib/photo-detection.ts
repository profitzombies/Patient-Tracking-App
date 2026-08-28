/**
 * Subject detection for the guided photo session — deliberately NOT AI.
 *
 * The camera is propped still on the floor, so classic adaptive background
 * subtraction on a tiny grayscale grid (~18×24) is enough to answer the only
 * questions the session asks: is there enough light, has someone stepped
 * into view, are they the right size in the frame (the outline is ~75% of
 * frame height), and are they roughly centered. Every probe frame costs a
 * few thousand integer ops on-device; nothing leaves the phone.
 *
 * Model: the first frame seeds the background. Each probe marks pixels
 * whose |frame − background| clears a threshold as "subject", gently blends
 * unchanged pixels into the background (lighting drift), and force-adopts
 * pixels that stay changed for many consecutive probes (the scene itself
 * changed — e.g. the patient's close-up body at the phone vacated once they
 * stepped back). The subject's bounding box gives distance and centering;
 * mean luma gives the light checks. `readyStreak` counts consecutive ready
 * probes so the countdown only auto-starts once the patient has held
 * position — a person standing still IS absorbed into the background
 * eventually, but the ready hold (3 probes) fires long before absorption
 * (10 probes) can dissolve them.
 */

/** Grayscale probe frame, row-major, 0–255. */
export interface LumaFrame {
  width: number;
  height: number;
  luma: Uint8Array;
}

export type PositioningStatus =
  | 'too-dark'
  | 'too-bright'
  | 'not-detected'
  | 'too-far'
  | 'too-close'
  | 'off-center'
  | 'ready';

export interface PositioningReading {
  status: PositioningStatus;
  /** Mean frame luma 0–255 (light checks). */
  meanLuma: number;
  /** Subject bounding-box height as a fraction of frame height, when detected. */
  bodyHeightFraction: number | null;
  /** Subject center offset from frame center, −0.5…0.5 of width, when detected. */
  centerOffsetFraction: number | null;
  /** Consecutive ready probes, including this one. */
  readyStreak: number;
  /** True once the ready hold is satisfied — the caller starts the countdown. */
  shouldStartCountdown: boolean;
}

// Light thresholds: mean luma outside this band means the shot would be
// unusable no matter where the patient stands, so light wins over position.
export const DARK_LUMA_MAX = 38;
export const BRIGHT_LUMA_MIN = 232;

/** |frame − background| above this marks a pixel as subject. */
export const DIFF_THRESHOLD = 26;

/** Fraction of pixels that must be subject before "someone is in view". */
export const MIN_PRESENCE_FRACTION = 0.045;

/** Ready window for the subject's height fraction (outline is ~75%). */
export const BODY_HEIGHT_READY_MIN = 0.55;
export const BODY_HEIGHT_READY_MAX = 0.93;

/** Center offset beyond this asks the patient to re-center. */
export const CENTER_OFFSET_MAX = 0.22;

/** Consecutive ready probes before the countdown auto-starts. */
export const READY_HOLD_PROBES = 3;

/** Probes a pixel may stay "changed" before the background adopts it. */
export const ABSORB_PROBES = 10;

/** Blend rate pulling unchanged pixels toward the current frame. */
const BACKGROUND_BLEND = 0.25;

export interface SubjectDetector {
  /** Feed the next probe frame; returns the reading the UI should show. */
  push(frame: LumaFrame): PositioningReading;
  /**
   * Between angles: the patient turns in place, so keep the learned
   * background but restart the ready hold and absorption counters.
   */
  resetHold(): void;
}

export function createSubjectDetector(): SubjectDetector {
  let background: Float32Array | null = null;
  let stuck: Uint16Array | null = null;
  let size = 0;
  let readyStreak = 0;

  function ensureModel(frame: LumaFrame): boolean {
    const n = frame.width * frame.height;
    if (background === null || size !== n) {
      background = new Float32Array(n);
      for (let i = 0; i < n; i++) background[i] = frame.luma[i];
      stuck = new Uint16Array(n);
      size = n;
      return true;
    }
    return false;
  }

  function reading(
    status: PositioningStatus,
    meanLuma: number,
    bodyHeightFraction: number | null,
    centerOffsetFraction: number | null,
  ): PositioningReading {
    if (status === 'ready') readyStreak += 1;
    else readyStreak = 0;
    return {
      status,
      meanLuma,
      bodyHeightFraction,
      centerOffsetFraction,
      readyStreak,
      shouldStartCountdown: readyStreak >= READY_HOLD_PROBES,
    };
  }

  return {
    push(frame: LumaFrame): PositioningReading {
      const { width, height, luma } = frame;
      const n = width * height;

      let lumaSum = 0;
      for (let i = 0; i < n; i++) lumaSum += luma[i];
      const meanLuma = lumaSum / n;

      const seeded = ensureModel(frame);
      const bg = background!;
      const stuckCounts = stuck!;

      // Light first: a dark or blown-out frame makes the diff meaningless.
      if (meanLuma <= DARK_LUMA_MAX) return reading('too-dark', meanLuma, null, null);
      if (meanLuma >= BRIGHT_LUMA_MIN) return reading('too-bright', meanLuma, null, null);
      if (seeded) return reading('not-detected', meanLuma, null, null);

      // Classify against the background, then update the model.
      const changed = new Uint8Array(n);
      let changedCount = 0;
      for (let i = 0; i < n; i++) {
        const diff = Math.abs(luma[i] - bg[i]);
        if (diff > DIFF_THRESHOLD) {
          changed[i] = 1;
          changedCount += 1;
          stuckCounts[i] += 1;
          if (stuckCounts[i] >= ABSORB_PROBES) {
            bg[i] = luma[i];
            stuckCounts[i] = 0;
          }
        } else {
          bg[i] += (luma[i] - bg[i]) * BACKGROUND_BLEND;
          stuckCounts[i] = 0;
        }
      }

      if (changedCount / n < MIN_PRESENCE_FRACTION) {
        return reading('not-detected', meanLuma, null, null);
      }

      // Bounding box over rows/columns with enough subject pixels to kill
      // single-cell speckle (sensor noise, a fluttering curtain edge).
      const minRowCells = Math.max(1, Math.round(width * 0.12));
      const minColCells = Math.max(1, Math.round(height * 0.08));
      let top = -1;
      let bottom = -1;
      for (let y = 0; y < height; y++) {
        let cells = 0;
        for (let x = 0; x < width; x++) cells += changed[y * width + x];
        if (cells >= minRowCells) {
          if (top === -1) top = y;
          bottom = y;
        }
      }
      let left = -1;
      let right = -1;
      for (let x = 0; x < width; x++) {
        let cells = 0;
        for (let y = 0; y < height; y++) cells += changed[y * width + x];
        if (cells >= minColCells) {
          if (left === -1) left = x;
          right = x;
        }
      }
      if (top === -1 || left === -1) {
        return reading('not-detected', meanLuma, null, null);
      }

      const bodyHeightFraction = (bottom - top + 1) / height;
      const centerOffsetFraction = ((left + right + 1) / 2 - width / 2) / width;

      if (
        bodyHeightFraction > BODY_HEIGHT_READY_MAX &&
        top === 0 &&
        bottom === height - 1
      ) {
        return reading('too-close', meanLuma, bodyHeightFraction, centerOffsetFraction);
      }
      if (bodyHeightFraction < BODY_HEIGHT_READY_MIN) {
        return reading('too-far', meanLuma, bodyHeightFraction, centerOffsetFraction);
      }
      if (Math.abs(centerOffsetFraction) > CENTER_OFFSET_MAX) {
        return reading('off-center', meanLuma, bodyHeightFraction, centerOffsetFraction);
      }
      return reading('ready', meanLuma, bodyHeightFraction, centerOffsetFraction);
    },

    resetHold() {
      readyStreak = 0;
      if (stuck) stuck.fill(0);
    },
  };
}

/**
 * Synthetic probe frames for the web demo: the same detector runs on the
 * same code path, fed generated frames that walk a person from "not there"
 * through "too far" into the ready window. Deterministic, so the preview
 * demos identically every time.
 */
export function makeSimulatedFrame(
  step: number,
  width = 18,
  height = 24,
): LumaFrame {
  const luma = new Uint8Array(width * height).fill(150);
  // Speckle-free flat background; the "person" is a darker column whose
  // height grows as they walk closer over the first several steps.
  const growth = [0, 0, 0.3, 0.45, 0.62, 0.75, 0.78][Math.min(step, 6)] ?? 0.78;
  if (growth > 0) {
    const bodyHeight = Math.round(height * growth);
    const bodyWidth = Math.max(3, Math.round(width * 0.3 * (0.6 + growth * 0.5)));
    const left = Math.round(width / 2 - bodyWidth / 2);
    const top = height - bodyHeight;
    for (let y = top; y < height; y++) {
      for (let x = left; x < left + bodyWidth; x++) {
        if (x >= 0 && x < width) luma[y * width + x] = 70;
      }
    }
  }
  return { width, height, luma };
}
