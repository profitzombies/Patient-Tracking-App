---
name: Guided photo session
description: Patterns from the hands-free progress-photo flow — no-AI positioning gate, hydrated-pref auto-start, tsx stub-suite lessons
---

# Guided photo session patterns

- **No-AI positioning gate:** ~1 Hz probes take a tiny throwaway capture (quality 0.2, shutterSound false) → resize to an 18px-wide PNG → decode to luma in plain JS. Ordered checks (light → presence → size → centering) map to one hint each; 3 consecutive ready probes auto-start the countdown; per-angle re-settle resets the streak. Web runs the same loop on a simulated frame series. Probes unavailable (2 null probes) → announce once + timed fallback starts the countdown anyway; a manual "Start now" stays visible throughout.
  **Why:** works offline with zero ML deps and is fully testable in Node.
- **Auto-start latches the HYDRATED pref:** the "skip instructions" fast-path fires off the value AS READ FROM STORAGE (kept in a ref), never live checkbox state — otherwise ticking the box mid-setup launches the session out from under the user.
  **How to apply:** any persisted-preference fast-path that triggers an action on mount must distinguish hydration from a user edit in the same session.
- **Cadence injectable:** countdown tick and probe intervals live behind set/get*IntervalMs module knobs so suites run fast; tick sound + haptic each second, distinct tone at zero played BEFORE the capture attempt so a failed capture still signals.
- **tsx stub suites:** tsconfig paths only rewrite imports in files tsx itself transforms — a real node_modules package anywhere in the mounted tree (e.g. react-native-keyboard-controller via a shared scroll wrapper) drags in real react-native and kills the run with a flow-syntax TransformError. Find the culprit with a probe script of sequential dynamic imports (static imports fail as one opaque block). Binary asset require()s (wav/jpg) must live in their own tiny data module so suites can stub that module wholesale.
- **Mutation-test the fetch mock too:** substring URL matching in a scripted fetch silently absorbs route-drift mutations; match mocked endpoints by exact URL.
