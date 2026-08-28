/**
 * Bundled countdown sounds for the guided photo session, spelled out as
 * static require() calls (Metro's rule) and kept in their own module so
 * the Node verification suite can stub the binary assets away while the
 * component code stays identical.
 */

/** One short tick per countdown second. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const TICK_SOUND = require('@/assets/sounds/countdown-tick.wav');

/** The distinct capture tone at zero, right before the shutter. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const CAPTURE_TONE_SOUND = require('@/assets/sounds/capture-tone.wav');

/** Soft falling notes when the steady hold breaks and resets. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const HOLD_LOST_SOUND = require('@/assets/sounds/hold-lost.wav');
