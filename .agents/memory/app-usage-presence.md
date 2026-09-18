---
name: App presence & HQ active-user reporting
description: Rules for the patient presence heartbeat and the HQ "App usage" (weekly/monthly active users) rollup — what counts, where the day boundary sits, and how demo stays byte-stable.
---

**Rule:** an active app user is a real-account patient with presence OR any server-recorded action on a patient-local day; the denominator is *activated* patients. The live "now" tiles (active now / today / weekly / monthly) end on today; per-office rows, the trend series and `atRangeEnd` end on the shared range end. Unavailable (range ends before the office's first activated patient) is `null`/"—", never 0 — same semantics as the office comparison.

**Why:** the overview tiles must agree with the page's headline tiles regardless of the picked range, while the per-practice table has to honour the range like every other HQ analytics table; mixing the anchors made the two disagree.

**How to apply:**
- Presence is recorded as a side effect of patient identity resolution (throttled in memory per patient, never blocking the request) plus a bare heartbeat route the app calls on account resolve + foreground. The heartbeat route is deliberately NOT in openapi.yaml (mobile calls it through its own patient-data API layer).
- The presence table is service-role-only (RLS on, no policies — the security advisor logs an INFO for it by design), joins the patient identity write-guard protocol, the purge path, and the patient export.
- Signed-out HQ demo has NO seeded provider account list, so the demo page/tiles self-seed from a dedicated deterministic dataset (four seeded offices partitioning 632 patients, waveform exactly 1 on the demo date) — never from the clock, never via fetch.
- A failed poll is shown as an error (tiles "Error", alerts + Try again); previous figures are not silently kept.
- Browser proof recipe: care-team live-smoke `prepare` + `helper`, symlink the helper dir into the ops `public/`, add an extra 0600 "patient ping" helper page that POSTs the heartbeat from the browser (token never in chat), then watch the HQ page's 30 s poll pick it up. Clean up with the harness.
- The harness cleanup deletes under `session_replication_role = replica`, which also disables FK ON DELETE CASCADE (it is an internal trigger) — presence rows written during the check are orphaned. Delete `patient_app_presence` rows for the synthetic patient yourself (before cleanup, or afterwards by "patient no longer exists").
