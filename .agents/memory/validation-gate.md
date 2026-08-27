---
name: Validation gate workflows
description: CI-style checks (demo-parity, approved-foods, …) are validation commands, not regular workflows; manage them via the validation system.
---
Rule: The project's CI-style checks (demo-parity, approved-foods, and similar) are registered **validation commands**. They appear in the workflow list, but `configureWorkflow` cannot modify or replace them — it returns `success: false` without throwing.

**Why:** Validation commands are a separate system that runs automatically at task completion — that is what makes them a reliable pre-demo gate — and workflow tooling silently no-ops on them.

**How to apply:** Add a new automatic check with `setValidationCommand` (short lowercase name; one check per command so a failure names the culprit) and verify it with `startValidationRun`. Always check `result.success` on workflow/validation callbacks — they can fail without throwing. Convention for mobile pure-logic checks: `scripts/verify-<topic>.ts` + a `test:<topic>` package script + a `<topic>` validation command, all with matching names (e.g. diary-undo, diary-edit, photo-backfill, photo-remove, recipe-nutrition).

Don't try `configureWorkflow` first for these checks: plain workflows are capped per workspace, while `setValidationCommand` is exempt from the cap and still surfaces the check in the workflow list.

## Completion-gate flakes are load, not regressions

The completion gate runs every registered validation command concurrently in one shared container, so the burst can starve itself. **Signature:** EAGAIN spawning esbuild, silent exit-134 kills with zero output, or 502s in live suites whose domain the diff never touched, while hermetic siblings stay green. **How to apply:** re-run just the failed suites serially on a quiet machine (tester idle, workflows settled) and trust the serial result. If the gate stalls past its poll budget repeatedly, re-run failures serially, confirm the rest passed in the stalled run's logs, then complete with skip_validation_reason citing that per-command green evidence. A code_review PASS inside a stalled run still counts.

**Live-suite prerequisite:** the live suites hit the dev api-server through the local proxy, and merges never restart workflows — start the api-server workflow before the gate or they fail real (unreachable/502). They are also the most load-fragile under the parallel burst: a 134-abort with zero suite output is a startup kill, not a test failure.
