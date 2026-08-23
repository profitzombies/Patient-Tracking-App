---
name: Mobile e2e quirks
description: Tester limitations on the Expo app — snackbar Undo taps, and Chrome-native [DOM] console warnings that may not reach console capture.
---

Verify undo *logic* through the diary-undo / diary-copy / custom-food-undo script workflows; use an e2e tester only to confirm the snackbar *appears*. The transient (~5s) Undo control is not reliably clickable by automation.

**Why:** Multiple e2e rounds chasing the tap produced misleading "failure" verdicts on healthy code before the tester itself classified it as a tooling limitation.

**How to apply:** Treat a tester's inability to land the Undo tap as expected, not as a regression. Also: deletion confirmations and copy confirmations carry an Undo offer — plain add confirmations intentionally don't — so "no Undo in the DOM" after logging a single food is correct behavior.

## Chrome-native [DOM] warnings

Chrome-generated console messages (e.g. "[DOM] Password field is not contained in a form") may not surface in the tester's console capture, so "no such message seen" is weak evidence on its own.

**Why:** These arrive via the CDP Log domain, not the console API; the tester explicitly flagged it could not confirm they'd be surfaced.

**How to apply:** When a fix exists to silence such a warning, assert the *structural* cause deterministically in the page (e.g. `closest('form')` on both password inputs + `display: contents` on the form) and treat console silence as corroboration. Web-only `<form>` wrappers around RN-web password fields follow the SignInFormWrap pattern (display: contents, onSubmit preventDefault, native returns children).
