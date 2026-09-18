---
name: System performance metrics (latency, pg_stat_statements, growth)
description: Non-obvious rules behind the HQ System health performance panels, the request-metrics flush, threshold alerts, and read-only DB retries.
---
- Latency histogram flushes from the request path (no timers in production): a family only appears once a later request closes its minute, so a live probe right after traffic shows nothing — send one more request after the minute rolls.
- Per-instance minute rows are summed on read; quantiles are interpolated from merged buckets, so p95 is approximate by design (say so on the page).
- `pg_stat_statements` accumulates since the last reset; the panel shows the reset time because a heavy statement from last week keeps ranking until `pg_stat_statements_reset()`. Supabase's own WAL/realtime statements dominate "by total" on a quiet project — that is expected, not a bug.
- Growth snapshot: an unlistable storage prefix is an item failure AND the storage total is withheld for that day (never under-count silently). First snapshot has no previous day → growth null, page reads "no previous day".
- Threshold alerts are HQ-addressed `staff_notifications` rows with `provider_id` null; the office-scoped sender branch (preferences, quiet hours, office lookup) must be skipped for them and non-email channels are suppressed as `channel_unsupported`. The HQ deliveries route needs a "THINNR HQ" office-name fallback.
- Email-templates catalog test requires EVERY sample variable to appear in both html and text renderings; a heading-only variable (e.g. metricLabel) must be echoed in the plain-text body too.
- `supabaseAdmin` retry: read = GET/HEAD or a POST to an allow-listed read-only RPC; transient = timeout/abort/network error or 502/503/504; one retry with 100–300 ms jitter. New read-only RPCs must be added to the allow-list or they run without retry.
- `setValidationCommand` appended the new suites to the parallel "Project" Run-button group (which already carries dozens of suites); remove the new entries from that group after registering.
