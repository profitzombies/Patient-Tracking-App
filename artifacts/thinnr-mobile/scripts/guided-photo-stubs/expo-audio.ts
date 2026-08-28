/**
 * Node stand-in for expo-audio: players record their source and every
 * play/seek, so the suite can count ticks per countdown second and the
 * capture tone at zero (identified by the stubbed sound-source sentinels).
 */
export class StubAudioPlayer {
  plays = 0;
  seeks: number[] = [];
  removed = false;

  constructor(public readonly source: unknown) {}

  play(): void {
    this.plays += 1;
  }

  async seekTo(seconds: number): Promise<void> {
    this.seeks.push(seconds);
  }

  remove(): void {
    this.removed = true;
  }
}

export type AudioPlayer = StubAudioPlayer;

export const audioState = {
  players: [] as StubAudioPlayer[],
  modeCalls: [] as Array<Record<string, unknown>>,
  reset(): void {
    audioState.players.length = 0;
    audioState.modeCalls.length = 0;
  },
};

export function createAudioPlayer(source: unknown): StubAudioPlayer {
  const player = new StubAudioPlayer(source);
  audioState.players.push(player);
  return player;
}

export async function setAudioModeAsync(mode: Record<string, unknown>): Promise<void> {
  audioState.modeCalls.push(mode);
}
