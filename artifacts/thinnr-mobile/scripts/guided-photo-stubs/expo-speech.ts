/**
 * Node stand-in for expo-speech: records every spoken line-up cue so the
 * suite can assert the session talks (and stays quiet for screen readers).
 *
 * Utterances are modelled the way the platform behaves: speaking takes
 * TIME and reports its end through onDone. The stub finishes the current
 * utterance on a timer (`autoFinishMs`) so whole sessions still run in
 * milliseconds, and counts any speak() that arrives while another
 * utterance is live as an overlap — the exact fault the cue pacer exists
 * to prevent.
 */

interface SpeechOptions {
  onDone?: () => void;
  onStopped?: () => void;
  onError?: () => void;
  [key: string]: unknown;
}

interface Active {
  text: string;
  options?: SpeechOptions;
  timer: ReturnType<typeof setTimeout> | null;
}

export const speechState = {
  spoken: [] as string[],
  stops: 0,
  /** speak() calls that landed while an utterance was still in flight. */
  overlaps: 0,
  /** Utterances cut off by a stop() before they finished. */
  interrupted: [] as string[],
  /** Simulated utterance duration. */
  autoFinishMs: 5,
  active: null as Active | null,
  reset(): void {
    if (speechState.active?.timer) clearTimeout(speechState.active.timer);
    speechState.spoken.length = 0;
    speechState.interrupted.length = 0;
    speechState.stops = 0;
    speechState.overlaps = 0;
    speechState.autoFinishMs = 5;
    speechState.active = null;
  },
  /** Ends the current utterance now (fires onDone). */
  finish(): void {
    const current = speechState.active;
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    speechState.active = null;
    current.options?.onDone?.();
  },
};

export function speak(text: string, options?: SpeechOptions): void {
  if (speechState.active) speechState.overlaps += 1;
  speechState.spoken.push(text);
  const entry: Active = { text, options, timer: null };
  speechState.active = entry;
  entry.timer = setTimeout(() => {
    if (speechState.active !== entry) return;
    speechState.active = null;
    options?.onDone?.();
  }, speechState.autoFinishMs);
}

export async function stop(): Promise<void> {
  speechState.stops += 1;
  const current = speechState.active;
  if (!current) return;
  if (current.timer) clearTimeout(current.timer);
  speechState.active = null;
  speechState.interrupted.push(current.text);
  current.options?.onStopped?.();
}

export async function isSpeakingAsync(): Promise<boolean> {
  return speechState.active !== null;
}
