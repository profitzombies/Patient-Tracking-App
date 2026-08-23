---
name: Menu photo scan
description: Patterns proven by the menu-scan flow — vision input through the AI proxy, per-route large JSON bodies, structured non-error outcomes, client-side image prep.
---

# Menu photo scan patterns

- **Vision works through the AI proxy.** The same chat model the coach uses accepts
  `image_url` content parts with `data:image/jpeg;base64,...` URIs — no separate
  vision model or key needed. Ask for `response_format: json_object` and keep the
  one-corrective-retry JSON validation pattern from the recipe flow.
  **Why:** probing this first (a tiny standalone script against the proxy) avoided
  building a whole feature on an unverified assumption.

- **Photo-sized bodies are route-local.** A route that accepts an image data URI
  mounts its own `express.json({ limit })` and the app-level parser must *skip that
  path* (otherwise the global 100kb guard rejects the body first — or worse, the
  global limit gets raised for every route). Cap the *decoded* image size separately
  and answer 413 with a friendly message; the client also maps a proxy-level
  non-JSON 413 to the same wording.

- **"Not a menu" / "unreadable" are structured outcomes, not errors.** The scan
  result carries `result: ok | not_menu | unreadable` + a user-facing `message`.
  The UI renders non-ok outcomes as warn-tone announced notices and true failures
  (transport/AI down) as risk-tone announced errors — in *every* case the prepared
  photo stays in state so retry is one tap, never a re-take.
  **How to apply:** any future photo-analysis flow should use a phase state machine
  (`pick → preview → scanning → results | notice | error`) with the photo carried in
  each phase, plus AbortController for cancel (abort on unmount; ignore aborts in
  catch).

- **Client image prep (expo-image-manipulator v14 object API):**
  `ImageManipulator.manipulate(uri)` → `.resize()` (longest edge ~1600 is plenty for
  menu print) → `renderAsync()` → `saveAsync({ format: JPEG, compress: ~0.7, base64: true })`.
  On web, ask the picker for `base64: true` and feed the manipulator a data URI
  (blob: URIs are flaky), and fall back to parsing base64 out of `saved.uri` when
  `saved.base64` is missing.

- **Expectations:** a scan is one real model call, ~12–25s. Say so in the waiting
  copy ("about half a minute") and let e2e tests wait up to 90s. Expo typed routes
  only regenerate when Metro (re)starts — a brand-new screen fails root typecheck
  until the expo workflow restarts.
