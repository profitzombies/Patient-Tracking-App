---
name: Mobile e2e quirks
description: Tester limitations and measurement gotchas — snackbar Undo taps, Chrome-native [DOM] console warnings, document scrollWidth false positives, and desktop-context scrollbars skewing width-exact checks.
---

Verify undo *logic* through the diary-undo / diary-copy / custom-food-undo script workflows; use an e2e tester only to confirm the snackbar *appears*. The transient (~5s) Undo control is not reliably clickable by automation.

**Why:** Multiple e2e rounds chasing the tap produced misleading "failure" verdicts on healthy code before the tester itself classified it as a tooling limitation.

**How to apply:** Treat a tester's inability to land the Undo tap as expected, not as a regression. Also: deletion confirmations and copy confirmations carry an Undo offer — plain add confirmations intentionally don't — so "no Undo in the DOM" after logging a single food is correct behavior.

## Chrome-native [DOM] warnings

Chrome-generated console messages (e.g. "[DOM] Password field is not contained in a form") may not surface in the tester's console capture, so "no such message seen" is weak evidence on its own.

**Why:** These arrive via the CDP Log domain, not the console API; the tester explicitly flagged it could not confirm they'd be surfaced.

**How to apply:** When a fix exists to silence such a warning, assert the *structural* cause deterministically in the page (e.g. `closest('form')` on both password inputs + `display: contents` on the form) and treat console silence as corroboration. Web-only `<form>` wrappers around RN-web password fields follow the SignInFormWrap pattern (display: contents, onSubmit preventDefault, native returns children).

## Document scrollWidth false positive

On the operations web app, document.scrollingElement.scrollWidth can exceed the viewport — and programmatic scrollBy / scrollLeft will move the page — even when layout is fully contained and a user cannot pan at all.

**Why:** index.css sets overflow-x hidden on html, body, and #root, which suppresses scrollbars and user wheel/touch panning but not JS scrolling; Chrome still folds a nested card table scroller (a min-width table inside an overflow-x-auto wrapper) into the scrollWidth that html reports.

**How to apply:** Treat raw scrollWidth or a successful programmatic pan as weak evidence of mobile horizontal overflow. Confirm instead via computed overflow-x on html, each scroller ancestor containing its content (clientWidth vs scrollWidth up the chain), and visual containment; only a user-gesture pan or a visible scrollbar counts as a real failure.


## Hidden mounted Expo tabs skew scroll measurements

Measure a visible element with a positive bounding rectangle, then find its
actual overflow ancestor. Do not select the first matching brand text or all
scroll containers indiscriminately.

**Why:** Inactive tab trees remain mounted. Browser probes have returned a zero
wordmark rectangle and unrelated hidden-tab scroll ranges, falsely suggesting
successful held-pull verification. A frame's dimensions can also be mistaken
for its nested page scroller.

**How to apply:** For boundary checks, compare the positive visible-content
rectangle before and during a held touch, together with that element's nearest
overflow-auto ancestor and document offsets. CSS/Chromium evidence does not
establish native iOS rubber-band or Android stretch behavior.
- Playwright actionability treats aria-disabled="true" as disabled: testers cannot normally click intercept-and-explain controls (the approved a11y pattern for blocked CTAs, web included). Have the tester dispatch a click event to verify the explanatory toast, or assert the aria state instead.

## Desktop-context scrollbars skew width-exact checks

A default (desktop) Playwright context renders a ~15px layout scrollbar, so a nominal 390px viewport lays out at ~375px CSS — narrow-width verdicts come back one device class too pessimistic, and per-width tables can look self-contradictory.

**Why:** A viewport-width truncation check at 320–430px produced chops at widths that render clean on real phones; real devices and the preview simulator use overlay scrollbars.

**How to apply:** For any width-exact visual check, tell the tester to create the context with `isMobile: true, hasTouch: true` (scrollbars overlay; CSS width equals nominal width) and to judge truncation from pixels, never DOM textContent (CSS ellipsis leaves the full string in the DOM). Also: text-fit verdicts from tester prose tables are unreliable — narrower widths "showing more text" than wider ones is the tell; view the cited screenshots directly before acting.

**Photo-flow e2e needs a real repo image:** expo-image-manipulator's web decode rejects testers' synthetic/generated PNG buffers — 'preparation failed' with no dialog is the app's designed reaction, not a modal bug. Point the tester's filechooser at a real asset, e.g. artifacts/thinnr-mobile/assets/images/recipes/tuna-wrap.jpg.

**Label-flow fixture reads back deterministically:** `artifacts/thinnr-mobile/e2e/fixtures/nutrition-label-cereal.jpg` is an ImageMagick-rendered FDA-style panel; the vision label reader transcribes it verbatim, so e2e can assert exact serving/macro card strings (expected lines documented in the fixtures README, values chosen 4/4/9-consistent so no misprint flag). Synthetic in-page image buffers fail expo-image-manipulator's web decode — always upload a real repo file via the filechooser, and render fixtures with ImageMagick when exact values must round-trip. A direct curl of the SSE endpoint with the fixture (kindless, expect the photoKind announcement + labelDraft event) is a cheap pre-flight before burning a tester run on the vision turn.

- Grounded chat replies (support, coach) burst in within seconds AFTER a long silent grounding pause — a tester cannot reliably click Stop mid-text. Exercise stop during the thinking indicator instead (stop-with-no-text drops the empty bubble by design), or request a long "in full detail" answer and treat mid-stream stop as best-effort.

- Synthetic DataTransfer drag-and-drop does not reliably fire React drop handlers in the tester's Chromium — a silent non-reaction proves nothing either way. Verify file-drop features via the click/filechooser path plus a contract check on the drop-handler wiring, and treat DnD e2e as best-effort only.

- RNW Modal (AppModal) ignores Escape during its enter animation: the document keyup listener is gated on an active flag that only flips on the fade/slide animationend (~250ms in RNW 0.21.x). An automated Escape press fired immediately after opening yields a false "keyboard dismissal broken" verdict. Have testers settle ~0.5s after opening before keyboard dismissal, and arbitrate suspected cases with an isolated open → wait → Escape retry before treating it as a regression.

- Full-canvas backdrop pressables (e.g. the staff FAB menu's provider-menu-backdrop) defeat Playwright's default element click: it aims at the element's CENTER, which the raised menu card covers — a forced click lands on whatever row is there (AI Support closes-and-navigates by design, reading as a false "backdrop broken + stray navigation"). Backdrop-dismiss checks must click explicit coordinates in the dimmed area (e.g. canvas top ~15%) after confirming elementFromPoint resolves to the backdrop.

## Keyboard-constrained scroll checks

In Expo web, a focused field at the viewport edge with the action below it is not proof that the action is unreachable.

**Why:** A reduced-height auth check reported a false keyboard failure before scrolling the inner React Native Web container. At its actual maximum scroll, the action and footer were fully reachable with both old and new spacing.

**How to apply:** After resize and focus settle, identify the inner vertical scroller, scroll it to `scrollHeight - clientHeight`, and record its dimensions and action bounds. Do not scroll only the window. Label reduced-height browser checks as approximations, not native-keyboard proof.
