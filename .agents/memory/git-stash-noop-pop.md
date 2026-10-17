---
name: git stash no-op pop trap
description: Why "git stash && test && git stash pop" can splice an unrelated old stash into the tree after the completion commit.
---
**Rule:** never pair `git stash` with an unconditional `git stash pop` to test the base tree. Once
`markTaskComplete` has committed the work, the tree is clean, the stash is a no-op, and the pop
applies whatever OLD stash the repo carries (this repo keeps a stale billing WIP stash) —
dozens of UU conflicts in files the task never touched.

**Why:** happened while proving a pre-existing suite failure after the completion commit; the
pre-existing stash was from months earlier.

**How to apply:** check `git stash list` / `git status` first; prefer `git worktree add` or
`git diff --name-only <base>` to argue a failure is outside the change. If it happens anyway,
`git reset --hard HEAD` restores the commit; the old stash entry stays untouched.
