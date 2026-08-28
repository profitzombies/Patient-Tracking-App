/**
 * On-screen hints, screen-reader announcements, and spoken cues for the
 * guided session's line-up stage. The maps are data (the verification
 * suite asserts they stay total); the speech wrapper is the only
 * side-effectful piece — expo-speech rides the platform TTS (native voices,
 * browser speechSynthesis on web) so it works in Expo Go — and it is
 * skipped entirely while a screen reader runs, because VoiceOver/TalkBack
 * already reads every announcement and double narration is worse than none.
 */

import * as Speech from 'expo-speech';

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

let speechBroken = false;

/**
 * Speaks a cue out loud for a patient standing six feet from the phone.
 * No-op while a screen reader runs (announcements cover it) and after the
 * platform TTS proves unavailable — guidance then stays visual.
 */
export function speakCue(text: string, screenReaderActive: boolean): void {
  if (screenReaderActive || speechBroken) return;
  try {
    void Promise.resolve(Speech.stop()).catch(() => undefined);
    Speech.speak(text);
  } catch {
    speechBroken = true;
  }
}

/** Cuts any in-flight speech (leaving the screen, capture handover). */
export function stopCues(): void {
  try {
    void Promise.resolve(Speech.stop()).catch(() => undefined);
  } catch {
    // TTS absent — nothing to stop.
  }
}
