/**
 * Sound, speech, and haptics for the guided progress-photo session.
 *
 * The patient is six feet from a phone on the floor, so audio carries the
 * flow: the angle name is SPOKEN when each countdown starts, every second
 * ticks audibly (with a light haptic for anyone holding the phone), and a
 * distinct rising chime confirms each auto-capture. Tones are tiny WAV
 * data URIs (lib/session-tones.ts) played through expo-audio; speech goes
 * through expo-speech, which uses the platform voice on device and the
 * browser's speech synthesis on web.
 *
 * Every call is best-effort: a missing speaker, a muted browser tab, or a
 * platform without haptics silently degrades — sound must never wedge a
 * photo session. `ready()` also opts into playing through the iOS silent
 * switch, since a propped-up phone is very likely to have it flipped.
 */
import { Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { ALERT_TONE_URI, CAPTURE_TONE_URI, TICK_TONE_URI } from '@/lib/session-tones';

export interface SessionFeedback {
  /** Configure the audio session (best-effort; safe to call once). */
  ready(): Promise<void>;
  /** Speak a short instruction out loud, replacing any ongoing speech. */
  speak(text: string): void;
  /** Per-second countdown tick: short beep + selection haptic. */
  tick(): void;
  /** Auto-capture confirmation: rising chime + success haptic. */
  capture(): void;
  /** Problem tone (capture/save failure): low notes + warning haptic. */
  alert(): void;
  /** Stop speech and release the audio players. */
  dispose(): void;
}

function safePlayer(uri: string): AudioPlayer | null {
  try {
    return createAudioPlayer({ uri });
  } catch (error) {
    console.warn('Session tone player unavailable', error);
    return null;
  }
}

function replay(player: AudioPlayer | null): void {
  if (!player) return;
  try {
    player.seekTo(0);
    player.play();
  } catch {
    // A tone that fails to play is not worth interrupting the session for.
  }
}

export function createSessionFeedback(): SessionFeedback {
  let tickPlayer: AudioPlayer | null = null;
  let capturePlayer: AudioPlayer | null = null;
  let alertPlayer: AudioPlayer | null = null;
  let disposed = false;

  return {
    async ready() {
      try {
        // The propped-up phone very likely has its ring switch muted.
        await setAudioModeAsync({ playsInSilentMode: true });
      } catch {
        // Web (or a restricted context) — tones may still play.
      }
      if (!disposed && !tickPlayer) {
        tickPlayer = safePlayer(TICK_TONE_URI);
        capturePlayer = safePlayer(CAPTURE_TONE_URI);
        alertPlayer = safePlayer(ALERT_TONE_URI);
      }
    },
    speak(text: string) {
      try {
        Speech.stop();
        Speech.speak(text, { rate: 0.95 });
      } catch {
        // Silent platforms still show the giant on-screen labels.
      }
    },
    tick() {
      replay(tickPlayer);
      if (Platform.OS !== 'web') {
        Haptics.selectionAsync().catch(() => {});
      }
    },
    capture() {
      replay(capturePlayer);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
    },
    alert() {
      replay(alertPlayer);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      }
    },
    dispose() {
      disposed = true;
      try {
        Speech.stop();
      } catch {
        // Nothing to stop.
      }
      for (const player of [tickPlayer, capturePlayer, alertPlayer]) {
        try {
          player?.remove();
        } catch {
          // Already released.
        }
      }
      tickPlayer = null;
      capturePlayer = null;
      alertPlayer = null;
    },
  };
}
