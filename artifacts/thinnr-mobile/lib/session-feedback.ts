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

/** Cuts any in-flight speech (leaving the screen, capture handover). */
export function stopCues(): void {
  try {
    void Promise.resolve(Speech.stop()).catch(() => undefined);
  } catch {
    // TTS absent — nothing to stop.
  }
}

export interface SayOptions {
  /**
   * Capture-critical (stage changes, "in position", the countdown): jumps
   * the queue, interrupts a coaching cue, and never waits on the settle.
   */
  priority?: boolean;
  /**
   * Re-checked at the moment the cue would actually be spoken. Returning
   * false drops it — the situation moved on while the previous sentence
   * was still finishing, so saying it now would be a lie.
   */
  stillTrue?: () => boolean;
}

export interface CuePacer {
  /** Requests a spoken cue; the newest coaching request supersedes any waiting one. */
  say(text: string, options?: SayOptions): void;
  /** Cuts speech and drops anything waiting (unmount, capture handover). */
  cancel(): void;
  /** True while an utterance is in flight (diagnostics + verification). */
  isSpeaking(): boolean;
}

export interface CuePacerConfig {
  /** Beat of silence after an utterance ends before the next may start. */
  settleMs: () => number;
  /** Fallback end-of-utterance deadline when the platform never reports one. */
  guardMs: () => number;
  /** True while a screen reader runs — spoken cues stay off entirely. */
  muted: () => boolean;
}

/**
 * The session's single mouth.
 *
 * Line-up statuses can flip several times a second while the patient walks
 * the phone to the wall. Speaking each one immediately — the old behaviour
 * — meant every sentence cut off the one before it, which sounds broken
 * rather than helpful. The pacer serialises speech instead: one utterance
 * at a time, a settle beat afterwards, and then the cue is re-checked
 * against the CURRENT situation before it is allowed out. A cue that is no
 * longer true, or that merely repeats what was just said, is dropped.
 *
 * Only one coaching cue ever waits: a newer request replaces the older one,
 * so the patient hears the latest advice rather than a backlog. Priority
 * cues (stage changes, the countdown) interrupt and are never deduped.
 */
export function createCuePacer(config: CuePacerConfig): CuePacer {
  let speaking = false;
  let waiting: { text: string; stillTrue?: () => boolean } | null = null;
  let lastSpoken: string | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let guardTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped on every new utterance and on cancel, so a late onDone from a
  // superseded utterance cannot un-pause the pacer mid-sentence.
  let generation = 0;

  const clearSettle = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  const clearGuard = (): void => {
    if (guardTimer !== null) {
      clearTimeout(guardTimer);
      guardTimer = null;
    }
  };

  const drain = (): void => {
    if (speaking || settleTimer !== null) return;
    const next = waiting;
    waiting = null;
    if (!next) return;
    if (next.stillTrue && !next.stillTrue()) return;
    if (next.text === lastSpoken) return;
    speakNow(next.text);
  };

  const utteranceEnded = (gen: number): void => {
    if (gen !== generation || !speaking) return;
    speaking = false;
    clearGuard();
    clearSettle();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      drain();
    }, Math.max(0, config.settleMs()));
  };

  function speakNow(text: string): void {
    generation += 1;
    const gen = generation;
    speaking = true;
    lastSpoken = text;
    clearGuard();
    guardTimer = setTimeout(() => {
      // The platform never reported the end of this utterance. Cut it for
      // real before moving on, so the next cue cannot land on top of one
      // that is somehow still going.
      stopCues();
      utteranceEnded(gen);
    }, Math.max(0, config.guardMs()));
    try {
      Speech.speak(text, {
        onDone: () => utteranceEnded(gen),
        onStopped: () => utteranceEnded(gen),
        onError: () => utteranceEnded(gen),
      });
    } catch {
      // TTS absent or broken — stay silent from here on; the on-screen
      // hints and screen-reader announcements carry the guidance.
      speechBroken = true;
      speaking = false;
      clearGuard();
    }
  }

  return {
    say(text, options) {
      if (config.muted() || speechBroken || !text) return;
      if (options?.priority) {
        waiting = null;
        clearSettle();
        if (speaking) {
          generation += 1;
          speaking = false;
          clearGuard();
          stopCues();
        }
        speakNow(text);
        return;
      }
      if (text === lastSpoken && !speaking) return;
      waiting = { text, stillTrue: options?.stillTrue };
      drain();
    },
    cancel() {
      generation += 1;
      waiting = null;
      speaking = false;
      lastSpoken = null;
      clearSettle();
      clearGuard();
      stopCues();
    },
    isSpeaking() {
      return speaking;
    },
  };
}
