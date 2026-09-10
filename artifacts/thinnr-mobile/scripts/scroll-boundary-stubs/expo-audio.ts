export type AudioPlayer = { play(): void; pause(): void };
export function useAudioPlayer(): AudioPlayer {
  return { play() {}, pause() {} };
}
export function createAudioPlayer(): AudioPlayer {
  return { play() {}, pause() {} };
}
export async function setAudioModeAsync(_options: unknown): Promise<void> {}