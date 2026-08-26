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
- Playwright actionability treats aria-disabled="true" as disabled: testers cannot normally click intercept-and-explain controls (the approved a11y pattern for blocked CTAs, web included). Have the tester dispatch a click event to verify the explanatory toast, or assert the aria state instead.

## Desktop-context scrollbars skew width-exact checks

A default (desktop) Playwright context renders a ~15px layout scrollbar, so a nominal 390px viewport lays out at ~375px CSS — narrow-width verdicts come back one device class too pessimistic, and per-width tables can look self-contradictory.

**Why:** A viewport-width truncation check at 320–430px produced chops at widths that render clean on real phones; real devices and the preview simulator use overlay scrollbars.

**How to apply:** For any width-exact visual check, tell the tester to create the context with `isMobile: true, hasTouch: true` (scrollbars overlay; CSS width equals nominal width) and to judge truncation from pixels, never DOM textContent (CSS ellipsis leaves the full string in the DOM). Also: text-fit verdicts from tester prose tables are unreliable — narrower widths "showing more text" than wider ones is the tell; view the cited screenshots directly before acting.
