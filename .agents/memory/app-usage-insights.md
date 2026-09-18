---
name: App usage Insights (event ledger + rollups)
description: Durable rules behind the per-feature usage event ledger, hourly rollups, and the HQ Insights section; traps that bit while building them.
---

**Rule:** usage analytics never touch the patient app. Each tracked action is recorded once, server-side, at the feature's write seam, with the patient-LOCAL weekday/hour resolved from the effective profile timezone. An hour of -1 means "day only" and such rows count in totals/series/best-day/weekend share but never in the heatmap, busiest hour, or peak window.

**Why:** time-of-day is only meaningful in the patient's clock, and day-only history (water days, presence days) would otherwise pile onto midnight and fake a peak.

**How to apply:**
- Reads = rollups for clean days UNION raw rows for dirty days (today and anything touched since the last run). The invariant "rollup + tail equals a fresh aggregate over raw" is the test to keep; never read raw tables for closed days.
- One shared rule engine (workspace lib) assembles series/heatmap/tiles/"what changed" for BOTH the API and the seeded demo so the two cannot drift; the demo clips food/water hours before a fixed launch date to exercise the "tracked since" note.
- When totals are non-zero but no hourly data exists in the range (pre-launch food/water), hour-based tiles must say "no hour-of-day data yet", not "no food logs".
- Provider ids are TEXT (`live-…` for real offices, `acct-p1`-style legacy seeds), never UUIDs. An office filter validated as UUID silently 404s every real practice; validate as bounded printable text and let the encoded exact lookup decide. Route tests must use a `live-…` id, not a fabricated UUID.
- Migration filenames: a parallel task can land the same timestamp prefix on main; check `ls supabase/migrations` after rebase and bump to a unique version (the mgmt-API apply path keeps no history row, so a rename is safe).
- New event tables intentionally have RLS with no policies (service-role only); advisors report INFO only — do not add policies to silence it.
