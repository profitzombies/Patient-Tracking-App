---
name: Conflicted configuration can temporarily remove runtimes
description: Missing Node, pnpm, Python, or ripgrep during a rebase may be a configuration-parse issue rather than an installation problem.
---

**Rule:** When several previously working tools disappear during a rebase, resolve the conflicted Replit configuration before reinstalling anything.

**Why:** Conflict markers in `.replit` temporarily removed its configured module environment from new shells. Node, pnpm, Python, and ripgrep returned immediately after the merged configuration passed schema validation; their installations had not been lost.

**How to apply:** Preserve incoming configuration structure and the task's workflow definitions in a workspace temporary file, then use `verifyAndReplaceDotReplit`. Re-check command availability afterward. Do not directly overwrite the live configuration or treat this temporary state as a dependency failure.