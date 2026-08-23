---
name: Snackbar undo verification
description: Undo behavior must be verified via the script workflows — browser automation cannot click the transient snackbar Undo.
---

Verify undo *logic* through the diary-undo / custom-food-undo script workflows; use an e2e tester only to confirm the snackbar *appears*. The transient (~4s) Undo control is not reliably clickable by automation.

**Why:** Multiple e2e rounds chasing the tap produced misleading "failure" verdicts on healthy code before the tester itself classified it as a tooling limitation.

**How to apply:** Treat a tester's inability to land the Undo tap as expected, not as a regression. Also: only deletion confirmations carry an Undo offer — add confirmations intentionally don't — so "no Undo in the DOM" after an add is correct behavior.
