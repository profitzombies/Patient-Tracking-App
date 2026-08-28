---
name: Parallel duplicate-feature merge
description: Resolving a rebase when main received a rival implementation of the same feature the task built.
---

# Parallel duplicate-feature merge

The same feature can land twice: the task environment builds it while a parallel session in the main workspace builds its own variant from the same plan. The rebase then collides on every shared seam.

**Rule:** treat it as one-feature-one-stack. Keep the assigned task's verified implementation for every overlapping surface and remove the rival stack wholesale (its routes, components, libs, suite/workflow + isValidation entry, package script, variant-only deps, and spec block). Keep genuinely independent incoming work (e.g. user-attached assets).

**Why:** both variants claim the same public API paths, OpenAPI operationIds/schema names (auto-merge appends BOTH blocks → duplicate mapping keys, invalid spec), asset paths, and even the same testIDs — the automerge left the rival's entry button carrying this task's testID but pushing the rival's route. Half-keeping a rival stack yields duplicate UI entries and an unbuildable spec.

**How to apply:**
- During rebase, `ours` = main (incoming), `theirs` = the task's commit. `git checkout --theirs` on shared files cleanly drops rival-only additions when the task's side is a superset.
- Grep the auto-merged (non-conflicted!) files too: openapi.yaml for duplicate keys/operationIds, screens for spliced duplicate buttons, generated client/schemas for doubled type defs.
- Restore generated outputs from the task's commit (`git checkout <task-sha> -- lib/*/generated`) once the merged spec is byte-identical to the task's spec — regeneration becomes provably unnecessary.
- Final proof: `git diff <task-sha> --stat` on the resolved tree. If it shows only the independent keepers (e.g. one screenshot), the tree equals the already-verified state and no re-verification is needed.
- Explain the removal in `divergenceSummary` — deleting a rival implementation is exactly what it exists for.

**Completion says `no_active_task`:** that refusal means the task belongs to a task agent (its state reads plain IN_PROGRESS, not MAIN_*) — the platform never bound it to the main session, no matter what the session history claims. Stop retrying completion; expect the agent's rival build to merge over yours shortly. The clean outcome is a wholesale replace: audit = dup-export grep across the collision files, workspace typecheck, served-bundle marker grep, then serial lane re-runs (2-3 concurrent max; battery reds are usually EAGAIN/thread-spawn flakes, not damage).
