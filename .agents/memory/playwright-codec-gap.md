---
name: Playwright codec gap
description: The testing subagent's bundled Chromium cannot decode H.264/AAC — video-playback e2e needs open-codec fixtures, and players must surface decode failures inline.
---

The Playwright testing subagent runs bundled Chromium, which ships **without proprietary codecs**: H.264 video and AAC audio do not decode. A hosted MP4 that plays fine in real Chrome fails there with `video.error.code=4` ("The element has no supported sources"), `readyState=0`, and a rejected `play()` — which the Vite dev overlay reports as a runtime error if unhandled.

**Why:** an e2e "playback broken" verdict on H.264 content is a false alarm about the app; the server, signed URLs, and range requests can all be healthy (verify with curl: plain GET 200 + `Range:` GET 206).

**How to apply:**
- Encode e2e video fixtures as WebM VP9 + Opus (`ffmpeg -c:v libvpx-vp9 -deadline realtime -cpu-used 7 -crf 34 -b:v 0 -c:a libopus`) — those decode in bundled Chromium. Keep MP4 for API-level checks.
- Any custom `<video>` player must catch `play()` rejections and listen to `onError`, surfacing an inline "this browser can't play this video" message — real-world Safari/codec edge cases hit the same path, and an unhandled rejection reads as a crash in dev.
- TTS narration for fixtures: the AI-integrations proxy has no /audio/speech endpoint; use the media-generation textToSpeech callback instead (note: its outputPath resolves workspace-relative, not absolute).
