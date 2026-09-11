---
name: Long-running builds in the task environment
description: Detached/background shell processes get reaped between tool calls; how to run multi-minute builds reliably.
---

# Long-running builds

**Rule:** any process that must outlive a single shell call (e.g. the mobile
static build, which runs its own Metro for several minutes) cannot be started
with `nohup`/`setsid … &` from the shell tool — the sandbox reaps background
children between tool calls, killing the process mid-work with no error in
its log. Use the parent tool's managed `run_in_background` option when
available, or a temporary **console workflow** instead
(`configureWorkflow` → poll `getWorkflowStatus` → `removeWorkflow` when done).

**Why:** two consecutive detached launches of the mobile build died silently
mid-download; the same command under a workflow ran to completion.

**How to apply:** also watch for port collisions first — the mobile build's
Metro needs port 8081, which the mockup-sandbox dev server may hold; stop
that workflow during the build and restart it after.

For long model benchmarks, persist each completed case atomically and bind
resumable evidence to hashes of the implementation, fixtures, and methodology.

**Why:** A model timeout or reaped process can otherwise discard several
minutes of successful, paid requests. Subagents do not necessarily expose the
parent shell's background option; detached commands are not a substitute.
Unversioned checkpoints can silently combine measurements from different
implementations.

**How to apply:** Delegate harness implementation, but let the parent run long
measurements through its managed background facility when necessary. Resume
only matching checkpoints, disclose resumed cases, and distinguish fixture
adapters from live HTTP/storage/database timing.
