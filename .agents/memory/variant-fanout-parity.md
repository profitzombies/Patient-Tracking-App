---
name: Parallel design-variant data parity
description: Parallel frontend work can drift on state semantics, mutation promises, and whether tests exercise actual screens
---
When fanning out parallel design subagents that all render one shared demo-data spec, each round some variant drifts — not on numbers, but on **semantic state encodings**: a minus sign dropped because the label says "down", a "logged" day drawn as an outlined (empty-looking) marker, a streak count that contradicts a meal row.

**Why:** each subagent re-interprets the spec independently; visual encodings of state (filled vs outlined, sign vs label) feel like style choices to a designer but read as data to anyone comparing frames side by side.

**How to apply:** include the full verbatim data spec in every variant brief AND in the post-build architect review prompt, stating explicitly that visual state encodings count as data. Expect the review to flag 1-2 real parity bugs per fan-out round; they are one-line fixes — make them in place (bug fixes are the exception to "never edit variants in place"). Also require each brief to demand a passing sandbox typecheck; one variant per round tends to break it.

## Promised side effects are a second drift axis
Fan-out page agents also write UI copy that PROMISES shared-layer behavior (confirm dialogs, toasts promising data will be preserved/created). The shared context may not implement that promise — the page still demos fine, so e2e passes miss it; only reviewing copy against the shared mutations catches it.
**Why:** In the training-portal fan-out, a delete-confirm promised videos would survive sub-group deletion (context silently dropped them) and an invite toast promised a viewer that was never created. Both shipped past a full e2e pass; only an architect review comparing copy against the shared mutations caught them.
**How to apply:** After any fan-out against a shared data layer, have the review round explicitly check every dialog/toast/empty-state promise against the actual context implementation, and prefer wiring the real mutation over softening the copy.

## Screen tests must exercise the screen

A passing helper or provider suite is not proof that a screen uses those helpers correctly.

**Why:** A food-detail build passed typechecks and helper tests while its real stepper discarded updates, legacy foods crashed, and the rendered totals bypassed the tested calculation. Mounting the actual screen and firing its controls exposed the integration gaps.

**How to apply:** For data-sensitive UI changes, require tests that import the real screen, exercise its controls, and compare rendered values with submitted payloads. For account-sensitive async work, hold a response across an account switch; synchronous clearing alone does not prove isolation.
