/**
 * The guided session's line-up feedback: on-screen hints, screen-reader
 * announcements, and the pacing of the spoken coach.
 *
 * The words themselves live in `session-lines` (one script, checked against
 * the recordings) and the sound of them lives in `session-voice` (recorded
 * clips, platform voice only as a fallback). What is left here is the
 * PACING — one mouth, one sentence at a time — and it is skipped entirely
 * while a screen reader runs, because VoiceOver/TalkBack already reads
 * every announcement and double narration is worse than none.
 */

import { LINEUP_ANNOUNCEMENTS, LINEUP_HINTS } from './session-lines';
import { speakLine, stopVoice } from './session-voice';

export { LINEUP_ANNOUNCEMENTS, LINEUP_HINTS };

let speechBroken = false;

/** Cuts any in-flight speech (leaving the screen, capture handover). */
export function stopCues(): void {
  stopVoice();
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

  const armGuard = (gen: number, ms: number): void => {
    clearGuard();
    guardTimer = setTimeout(() => {
      // Nothing reported the end of this line. Cut it for real before
      // moving on, so the next cue cannot land on top of one that is
      // somehow still going.
      stopCues();
      utteranceEnded(gen);
    }, Math.max(0, ms));
  };

  function speakNow(text: string): void {
    generation += 1;
    const gen = generation;
    speaking = true;
    lastSpoken = text;
    armGuard(gen, config.guardMs());
    try {
      speakLine(text, {
        onDone: () => utteranceEnded(gen),
        onError: () => utteranceEnded(gen),
        // A recorded line knows exactly how long it runs, so the safety net
        // is sized to the audio itself: a long line is never cut off part
        // way through, and a short one never holds the mouth shut.
        onLength: ms => {
          if (gen !== generation || !speaking) return;
          armGuard(gen, ms + 1500);
        },
      });
    } catch {
      // No voice at all on this platform — stay silent from here on; the
      // on-screen hints and screen-reader announcements carry the guidance.
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
