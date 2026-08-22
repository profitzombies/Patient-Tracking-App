---
name: Validation gate workflows
description: demo-parity and approved-foods are registered validation commands, not regular workflows; manage them via the validation system.
---
Rule: The project's CI-style checks (`demo-parity`, `approved-foods`) are registered **validation commands**. They show up in the workflow list, but `configureWorkflow` cannot modify or replace them — it returns `success: false` with "already exists as a validation workflow" (no thrown error).

**Why:** An attempt to fold the approved-foods check into demo-parity via `configureWorkflow` silently no-oped; the failure was only visible in the returned `success` field. Validation commands are a separate system that runs automatically at task completion, which is what makes these checks a reliable pre-demo gate.

**How to apply:** To add another automatic check, register a new validation command (short lowercase name) with `setValidationCommand`; verify with `startValidationRun`. Keep one check per command so a failure names the culprit. Always check `result.success` on workflow/validation callbacks — they can fail without throwing.
