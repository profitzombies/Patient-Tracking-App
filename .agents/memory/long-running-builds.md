---
name: Long-running builds in the task environment
description: Detached/background shell processes get reaped between tool calls; how to run multi-minute builds reliably.
---

# Long-running builds

**Rule:** any process that must outlive a single shell call (e.g. the mobile
static build, which runs its own Metro for several minutes) cannot be started
with `nohup`/`setsid … &` from the shell tool — the sandbox reaps background
children between tool calls, killing the process mid-work with no error in
its log. Run it as a temporary **console workflow** instead
(`configureWorkflow` → poll `getWorkflowStatus` → `removeWorkflow` when done).

**Why:** two consecutive detached launches of the mobile build died silently
mid-download; the same command under a workflow ran to completion.

**How to apply:** also watch for port collisions first — the mobile build's
Metro needs port 8081, which the mockup-sandbox dev server may hold; stop
that workflow during the build and restart it after.
