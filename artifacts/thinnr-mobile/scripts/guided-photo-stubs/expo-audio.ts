/**
 * Node stand-in for expo-audio.
 *
 * Two kinds of player pass through here:
 *  - SOUND players (countdown tick, capture tone, hold lost): they record
 *    their source and every play/seek, so the suite can count ticks per
 *    countdown second and the tone at zero.
 *  - VOICE players: the recorded coaching lines. Playing one is the session
 *    SPEAKING, so it books through the shared mouth (see ./mouth) exactly
 *    as the platform voice does, reports the clip's length the way a loaded
 *    player does, and fires didJustFinish at the end.
 */

import { beginUtterance, speechState, stopUtterance } from './mouth';
import type { VoiceClipSentinel } from './guided-voice-clips';

interface PlaybackStatus {
  duration: number;
  didJustFinish: boolean;
}

type StatusListener = (status: PlaybackStatus) => void;

function voiceOf(source: unknown): VoiceClipSentinel | null {
  if (source && typeof source === 'object' && 'voice' in source) {
    return source as VoiceClipSentinel;
  }
  return null;
}

export class StubAudioPlayer {
  plays = 0;
  seeks: number[] = [];
  removed = false;
  paused = 0;
  private listeners = new Set<StatusListener>();
  private readonly voice: VoiceClipSentinel | null;

  constructor(public readonly source: unknown) {
    this.voice = voiceOf(source);
  }

  addListener(event: string, listener: StatusListener): { remove: () => void } {
    if (event !== 'playbackStatusUpdate') return { remove: () => {} };
    this.listeners.add(listener);
    return {
      remove: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private emit(status: PlaybackStatus): void {
    for (const listener of [...this.listeners]) listener(status);
  }

  play(): void {
    this.plays += 1;
    if (!this.voice) return;
    const lengthSeconds = speechState.autoFinishMs / 1000;
    beginUtterance(this.voice.text, {
      onDone: () => this.emit({ duration: lengthSeconds, didJustFinish: true }),
    });
    // A loaded player knows how long the recording runs before it ends.
    if (speechState.reportsLength) {
      setTimeout(() => this.emit({ duration: lengthSeconds, didJustFinish: false }), 0);
    }
  }

  pause(): void {
    this.paused += 1;
    if (this.voice) stopUtterance();
  }

  async seekTo(seconds: number): Promise<void> {
    this.seeks.push(seconds);
  }

  remove(): void {
    this.removed = true;
    this.listeners.clear();
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
