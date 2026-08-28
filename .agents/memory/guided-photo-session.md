---
name: Guided photo session
description: Durable decisions from the hands-free progress-photo flow — no-AI line-up gate, gravity-only tilt trust, degraded-sensor posture, stub-suite lessons
---

# Guided photo session decisions

- **No-AI line-up gate:** cheap low-res luma probes feed ordered checks (light → presence → size → centering) that combine with tilt into ONE status; all-green must hold ~5 s to auto-start the countdown, a meaningful break resets audibly, and the "Start anyway" escape appears only after prolonged failure — never before. The web demo drives the same engine with simulated frames on virtual time scaled by the probe-interval knob, so speed knobs scale the whole choreography.
  **Why:** works offline with zero ML deps and is fully testable in Node.
- **Tilt readiness requires a live gravity angle — beta is never consulted:** rotation beta folds face-down onto leaned-back, so ANY beta-derived lean can fabricate green with the phone facing the floor (the original demo bug; code review re-flagged it when beta survived as a "fallback"). Lean = atan2(gravityZ, gravityY) with a hemisphere fold; weak or missing gravity yields null → status "tilt unavailable", which can NEVER go green — only the explicit delayed escape (or the announced probes-gone timed fallback) may start capture.
  **Why:** a degraded sensor path that guesses reintroduces the exact false-green the gate exists to kill.
- **Stubbed suites cannot see build config:** native permissions need their config plugin in app.json (expo-sensors → NSMotionUsageDescription) or production iOS builds cannot grant them at all; Expo Go masks the omission. Pair any native-module permission with a suite section that parses app.json.
- **Freeze the background model while ready:** classify each frame BEFORE updating the adaptive background and stop absorbing while status is ready — otherwise a patient holding still for the gate melts into the background mid-hold.
- **Spoken cues defer to screen readers** (announcements already speak; double narration is worse than none) and stop-then-speak per cue so stale hints never queue.
- **Auto-start latches the HYDRATED pref**, never live checkbox state.
  **How to apply:** any persisted-preference fast-path that acts on mount must distinguish hydration from a same-session edit.
- **Cadence injectable:** countdown/probe/gate/hold/escape intervals live behind module knobs so suites run full sessions in tens of ms; the capture tone fires BEFORE the capture attempt so a failed shutter still signals.
- **tsx stub suites:** tsconfig paths only rewrite imports tsx transforms — one real node_modules package anywhere in the mounted tree drags in real react-native (opaque flow-syntax TransformError); locate culprits with sequential dynamic-import probes, keep binary require()s in a tiny stub-able data module, and match scripted-fetch endpoints by exact URL (substring matching absorbs route-drift mutations).
