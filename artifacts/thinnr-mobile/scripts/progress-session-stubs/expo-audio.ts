/**
 * Node stand-in for expo-audio: players are inert but every play() is
 * counted per source uri, so the suite can prove the countdown ticks
 * audibly, captures chime, and failures alert — and that the audio mode
 * opted into playing through the iOS silent switch.
 */
export interface AudioPlayer {
  seekTo(seconds: number): void;
  play(): void;
  remove(): void;
}

export const audioLog = {
  modeCalls: [] as unknown[],
  created: [] as string[],
  plays: new Map<string, number>(),
};

export function resetAudioLog(): void {
  audioLog.modeCalls.length = 0;
  audioLog.created.length = 0;
  audioLog.plays.clear();
}

export async function setAudioModeAsync(mode: unknown): Promise<void> {
  audioLog.modeCalls.push(mode);
}

export function createAudioPlayer(source: { uri: string }): AudioPlayer {
  audioLog.created.push(source.uri);
  return {
    seekTo(): void {},
    play(): void {
      audioLog.plays.set(source.uri, (audioLog.plays.get(source.uri) ?? 0) + 1);
    },
    remove(): void {},
  };
}
