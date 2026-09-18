---
name: Patient session persistence
description: Why the mobile app treats a stored Supabase session as "still signed in" through failed refreshes, and how the Supabase session policy is set.
---
# Patient session persistence (login codes are paid SMS)

**Rule:** the stored session in AsyncStorage is authoritative for "still signed in"; only the `SIGNED_OUT` auth event
clears the patient account. A `session: null` from `getSession()`/`INITIAL_SESSION` is NOT a sign-out.

**Why:** auth-js (2.x) returns `session: null` while a *retryable* refresh (network/5xx) fails on an expired access
token, keeps storage intact, and only fires `SIGNED_OUT` on a non-retryable refusal. Screens that keyed off
`session === null` signed patients out (and reset the account epoch) on every flaky cold start, costing a new
Twilio code. It also has a 60 s failure cooldown and a ~30 s retry window, so "stale" can last minutes.

**How to apply:** new mobile fetchers must go through the session helpers (stale vs signed_out) and surface a
reconnecting error, never a demo fallback and never `signOut()`. Test with the real auth-js against a scripted
token endpoint (the session-persistence suite pattern), not a mocked client.

**Supabase policy gotcha:** the management API `sessions_inactivity_timeout` / `sessions_timebox` fields are in
**hours** (max 8760) even though config.toml takes duration strings; 180 days = 4320. Rotation reuse interval was
raised to 30 s so a retried rotation on a slow link does not revoke the family.

**Metric gotcha:** the HQ System health suite used to render the Files page too; that section rotted when Files
moved to Radix menus — page-specific behaviour belongs in that page's own suite.
