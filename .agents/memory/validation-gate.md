---
name: Validation gate workflows
description: CI-style checks (demo-parity, approved-foods, …) are validation commands, not regular workflows; manage them via the validation system.
---
Rule: The project's CI-style checks (demo-parity, approved-foods, and similar) are registered **validation commands**. They appear in the workflow list, but `configureWorkflow` cannot modify or replace them — it returns `success: false` without throwing.

**Why:** Validation commands are a separate system that runs automatically at task completion — that is what makes them a reliable pre-demo gate — and workflow tooling silently no-ops on them.

**How to apply:** Add a new automatic check with `setValidationCommand` (short lowercase name; one check per command so a failure names the culprit) and verify it with `startValidationRun`. Always check `result.success` on workflow/validation callbacks — they can fail without throwing. Convention for mobile pure-logic checks: `scripts/verify-<topic>.ts` + a `test:<topic>` package script + a `<topic>` validation command, all with matching names (e.g. diary-undo, diary-edit, photo-backfill, photo-remove).

Don't try `configureWorkflow` first for these checks: the workspace workflow cap (10) already blocks new plain workflows here ("Workflow limit exceeded (12/10)"), while `setValidationCommand` is exempt from the cap and still surfaces the check in the workflow list.
