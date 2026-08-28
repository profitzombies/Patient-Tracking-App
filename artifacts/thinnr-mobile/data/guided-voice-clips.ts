/**
 * The recorded coaching voice for the guided photo session.
 *
 * One short clip per fixed line of the script, spelled out as static
 * require() calls (Metro's rule) and kept in their own module so the Node
 * verification suite can stub the binary assets away while the component
 * and playback code stay identical.
 *
 * The transcript of these files lives in `lib/session-lines` — change a
 * spoken line there and the clip has to be re-recorded to match, which the
 * suite enforces.
 */

import type { VoiceClipKey } from '@/lib/session-lines';

/* eslint-disable @typescript-eslint/no-require-imports */
export const GUIDED_VOICE_CLIPS: Record<VoiceClipKey, unknown> = {
  'lineup-tilt-unavailable': require('@/assets/audio/guided/lineup-tilt-unavailable.mp3'),
  'lineup-tilt-face-down': require('@/assets/audio/guided/lineup-tilt-face-down.mp3'),
  'lineup-tilt-back-more': require('@/assets/audio/guided/lineup-tilt-back-more.mp3'),
  'lineup-tilt-too-far': require('@/assets/audio/guided/lineup-tilt-too-far.mp3'),
  'lineup-too-dark': require('@/assets/audio/guided/lineup-too-dark.mp3'),
  'lineup-too-bright': require('@/assets/audio/guided/lineup-too-bright.mp3'),
  'lineup-not-detected': require('@/assets/audio/guided/lineup-not-detected.mp3'),
  'lineup-too-far': require('@/assets/audio/guided/lineup-too-far.mp3'),
  'lineup-too-close': require('@/assets/audio/guided/lineup-too-close.mp3'),
  'lineup-off-center': require('@/assets/audio/guided/lineup-off-center.mp3'),
  'lineup-ready': require('@/assets/audio/guided/lineup-ready.mp3'),
  'intro-front': require('@/assets/audio/guided/intro-front.mp3'),
  'intro-side': require('@/assets/audio/guided/intro-side.mp3'),
  'intro-back': require('@/assets/audio/guided/intro-back.mp3'),
  'countdown-front': require('@/assets/audio/guided/countdown-front.mp3'),
  'countdown-side': require('@/assets/audio/guided/countdown-side.mp3'),
  'countdown-back': require('@/assets/audio/guided/countdown-back.mp3'),
  'next-front': require('@/assets/audio/guided/next-front.mp3'),
  'next-side': require('@/assets/audio/guided/next-side.mp3'),
  'next-back': require('@/assets/audio/guided/next-back.mp3'),
  escape: require('@/assets/audio/guided/escape.mp3'),
  'fallback-tilt': require('@/assets/audio/guided/fallback-tilt.mp3'),
  done: require('@/assets/audio/guided/done.mp3'),
};
/* eslint-enable @typescript-eslint/no-require-imports */
