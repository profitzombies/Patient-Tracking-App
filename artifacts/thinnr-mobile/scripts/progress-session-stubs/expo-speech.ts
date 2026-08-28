/**
 * Node stand-in for expo-speech: records everything spoken so the suite
 * can assert the guided session announces each pose, the review verdict,
 * and the save confirmation.
 */
export const spoken: string[] = [];
export const stopCalls = { count: 0 };

export function speak(text: string, _options?: unknown): void {
  spoken.push(text);
}

export function stop(): void {
  stopCalls.count += 1;
}

export function resetSpeechLog(): void {
  spoken.length = 0;
  stopCalls.count = 0;
}
