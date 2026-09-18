---
name: Ledger retention guards
description: How retention rules with "keep the latest N / keep the latest active" guards are implemented so the guard cannot race a new write, and how dry-run stays neutral inside one SQL statement.
---

# Retention with keep-latest guards

**Rule:** when a retention rule must never delete "the latest row per account/job", implement guard + delete as ONE SQL statement (a data-modifying CTE: rank/select candidates → `delete ... where id in (select ...) and not p_dry_run`). Never select candidates in the app and delete by id list afterwards.

**Why:** a two-step delete lets a sign-in that lands between the select and the delete demote the row the select thought was newest; the CTE evaluates both under one snapshot. `and not p_dry_run` inside the delete predicate keeps the dry-run path byte-identical to the real path (same candidate set, same counts, zero rows touched) instead of a separate read-only query that can drift.

**How to apply:**
- Retention SQL functions are `security definer, set search_path = ''` with a `auth.role() = 'service_role'` check only when they must read `auth.*` (e.g. the live GoTrue session anti-join); plain public-table trims stay `security invoker`.
- Job-run trims key "latest N" on `(job_name, started_at desc)` and are indifferent to run status: a row past the cutoff cannot be live.
- Sign-in trims treat a revoked row as never "the latest active session"; the next attached, unrevoked row inherits protection. Report-token rows stay until `report_token_expires_at < now`.
- Prove guards on the temp-Postgres harness (see `local-postgres-sql-tests.md`) and mutation-check by weakening one guard clause — the suite must go red.
- New `hq_organization_settings` columns must be added to the migration runner's postcondition block or a half-applied live schema passes setup silently.
- The web system-health verify script currently fails in its Files section for reasons unrelated to jobs (Files.tsx breadcrumbs undefined under the "unavailable" fixture); don't chase it from a retention task.
