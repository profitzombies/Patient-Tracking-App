/**
 * Every word the guided photo session says out loud, in one place.
 *
 * The session speaks from a FIXED script, so each line is recorded once in
 * a real human voice (see `data/guided-voice-clips`) and played back as
 * audio instead of being read by the phone's robotic text-to-speech. That
 * only works while the spoken text and the recording stay in lockstep: the
 * runtime builders below produce the sentences the session actually says,
 * `RECORDED_LINES` holds the sentence each clip was recorded from, and the
 * verification suite asserts the two agree exactly. A line that drifts is
 * caught there rather than quietly falling back to the robot voice in a
 * patient's bathroom.
 *
 * Screen-reader announcements read from these same strings, so the spoken
 * cue and the announced one can never disagree either.
 */

import { COUNTDOWN_SECONDS, GUIDED_ANGLE_LABELS, type GuidedAngle } from './guided-photos';
import type { LineupStatus } from './lineup';

/** Short imperative line shown under the level bar. */
export const LINEUP_HINTS: Record<LineupStatus, string> = {
  'tilt-unavailable': 'Tilt check unavailable — a start button appears shortly',
  'tilt-face-down': 'Tip the phone back — it is facing the floor',
  'tilt-back-more': 'Lean the phone back a touch more',
  'tilt-too-far': 'Stand the phone up a little',
  'too-dark': 'More light needed',
  'too-bright': 'Too bright — angle the phone from the light',
  'not-detected': 'Step into the outline',
  'too-far': 'Come a little closer',
  'too-close': 'Step back a little',
  'off-center': 'Center yourself in the frame',
  ready: 'Perfect — hold still',
};

/** Fuller sentence for screen readers and the spoken cue. */
export const LINEUP_ANNOUNCEMENTS: Record<LineupStatus, string> = {
  'tilt-unavailable':
    'This phone cannot check its tilt. Line up in the outline and use the start anyway button when it appears.',
  'tilt-face-down': 'The phone is tipped toward the floor. Lean its top back against the wall.',
  'tilt-back-more': 'Lean the phone back a little more.',
  'tilt-too-far': 'The phone is leaned too far back. Stand it up a little.',
  'too-dark': 'Too dark. Turn on a light or open the blinds.',
  'too-bright': 'Too bright. Angle the phone away from direct light.',
  'not-detected': 'Step back until your whole body is in view.',
  'too-far': 'Too far away. Take a step toward the phone.',
  'too-close': 'Too close. Take a step back.',
  'off-center': 'Move toward the middle of the frame.',
  ready: 'In position. Hold still.',
};

/** Opening line of a run — the angle it starts on and where to stand. */
export function angleIntroLine(angle: GuidedAngle): string {
  return `${GUIDED_ANGLE_LABELS[angle]} photo first. Step back about six feet and stand in the outline.`;
}

/** Spoken as the countdown starts. */
export function countdownLine(angle: GuidedAngle): string {
  return `In position. Taking the ${GUIDED_ANGLE_LABELS[angle].toLowerCase()} photo in ${COUNTDOWN_SECONDS} seconds. Hold still.`;
}

/** Spoken when one shot lands and the next angle comes up. */
export function nextAngleLine(angle: GuidedAngle): string {
  return `Now the ${GUIDED_ANGLE_LABELS[angle].toLowerCase()} photo. Turn, then hold still in the outline.`;
}

/** The escape hatch surfacing after a long failure to line up. */
export const ESCAPE_LINE =
  'Taking a while to line up — you can start the countdown anyway when you are set.';

/** Tilt works but framing does not: the countdown rides the angle alone. */
export const TILT_FALLBACK_LINE =
  'Automatic position check unavailable. The countdown starts once the phone angle holds steady.';

/** The last thing the session says — every angle is in the can. */
export const ALL_CAPTURED_LINE = 'All photos captured. Review your shots.';

export type VoiceClipKey =
  | `lineup-${LineupStatus}`
  | `intro-${GuidedAngle}`
  | `countdown-${GuidedAngle}`
  | `next-${GuidedAngle}`
  | 'escape'
  | 'fallback-tilt'
  | 'done';

/**
 * The exact sentence each clip was recorded from. Written out literally on
 * purpose: this table is the transcript of the audio files, so it must not
 * be generated from the same builders it exists to check.
 */
export const RECORDED_LINES: Record<VoiceClipKey, string> = {
  'lineup-tilt-unavailable':
    'This phone cannot check its tilt. Line up in the outline and use the start anyway button when it appears.',
  'lineup-tilt-face-down': 'The phone is tipped toward the floor. Lean its top back against the wall.',
  'lineup-tilt-back-more': 'Lean the phone back a little more.',
  'lineup-tilt-too-far': 'The phone is leaned too far back. Stand it up a little.',
  'lineup-too-dark': 'Too dark. Turn on a light or open the blinds.',
  'lineup-too-bright': 'Too bright. Angle the phone away from direct light.',
  'lineup-not-detected': 'Step back until your whole body is in view.',
  'lineup-too-far': 'Too far away. Take a step toward the phone.',
  'lineup-too-close': 'Too close. Take a step back.',
  'lineup-off-center': 'Move toward the middle of the frame.',
  'lineup-ready': 'In position. Hold still.',
  'intro-front': 'Front photo first. Step back about six feet and stand in the outline.',
  'intro-side': 'Side photo first. Step back about six feet and stand in the outline.',
  'intro-back': 'Back photo first. Step back about six feet and stand in the outline.',
  'countdown-front': 'In position. Taking the front photo in 7 seconds. Hold still.',
  'countdown-side': 'In position. Taking the side photo in 7 seconds. Hold still.',
  'countdown-back': 'In position. Taking the back photo in 7 seconds. Hold still.',
  'next-front': 'Now the front photo. Turn, then hold still in the outline.',
  'next-side': 'Now the side photo. Turn, then hold still in the outline.',
  'next-back': 'Now the back photo. Turn, then hold still in the outline.',
  escape: 'Taking a while to line up — you can start the countdown anyway when you are set.',
  'fallback-tilt':
    'Automatic position check unavailable. The countdown starts once the phone angle holds steady.',
  done: 'All photos captured. Review your shots.',
};

const KEY_BY_LINE = new Map<string, VoiceClipKey>(
  (Object.entries(RECORDED_LINES) as Array<[VoiceClipKey, string]>).map(([key, line]) => [line, key]),
);

/**
 * The recorded clip for a sentence, or null when nothing was recorded for
 * it — the caller then falls back to the platform voice rather than going
 * silent.
 */
export function voiceClipKeyFor(text: string): VoiceClipKey | null {
  return KEY_BY_LINE.get(text) ?? null;
}
