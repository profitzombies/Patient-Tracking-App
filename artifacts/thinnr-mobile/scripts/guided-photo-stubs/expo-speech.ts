/**
 * Node stand-in for expo-speech — the platform voice, which is now only
 * the FALLBACK for a line that has no recording. It records into the
 * shared mouth (see ./mouth) so a fallback line and a recorded one are
 * held to the same one-voice-at-a-time rules.
 */

import { beginUtterance, isSpeaking, speechState, stopUtterance } from './mouth';

interface SpeechOptions {
  onDone?: () => void;
  onStopped?: () => void;
  onError?: () => void;
  [key: string]: unknown;
}

export { speechState };

export function speak(text: string, options?: SpeechOptions): void {
  beginUtterance(text, { onDone: options?.onDone, onStopped: options?.onStopped });
}

export async function stop(): Promise<void> {
  stopUtterance();
}

export async function isSpeakingAsync(): Promise<boolean> {
  return isSpeaking();
}
