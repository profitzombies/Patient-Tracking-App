---
name: External tick heartbeat (autoscale background work)
description: How production background work runs without process timers, and the traps hit while proving it (test deadlocks, subshell servers, NaN staleness).
---

**Rule:** In production every scheduled loop is off (`JOBS_DISABLED`, `NOTIFICATIONS_DISABLED`) and an external per-minute trigger POSTs the internal tick routes. The job tick is the single entry for *every* worker family (exports and purges drain inside it, then due jobs run); a heartbeat row per tick kind is awaited before the tick answers, and the HQ health page derives "stale" server-side from that row with `inProcessTimers` flags so dev (timers on) shows a note, not a warning.

**Why:** an autoscale deployment sleeps when idle and may run several copies, so `setInterval` work is both missed during quiet hours and duplicated when busy. Awaiting the heartbeat matters because a paused instance can lose fire-and-forget writes right after responding.

**How to apply:**
- Any new background worker must be reachable from the job tick (a drain inside `worker-drains`, or a registered job) or it silently stops in production. Do not add a fresh `setInterval` loop.
- The Scheduled Deployment cannot be created from the workspace; deliver the script + UI steps and say so in the drift reason. Per-minute cron support in the Publishing UI is unconfirmed — the docs describe hourly/daily cadences — so keep the external HTTP-cron fallback documented.
- Live proof recipe: build once, start a second server with `run_in_background` (a `( … & )` subshell dies with the ShellExec call), production flags + a throwaway token on a spare port, run the script, read `system_external_ticks` + `system_job_runs` (trigger `internal`) with the service key. The dev workflow's scheduler shares the DB, so "0/1 due ran" from the second instance is lease contention, not a bug — force a named `dryRun` job to see a run land.
- Test traps: `execFileSync` from a vitest file whose server lives in the same worker deadlocks — use async `execFile`. The route reads real `now` while the memory job store is frozen — fake only `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`). Staleness math must treat unparseable timestamps as "never", not "ok" (NaN compares false against the threshold).
