/**
 * Signed, continuous tilt model for the guided photo session's line-up
 * stage.
 *
 * The phone stands on the floor propped back against the baseboard, front
 * camera toward the patient. "Lean" is the signed angle between the phone's
 * screen and dead vertical:
 *
 *   lean  0°  — standing perfectly upright
 *   lean +15° — leaned BACK the ideal touch (bottom on the floor, top on
 *               the wall, camera pointing slightly up: the repeatable
 *               weekly framing)
 *   lean −10° — tipped FORWARD, screen facing down at the floor. Never OK.
 *
 * The ONLY trusted signal is the gravity vector
 * (accelerationIncludingGravity): in portrait the reaction to gravity sits
 * in +y when upright and rotates into +z (out of the screen) as the phone
 * leans back, so atan2(z, y) IS the signed lean — continuous to a fraction
 * of a degree, with no fold anywhere near the working range.
 *
 * rotation.beta is deliberately NOT read, not even as a fallback: on iOS
 * beta (pitch) folds at 90°, so a phone staring at the floor reports the
 * same beta as one leaned back — exactly the inversion that made the old
 * meter show green face-down. A beta-derived angle could therefore
 * fabricate an in-band "ready" from a face-down phone in a degraded sensor
 * path. When the gravity vector is missing or untrusted this model returns
 * null — no signal — and the line-up gate treats tilt as unavailable: it
 * never auto-starts, leaving only the explicit delayed escape.
 */

/** The slice of a DeviceMotion measurement the tilt model reads. */
export interface MotionSample {
  /** accelerationIncludingGravity components, m/s², when present. */
  gravityY?: number | null;
  gravityZ?: number | null;
}

/** The tight ready band, in degrees of lean-back. */
export const TILT_IDEAL_DEG = 15;
export const TILT_READY_MIN_DEG = 12;
export const TILT_READY_MAX_DEG = 18;

/** Below this the phone is tipping forward — screen toward the floor. */
export const TILT_FACE_DOWN_DEG = -1.5;

/** Range of lean the level bar displays, centered on the ideal. */
export const TILT_BAR_SPAN_DEG = 42;
export const TILT_BAR_TOP_DEG = TILT_IDEAL_DEG + TILT_BAR_SPAN_DEG / 2;
export const TILT_BAR_BOTTOM_DEG = TILT_IDEAL_DEG - TILT_BAR_SPAN_DEG / 2;

/** Gravity magnitude (m/s², in the y/z plane) required to trust the vector. */
const GRAVITY_TRUST_MIN = 4;

/**
 * Signed lean-back in degrees from a motion sample, or null when the
 * gravity vector is missing or too weak to trust (device in motion,
 * freefall, broken sensor). Null means NO signal — callers must surface
 * "tilt unavailable" rather than guess. Sub-degree and continuous — callers
 * render it raw (through a light smoother), never quantized into steps.
 */
export function leanBackDegrees(sample: MotionSample): number | null {
  const y = sample.gravityY;
  const z = sample.gravityZ;
  if (
    typeof y === 'number' &&
    typeof z === 'number' &&
    Number.isFinite(y) &&
    Number.isFinite(z) &&
    Math.hypot(y, z) >= GRAVITY_TRUST_MIN
  ) {
    let lean = (Math.atan2(z, y) * 180) / Math.PI;
    // A platform reporting the raw (un-negated, Apple-style) gravity vector
    // lands 180° away from the web convention. A propped phone is always
    // within a few dozen degrees of upright, so fold the far hemisphere
    // back instead of declaring a clearly standing phone "flat".
    if (lean > 120) lean -= 180;
    else if (lean < -120) lean += 180;
    return lean;
  }
  return null;
}

/**
 * Slack, in degrees, that keeps a green band edge green once it has been
 * reached. A phone resting right on 12° or 18° jitters a few tenths of a
 * degree, which used to flicker the meter between amber and green. DISPLAY
 * ONLY — the readiness gate keeps using the strict band (classifyLean), so
 * nothing outside 12–18° can ever bank steady time.
 */
export const TILT_BAND_HYSTERESIS_DEG = 1.2;

/**
 * Whether the meter should render green, given the previous frame's answer.
 * Entering the band takes the strict window; leaving it takes the strict
 * window plus the hysteresis margin.
 */
export function inReadyBandDisplay(leanDeg: number, wasIn: boolean): boolean {
  const margin = wasIn ? TILT_BAND_HYSTERESIS_DEG : 0;
  return leanDeg >= TILT_READY_MIN_DEG - margin && leanDeg <= TILT_READY_MAX_DEG + margin;
}

export type TiltZone = 'face-down' | 'tilt-back' | 'ready' | 'too-far';

/** Zone for guidance copy; the bar itself renders the continuous angle. */
export function classifyLean(leanDeg: number): TiltZone {
  if (leanDeg < TILT_FACE_DOWN_DEG) return 'face-down';
  if (leanDeg < TILT_READY_MIN_DEG) return 'tilt-back';
  if (leanDeg <= TILT_READY_MAX_DEG) return 'ready';
  return 'too-far';
}

/**
 * Where a lean sits on the level bar: 0 at the top of the track (maximum
 * lean-back shown), 1 at the bottom (tipped forward), 0.5 exactly at the
 * ideal lean. Strictly monotonic inside the displayed span, so every
 * sub-degree change moves the indicator.
 */
export function leanToBarFraction(leanDeg: number): number {
  const clamped = Math.min(TILT_BAR_TOP_DEG, Math.max(TILT_BAR_BOTTOM_DEG, leanDeg));
  return (TILT_BAR_TOP_DEG - clamped) / TILT_BAR_SPAN_DEG;
}

/**
 * Light exponential smoothing so the bar glides over sensor noise without
 * lagging a real correction. At ~20 samples/second an alpha of 0.35
 * settles a step change in roughly a quarter second.
 */
export interface LeanSmoother {
  push(leanDeg: number): number;
  value(): number | null;
  reset(): void;
}

export function createLeanSmoother(alpha = 0.35): LeanSmoother {
  let current: number | null = null;
  return {
    push(leanDeg: number): number {
      current = current === null ? leanDeg : current + alpha * (leanDeg - current);
      return current;
    },
    value: () => current,
    reset() {
      current = null;
    },
  };
}

/** Virtual milliseconds the scripted web lean takes to settle in-band. */
export const SIM_LEAN_SETTLE_MS = 4000;

/**
 * Scripted lean for the web preview feed: starts tipped forward at the floor
 * (bar pinned low, face-down guidance showing), eases back through upright
 * and settles into the ready band with a small live wobble so the level
 * visibly floats like a real sensor. `elapsedMs` is virtual time — the
 * session scales real time by the probe-interval knob, so the suite plays
 * the whole curve in milliseconds while the browser preview takes its
 * preview-paced seconds.
 */
export function simulatedLeanAt(elapsedMs: number): number {
  const t = Math.max(0, elapsedMs) / 1000;
  const wobble = 0.4 * Math.sin(t * 2.1) + 0.25 * Math.sin(t * 5.3);
  const settleS = SIM_LEAN_SETTLE_MS / 1000;
  const target = TILT_IDEAL_DEG + 0.2;
  if (t >= settleS) return target + wobble;
  const p = t / settleS;
  const eased = p * p * (3 - 2 * p);
  return -6 + eased * (target + 6) + wobble * p;
}
