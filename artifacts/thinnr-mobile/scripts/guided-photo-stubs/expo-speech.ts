/**
 * Node stand-in for expo-speech: records every spoken line-up cue so the
 * suite can assert the session talks (and stays quiet for screen readers).
 */
export const speechState = {
  spoken: [] as string[],
  stops: 0,
  reset(): void {
    speechState.spoken.length = 0;
    speechState.stops = 0;
  },
};

export function speak(text: string, _options?: Record<string, unknown>): void {
  speechState.spoken.push(text);
}

export async function stop(): Promise<void> {
  speechState.stops += 1;
}
