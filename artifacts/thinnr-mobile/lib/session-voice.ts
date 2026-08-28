/**
 * The guided session's voice.
 *
 * Every line of the session's script is pre-recorded in a real human voice
 * (see `data/guided-voice-clips`), so coaching plays back as audio rather
 * than being read out by the phone's synthesiser. Two reasons this is not
 * cosmetic:
 *
 *  - The platform voice sounds like a robot reading a form, which is a poor
 *    thing to hear in your bathroom while undressed for a progress photo.
 *  - Platform TTS is a SEPARATE audio engine from the session's tones, and
 *    on a phone the camera tearing down its audio session (exactly what
 *    happens as the last shot lands) can cut a synthesised sentence off
 *    mid-word. A recorded clip plays through the same audio pipeline as the
 *    shutter tone and reports its real end, so the closing line finishes.
 *
 * Anything without a recording — a line that drifted from its clip — still
 * gets spoken by the platform voice rather than going silent. The
 * verification suite fails on that drift, so it never ships.
 */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Speech from 'expo-speech';

import { GUIDED_VOICE_CLIPS } from '@/data/guided-voice-clips';

import { voiceClipKeyFor, type VoiceClipKey } from './session-lines';

export interface VoiceHandlers {
  /** The line finished (or was ended by the platform). */
  onDone: () => void;
  /** Nothing could be played — the caller carries on without audio. */
  onError: () => void;
  /**
   * The real length of the recording, once the player knows it. The pacer
   * sizes its safety net around the actual audio instead of a guess.
   */
  onLength?: (ms: number) => void;
}

/** Players are built on first use and kept — a session repeats its lines. */
const players = new Map<VoiceClipKey, AudioPlayer>();

interface ActiveClip {
  player: AudioPlayer;
  subscription: { remove(): void } | null;
}

let active: ActiveClip | null = null;
let audioModeSet = false;
let clipsBroken = false;

function playerFor(key: VoiceClipKey): AudioPlayer | null {
  const cached = players.get(key);
  if (cached) return cached;
  const source = GUIDED_VOICE_CLIPS[key];
  if (!source) return null;
  try {
    if (!audioModeSet) {
      audioModeSet = true;
      // Coaching has to be audible on a phone flipped to silent — the
      // patient is across the room and cannot see the screen.
      void Promise.resolve(setAudioModeAsync({ playsInSilentMode: true })).catch(() => undefined);
    }
    const player = createAudioPlayer(source as never);
    players.set(key, player);
    return player;
  } catch {
    // No audio stack at all — fall back to the platform voice from here on.
    clipsBroken = true;
    return null;
  }
}

function playClip(player: AudioPlayer, handlers: VoiceHandlers): boolean {
  let ended = false;
  let lengthReported = false;
  let entry: ActiveClip | null = null;

  const detach = (): void => {
    if (entry && active === entry) active = null;
    try {
      entry?.subscription?.remove();
    } catch {
      // Listener already gone.
    }
  };

  const end = (report: () => void): void => {
    if (ended) return;
    ended = true;
    detach();
    report();
  };

  try {
    const subscription = player.addListener('playbackStatusUpdate', status => {
      if (!status) return;
      const seconds = status.duration;
      if (!lengthReported && typeof seconds === 'number' && seconds > 0) {
        lengthReported = true;
        handlers.onLength?.(Math.round(seconds * 1000));
      }
      if (status.didJustFinish) end(handlers.onDone);
    });
    entry = { player, subscription };
    active = entry;
    void Promise.resolve(player.seekTo(0)).catch(() => undefined);
    player.play();
    return true;
  } catch {
    end(handlers.onError);
    return false;
  }
}

function speakWithPlatformVoice(text: string, handlers: VoiceHandlers): void {
  let ended = false;
  const end = (report: () => void): void => {
    if (ended) return;
    ended = true;
    report();
  };
  try {
    Speech.speak(text, {
      onDone: () => end(handlers.onDone),
      onStopped: () => end(handlers.onDone),
      onError: () => end(handlers.onError),
    });
  } catch {
    end(handlers.onError);
  }
}

/** Says one line: its recording when there is one, the platform voice otherwise. */
export function speakLine(text: string, handlers: VoiceHandlers): void {
  const key = clipsBroken ? null : voiceClipKeyFor(text);
  if (key) {
    const player = playerFor(key);
    if (player && playClip(player, handlers)) return;
  }
  speakWithPlatformVoice(text, handlers);
}

/** Cuts whatever is being said right now. */
export function stopVoice(): void {
  const current = active;
  if (current) {
    active = null;
    try {
      current.subscription?.remove();
    } catch {
      // Listener already gone.
    }
    try {
      current.player.pause();
    } catch {
      // Player already released.
    }
    return;
  }
  try {
    void Promise.resolve(Speech.stop()).catch(() => undefined);
  } catch {
    // No TTS on this platform — nothing to stop.
  }
}

/** Frees the recordings when the session closes. */
export function releaseVoice(): void {
  stopVoice();
  for (const player of players.values()) {
    try {
      player.remove();
    } catch {
      // Already released.
    }
  }
  players.clear();
}
