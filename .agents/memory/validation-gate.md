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

**markTaskComplete commits BEFORE validation settles:** the task's work lands on main as a commit the moment the gate starts, even if validation then stalls or fails. Post-hoc "is this failure pre-existing?" checks must therefore diff/run against the pre-task commit (`git checkout <pre-task-rev> -- <files>`, run, restore) — `git stash` finds nothing because the tree is already clean. If baseline suites fail identically there, the gate can never pass in that session; complete with skip_validation_reason citing the baseline proof and the serial green evidence for everything else.

**The command store can come up empty:** a fresh task environment may show `getValidationCommands()` → `[]` even though suites were registered in earlier sessions. Check it before trusting the gate's coverage, and always register the session's new suite yourself — the completion gate only runs what is currently registered.

**Storms kill dev servers too:** a board-wide parallel run can SIGABRT the long-running artifact workflows (Expo/Metro, vite sandbox) alongside the suites — the user sees "artifact failed to run" with no code change. After any EAGAIN/134 storm, check the artifact service workflows and restart the dead ones first, then re-run the flaked suites in small batches (~4 at a time), not all at once. Verify Expo by curling its local port for the app `<title>`.

## App startup must stay separate from validation

Keep the ordinary Run-button group limited to managed artifact services. A manually runnable all-tests group must be sequential or otherwise bounded; preserve the individual validation registrations.

**Why:** The workspace can retain validation suites in its normal Project startup group. Starting the project then launches the entire test collection alongside Expo and the API, exhausting the container's process/thread limit before the app starts. This has produced exit-134 aborts and EAGAIN without any application-code regression.

**How to apply:** When diagnosing an artifact startup abort, inspect the Run-button group's membership as well as current process pressure. Adding a validation command must not silently restore tests to ordinary app startup. A successful server restart alone does not prevent the next startup overload if the group still includes the test collection.
