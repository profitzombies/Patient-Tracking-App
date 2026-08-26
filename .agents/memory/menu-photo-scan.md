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

## Chat photo turns (coach conversation)

- **The image rides ONLY the request tail.** The chat request stays text-shaped;
  an optional image data-URI field is honored solely on the latest user message.
  Client-side, photo turns keep the prepared photo on the message object and
  replay as a fixed stand-in line — a photo is never uploaded twice, and retry
  re-attaches the kept photo to the tail (one tap, no re-take).
  **Why:** replaying multi-MB data URIs would blow the history cap and body
  limit on every later turn.
- **Vision output is formatted deterministically server-side** into the coach
  reply (numbered picks block, one "Skip ..." block, closing recipe offer).
  Non-menu/unreadable outcomes must NEVER end with "?" — the client shows
  fallback yes/no chips under any done reply ending in a question mark, and
  chips under a warm notice would invite a nonsensical "Yes".
- **Offer → Yes follow-up is detected by strict adjacency:** the immediately
  previous assistant message must contain an exact offer constant and the user
  reply must normalize into a small affirmative set; it then reroutes into the
  existing recipe pipeline with a menu-inspiration flag (approved-foods
  compartment forced). Runs BEFORE the generic recipe-intent detector.
- **Photo turns consume both the chat slot and the vision slot** of the rate
  limiter (vision slot released in the route's finally), so chat photos cannot
  silently starve the standalone menu-scan screen's budget.
- **E2E note:** automation misattributes chips easily — chips render under the
  NEWEST reply only, so a normal turn's chips can look like they belong to an
  earlier photo notice in a final screenshot. Judge the pre-follow-up state.

## Meal photo turns (plate → editable meal)

- **One optional `photoKind` field on the tail message switches pipelines**
  (`meal` vs default `menu`); absent = menu so older clients never break, and
  the meal branch must be checked BEFORE the menu branch in the route.
- **Shape the analysis like the existing AI recipe** (1 serving, per-ingredient
  nutrition, `steps: []`, `minutes: 0`, card mode `meal`): the breakdown editor,
  adjustment math, diary logging, and save-as-recipe all come free. Setting the
  patient's OWN photo as the suggestion's `photoUri` suppresses AI image
  generation on the detail screen with zero extra code.
- **"Always estimate" needs schema teeth, not just prompt words:** the model
  occasionally emits amount 0 when unsure — pair the prompt rule with a
  zero/absent-amount corrective retry (limit 1) naming the offending item.
- **Retake is a client-side predicate,** keyed off the latest finished reply's
  ORIGIN message `photo.kind` (works for error replies too, dies when a newer
  turn lands). Meal closers must never end "?" or fallback yes/no chips join it.
- **Vision e2e fixtures:** the seeded ILLUSTRATED plate images are reliably
  read as food by the vision model — no need to generate photoreal fixtures —
  and any UI screenshot reliably triggers the `not_food` outcome.


## Kindless photos: server triage + route announcement

A chat-camera photo sent WITHOUT `photoKind` is triaged server-side (tiny vision call, json_object `{"subject":"menu"|"food"|"other"}`); menu → menu scan, everything else (incl. parse/upstream failure) → meal pipeline, whose not-food outcome stays warm; aborts rethrow. The resolved route is announced early as one SSE event `data: {"photoKind":"menu"|"meal"}`.

**Why:** a client retry that re-sends kindless would trigger a SECOND triage of the same photo, which can pick the other pipeline (different reply shape, cards, chips).

**How to apply:** the client stamps the announced kind onto the origin photo turn (only when kind is still undefined — never overwrite explicit kinds), so retries send the kind explicitly; replay text stays fixed at send time. Keep a fallback inference (meal-mode recipe card ⇒ meal turn) for replies whose announcement was lost, and cover "announce → error → retry carries the stamped kind" in the verify suite.
