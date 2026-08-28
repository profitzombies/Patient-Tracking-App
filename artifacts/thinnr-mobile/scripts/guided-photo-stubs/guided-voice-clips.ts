/**
 * Node stand-in for data/guided-voice-clips (static .mp3 require()s).
 *
 * Each sentinel carries the line it was recorded from, so the expo-audio
 * stub can report a playing clip as spoken WORDS — the suite then asserts
 * what the session says without caring which engine said it. The real
 * module's clip files are checked separately, on disk.
 */

import { RECORDED_LINES, type VoiceClipKey } from '@/lib/session-lines';

export interface VoiceClipSentinel {
  voice: VoiceClipKey;
  text: string;
}

export const GUIDED_VOICE_CLIPS = Object.fromEntries(
  (Object.entries(RECORDED_LINES) as Array<[VoiceClipKey, string]>).map(([key, text]) => [
    key,
    { voice: key, text },
  ]),
) as Record<VoiceClipKey, VoiceClipSentinel>;
