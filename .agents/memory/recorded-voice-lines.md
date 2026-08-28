---
name: Recorded voice lines (guided photo coaching)
description: How pre-recorded speech clips replace platform TTS in the mobile app — script/transcript lockstep, clip-length guards, camera audio handover, and how the Node suite proves it.
---

# Recorded voice lines instead of platform text-to-speech

Spoken coaching in the mobile app plays **pre-generated audio clips** through the
same expo-audio pipeline as the session's tones, with platform TTS kept only as a
fallback for text that has no recording.

**Why:** platform TTS sounds robotic, and it is a *separate* audio engine from the
app's own sounds — so it gets cut off by things the app's own playback survives.

## Rules that keep it working

- **One script module is the source of truth.** Line builders and the literal
  transcript of every recording live side by side, with a reverse lookup from text
  to clip. A line that drifts from its recording silently degrades to the robot
  voice, so the verification suite asserts every builder-produced line maps to a
  recording, that the recording count matches exactly, and that each clip is wired
  by a static `require()` and exists on disk with a plausible size.
- **Layer the modules leaf-first** (words → playback → pacing) or the pacer and the
  player import each other.
- **Size any "stuck utterance" guard to the clip.** A blind fixed deadline cuts long
  recordings mid-word; re-arm it from the duration the player reports.
- **A camera teardown takes the audio session with it.** A line started in the same
  tick as the stage change that unmounts the camera gets chopped. Defer it by a
  short, injectable handover delay — and cancel that pending line whenever a new
  run starts, or it chases the user into the next screen.
- **Metro serves bundled media at `/assets/?unstable_path=<url-encoded path>`**, not
  at the literal asset path. Curl that form to prove a clip ships; a 404 on
  `/assets/audio/...` proves nothing.

## Testing them in Node

Both the audio stub and the speech stub book through **one shared "mouth" ledger**,
so overlap, interruption and stop assertions stay true no matter which engine spoke.
The stub reports a clip length only when asked to, which lets one scenario prove the
length-sized guard and another prove the blind guard still rescues a silent platform.
