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
- Live writes for row-backed features (food_log, coach/care-team messages) ride natural source keys in the backfill's exact format (`patient:entry`, `conversation:client_id`) through the partial unique (feature, source_key) index — replays and edits insert nothing and the RPC returns the rows really inserted. Creation must be decided in SQL (`xmax = 0` on the upsert's RETURNING), never inferred client-side. Do not add a new key format per seam; a second format breaks the "backfilled and live rows can never coexist" invariant.
- Never let an analytics miss fail the patient write: a missing key input (no conversation id back from the RPC) logs and skips the event.
- Pre-key duplicates are repaired in place (`patient_app_events_dedupe`: stamp the oldest event per UTC hour with its source key, delete the rest, dry-run first). Events for since-deleted source rows are indistinguishable from duplicates inside the floor window; patients with no surviving rows are left alone.
- Office-scoped Insights: the section component takes an OPTIONAL practice selector (one component, never a fork). The office route reuses the same RPCs pinned to the resolved scope's provider id (`resolveOfficeScope`, hqPermission `provider_read`, explicit `?office=` for HQ drill-in) and never looks up providers itself. New `/office/...` reads in openapi.yaml must reference the shared `OfficeId` param or the HQ drill-in has no way to pass the office; a comma inside a flow-style `{ description: … }` breaks the spec (use parentheses). Live query keys must include the office id and the auth user id, or switching drill-ins serves the previous practice's figures.
- Demo parity rule for office pages: unscoped office demo = the whole-program seed (same as HQ "all practices"); HQ demo drill-in = byte-identical to HQ filtered to that practice; session-added accounts seed from their own patient count so a drill-in never shows another office's numbers.
