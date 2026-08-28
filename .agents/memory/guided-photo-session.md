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
- **Spoken cues defer to screen readers** (announcements already speak; double narration is worse than none). Muting future cues is not enough: switching VoiceOver on mid-sentence must CANCEL the utterance in flight, or two voices talk over each other.
- **One pacer owns all speech:** serialise utterances (one at a time + a settle beat), let only the newest coaching cue wait, drop a cue whose situation moved on (per-cue `stillTrue`), and give stage/countdown cues a priority lane that interrupts. A generation counter stops a late `onDone` from a superseded utterance un-pausing the queue, and a guard timer (which stops speech first) covers platforms that never report the end. Speech stubs must model duration + overlap, or "no pile-up" cannot be proven.
  **Why:** stop-then-speak per cue produced exactly the demo complaint — clipped, spammy narration.
- **A no-signal gap IS information:** trusted-gravity samples stop arriving while the phone is being carried, so a stale last angle must not keep banking steady time. Show a "settling" readout, pause the hold, and on resume RESET the smoother and snap the indicator instead of gliding from history. Indicator motion should be a LINEAR glide sized to the measured sample gap; a fixed ease that outlives the sample interval never finishes and looks laggy.
  **How to apply:** burst-emit test scenarios starve that feed — wait with a helper that keeps pumping motion, or widen the staleness knob for scenarios not about settling.
- **Display hysteresis, gate strictness:** band-edge hysteresis and a status confirmation window are display+speech only; the readiness gate keeps consuming raw verdicts so hold semantics never loosen.
- **A faded overlay needs a driven animation:** hiding it from the a11y tree (and asserting that flag) passes while the graphic is still fully drawn — assert the opacity value too.
- **Auto-start latches the HYDRATED pref**, never live checkbox state.
  **How to apply:** any persisted-preference fast-path that acts on mount must distinguish hydration from a same-session edit.
- **Cadence injectable:** countdown/probe/gate/hold/escape intervals live behind module knobs so suites run full sessions in tens of ms; the capture tone fires BEFORE the capture attempt so a failed shutter still signals.
- **tsx stub suites:** tsconfig paths only rewrite imports tsx transforms — one real node_modules package anywhere in the mounted tree drags in real react-native (opaque flow-syntax TransformError); locate culprits with sequential dynamic-import probes, keep binary require()s in a tiny stub-able data module, and match scripted-fetch endpoints by exact URL (substring matching absorbs route-drift mutations).
