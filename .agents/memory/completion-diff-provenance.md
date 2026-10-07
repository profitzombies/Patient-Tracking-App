---
name: Completion-diff provenance
description: Mid-session commits from the main workspace can get swept into a task's completion diff and misattributed by the completion review.
---

# Completion-diff provenance

**Rule:** before completing a task, check whether HEAD has advanced past the state you audited (`git log` for new commits, especially plain agent-checkpoint commits without task-merge trailers). Content from such upstream commits can appear in the task's completion diff and be attributed — and rejected — as if it were the task's own work.

**Why:** a completion review rejected a verification-only task because a main-workspace checkpoint commit (unrelated server change + uploaded asset + memory notes) synced into the task environment during completion and showed up as the task's change set.

**How to apply:** do not try to revert or fetch around upstream commits (manual fetch of the main-repl remote needs interactive auth and syncing is platform-managed). Instead: state the provenance of any swept-in upstream content explicitly in the completion drift_reason, do only the cleanups the reviewer sanctioned as yours, and re-run completion.

**Which "main":** inside a task environment the local `main` branch IS the task branch (HEAD = main). The user's real main is `main-repl/main`; the true completion diff is `git diff $(git merge-base HEAD main-repl/main) HEAD`. Commits between your remembered "pre-task rev" and that merge-base are already upstream, not yours.

**Config-only tasks — prove env-independence:** when a task only changes env/preload/config, re-run each red suite with every new knob removed (`env -u NODE_OPTIONS -u <each new var> …`). Identical failure counts in both runs (and no diff on the code path) mean the failure predates the task.

Also: auto-generated files (e.g. mockup-sandbox src/.generated/mockup-components.ts) reorder themselves whenever their dev server rescans. Diff working-tree noise before completing and git-checkout unrelated generated churn so it stays out of the task diff.

Swept-in commits also bring their VALIDATION COMMANDS, dependency additions, and stale dev servers: completion validation runs the upstream feature's live checks against YOUR environment. Repair before re-completing — `pnpm install` (new package.json deps), restart the dev-server workflows the checks probe (a server started before the sweep lacks the new routes), then re-run the failing command locally to confirm green.

**Prove a suspected regression is not yours before debugging it.** A mid-session upstream merge can leave whole route suites red for reasons unrelated to your diff. Cheapest check: `git worktree add /tmp/base HEAD`, symlink the workspace `node_modules` (root and the package's own) into the worktree, and run the suite there with the workspace vitest binary. Identical failure counts at HEAD mean the breakage arrived with the merge; note it in drift_reason and keep it out of your validation commands.

**Upstream merge before review (Aug 2026):** the completion flow merges main-repl into the task branch BEFORE validation + code review, so (1) live-suite validation can fail purely because running dev servers still serve pre-merge code — restart the api-server/web workflows after a rejected completion that pulled upstream commits, then re-run the failed suites; (2) the completion reviewer may attribute upstream commits' changes (even their memory edits) to your task — answer with git show --stat provenance for YOUR commit in drift_reason and request a fresh review, never by reverting the user's merged upstream work.


