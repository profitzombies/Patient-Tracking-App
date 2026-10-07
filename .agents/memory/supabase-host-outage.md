---
name: Supabase host network outage
description: How to recognise and fix a production Supabase project whose server lost its network while the dashboard still says healthy; log-query endpoint quirks.
---

Signature (seen 2026-10-05, production unreachable ~9 h before anyone noticed):
- Project status `ACTIVE_HEALTHY`, but `GET /v1/projects/<ref>/health?services=db&services=rest&services=auth` reports all three UNHEALTHY; management SQL returns 544 "Connection terminated due to connection timeout"; auth/rest return Cloudflare 522. Supabase status page clean; the development project fine.
- Inside the DB (after recovery): pg_net rows in `net._http_response` all "Couldn't resolve host name", `pg_stat_archiver` failing (WAL upload), pg_cron "job startup timeout" bursts, Postgres log shipping silent for hours.

Fix: `POST /v1/projects/<ref>/restart` (back in ~2 min). WAL archiving catches up on its own; verify `pg_stat_archiver.last_archived_time` moves past the restart.

**Why:** the cause was host networking, not load (Postgres kept running cron locally). The app's own alerts cannot fire when the database is unreachable, so nothing warned anyone.

**How to apply:** when production Supabase stops answering, run the health endpoint first, then restart with the user's consent; afterwards read `net._http_response`, `cron.job_run_details`, and the logs endpoint to date the start.

Logs endpoint quirks: `analytics/endpoints/logs.all` is gone (410). Use `GET /v1/projects/<ref>/analytics/endpoints/logs?iso_timestamp_start&iso_timestamp_end&sql=` (≤24 h window). The single table is `logs` with a `source` column (`edge_logs`, `postgres_logs`, `postgrest_logs`, `auth_logs`, …); ClickHouse dialect (`toStartOfHour`, `countIf`). `select *` returns "Backend error"; select named columns (`timestamp`, `event_message`).
