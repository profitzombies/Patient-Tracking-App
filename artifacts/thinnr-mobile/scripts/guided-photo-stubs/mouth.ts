/**
 * The session's one mouth, shared by the two stubs that can speak.
 *
 * Coaching lines play as recorded clips through expo-audio, and anything
 * without a recording falls back to expo-speech — but from the patient's
 * side there is only ever ONE voice in the room. Both stubs therefore
 * record into this single ledger, so the suite's overlap and interruption
 * assertions cover the real thing regardless of which engine spoke.
 *
 * Speaking takes TIME and reports its end, the way both platforms behave:
 * an utterance finishes on a timer (`autoFinishMs`) so whole sessions still
 * run in milliseconds, and any line that starts while another is live
 * counts as an overlap — the exact fault the cue pacer exists to prevent.
 */

export interface MouthHandlers {
  /** The line ran to its end. */
  onDone?: () => void;
  /** The line was cut off. */
  onStopped?: () => void;
}

interface Active {
  text: string;
  handlers: MouthHandlers;
  timer: ReturnType<typeof setTimeout> | null;
}

export const speechState = {
  spoken: [] as string[],
  stops: 0,
  /** Lines that started while another was still in flight. */
  overlaps: 0,
  /** Lines cut off before they finished. */
  interrupted: [] as string[],
  /** Simulated line duration. */
  autoFinishMs: 5,
  /**
   * Whether a recorded line tells the pacer how long it runs. Off models a
   * player that never reports anything — the case the guard exists for.
   */
  reportsLength: true,
  active: null as Active | null,
  reset(): void {
    if (speechState.active?.timer) clearTimeout(speechState.active.timer);
    speechState.spoken.length = 0;
    speechState.interrupted.length = 0;
    speechState.stops = 0;
    speechState.overlaps = 0;
    speechState.autoFinishMs = 5;
    speechState.reportsLength = true;
    speechState.active = null;
  },
  /** Ends the line being said now (fires its done handler). */
  finish(): void {
    const current = speechState.active;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    speechState.active = null;
    current.handlers.onDone?.();
  },
};

/** Starts saying a line; it finishes on its own after `autoFinishMs`. */
export function beginUtterance(text: string, handlers: MouthHandlers): void {
  if (speechState.active) speechState.overlaps += 1;
  speechState.spoken.push(text);
  const entry: Active = { text, handlers, timer: null };
  speechState.active = entry;
  entry.timer = setTimeout(() => {
    if (speechState.active !== entry) return;
    speechState.active = null;
    handlers.onDone?.();
  }, speechState.autoFinishMs);
}

/** A stop request: counted whether or not it caught anything mid-sentence. */
export function stopUtterance(): void {
  speechState.stops += 1;
  const current = speechState.active;
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  speechState.active = null;
  speechState.interrupted.push(current.text);
  current.handlers.onStopped?.();
}

/** True while a line is being said (either engine). */
export function isSpeaking(): boolean {
  return speechState.active !== null;
}
