---
name: System jobs framework (scheduled clean-up)
description: Conventions for the api-server job scheduler (job runs/leases, upload intents, reconciliation, retention) and the live-Supabase behaviours that unit tests cannot catch.
---

**Rule:** every recurring or user-triggered clean-up goes through the shared job scheduler (named job, lease, run row, per-item failures, dry-run). User-triggered paths log via the user-run helper and degrade gracefully if the ledger insert fails; dry runs must be side-effect free and report `*Due` counts instead of `*Deleted`.

**Why:** before this, deletes were best-effort and silent; the HQ System health page derives every state purely from run rows, so a job that bypasses the ledger looks "never ran" and a dry run that mutates would lie.

**How to apply:**
- A lease is only a non-overlap guarantee if it outlives the run: the scheduler heartbeats a renewal RPC (which never moves the schedule anchor) and jobs call `ctx.checkpoint()` between units of work so a run that lost its lease stops instead of racing the new holder. New job loops must checkpoint; a job body without checkpoints can only be interrupted at its end (the run is still recorded failed).
- Upload URLs are recorded as *intents* at issue time; the abandoned-upload sweep and the reconciler both consult intents so an in-flight upload is never treated as an orphan. New upload surfaces must register an intent and a ledger prefix, or their bytes are invisible to hygiene.
- Reconciliation flags rows as object-missing (never deletes ledger rows); DTOs expose an unavailable-since field, downloads answer 410, UIs render "File unavailable". Flags clear automatically when the object reappears.
- Only HQ-runnable jobs get "Run now"; user-only jobs (patient media discards) are refused from HQ and the page says so.
- The internal tick shares the notification bearer helper (token unset → 404 in dev, so a 404 on the tick route locally is expected).

**Live Supabase behaviours (unit tests and local PG will NOT catch these):**
- Supabase runs `pg-safeupdate`: a bare `delete from temp_table;` inside a PL/pgSQL function fails with 21000 at runtime. Use `truncate` (or `where true`).
- Prefix listing must derive the bucket directory from the object-dir env, not by locating an empty object id (that throws not-found).
- SQL `AND` in PL/pgSQL does not short-circuit; nest IFs when a column may not exist on the row type.

**Queued document failures:** distinguish a terminal problem with one document
from a service outage when choosing shared-job backoff.

**Why:** applying the maintenance scheduler's failure policy to a malformed
or timed-out PDF paused unrelated uploads and explicit retries for minutes.
Faster parsing alone cannot remove that queue delay.

**How to apply:** preserve the document error and failure ledger, settle the
document under its lease, then allow other queued documents to continue.
Keep infrastructure failure backoff and all lease/privacy checks intact.
