---
name: Validation gate workflows
description: CI-style checks (demo-parity, approved-foods, …) are validation commands, not regular workflows; manage them via the validation system.
---
Rule: The project's CI-style checks (demo-parity, approved-foods, and similar) are registered **validation commands**. They appear in the workflow list, but `configureWorkflow` cannot modify or replace them — it returns `success: false` without throwing.

**Why:** Validation commands are a separate system that runs automatically at task completion — that is what makes them a reliable pre-demo gate — and workflow tooling silently no-ops on them.

**How to apply:** Add a new automatic check with `setValidationCommand` (short lowercase name; one check per command so a failure names the culprit) and verify it with `startValidationRun`. Always check `result.success` on workflow/validation callbacks — they can fail without throwing. Convention for mobile pure-logic checks: `scripts/verify-<topic>.ts` + a `test:<topic>` package script + a `<topic>` validation command, all with matching names (e.g. diary-undo, diary-edit, photo-backfill, photo-remove, recipe-nutrition).

Don't try `configureWorkflow` first for these checks: the workspace workflow cap (10) already blocks new plain workflows here ("Workflow limit exceeded (12/10)"), while `setValidationCommand` is exempt from the cap and still surfaces the check in the workflow list.

## Completion-time parallel burst flakes

markTaskComplete runs EVERY registered validation command concurrently (a 22-suite battery finishes in ~50s wall). On a busy container (e2e tester browser open, Metro bundling) the burst starves itself: tsx suites die spawning esbuild (EAGAIN), others are killed with no output at all (exit 134), and live suites see the co-hosted api-server answer 502 with cut streams — i.e. failures in suites the task's diff never imports.

**Why:** one container shares CPU/PID/memory across all suites plus the dev servers; live suites also route real model calls through that same starved server.

**How to apply:** treat that signature (EAGAIN / silent 134 / 502s in unrelated suites while hermetic siblings stay green) as load flake, not regression: re-run just the failed suites serially on a quiet machine (tester idle, workflows settled), confirm green, then call markTaskComplete again. Don't chase the failing suites' feature domains.

## Poll-budget stalls
With ~25+ registered commands the parallel completion gate can exceed its 1800-poll budget repeatedly (live-model suites stretch the tail; EAGAIN/exit-134 spawn flakes under load). When two runs in a row stall: re-run every failed/hung command serially, confirm the rest PASSED in the stalled runs (logs under .local/state/workflow-logs/<runId>/), then complete with skip_validation_reason citing per-command green evidence — the stall error message itself sanctions that path. A code_review PASS inside a stalled run still counts.

