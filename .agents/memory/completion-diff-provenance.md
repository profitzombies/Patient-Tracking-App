---
name: Completion-diff provenance
description: Mid-session commits from the main workspace can get swept into a task's completion diff and misattributed by the completion review.
---

# Completion-diff provenance

**Rule:** before completing a task, check whether HEAD has advanced past the state you audited (`git log` for new commits, especially plain agent-checkpoint commits without task-merge trailers). Content from such upstream commits can appear in the task's completion diff and be attributed — and rejected — as if it were the task's own work.

**Why:** a completion review rejected a verification-only task because a main-workspace checkpoint commit (unrelated server change + uploaded asset + memory notes) synced into the task environment during completion and showed up as the task's change set.

**How to apply:** do not try to revert or fetch around upstream commits (manual fetch of the main-repl remote needs interactive auth and syncing is platform-managed). Instead: state the provenance of any swept-in upstream content explicitly in the completion drift_reason, do only the cleanups the reviewer sanctioned as yours, and re-run completion.

Also: auto-generated files (e.g. mockup-sandbox src/.generated/mockup-components.ts) reorder themselves whenever their dev server rescans. Diff working-tree noise before completing and git-checkout unrelated generated churn so it stays out of the task diff.
