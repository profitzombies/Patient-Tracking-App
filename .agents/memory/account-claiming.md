---
name: Account claiming & real-auth linking
description: How migrated-roll accounts (patients/providers/staff) claim logins; GoTrue trigger timing, neutral-response rules, and test-suite seams for the claim flow.
---

# Account claiming pattern

Docs: `docs/account-claiming.md` (flow contract, env vars, go-live checklist).

## Rules that must survive future edits
- Identify responses are byte-identical for hit and miss (decoy requestId/devCode) AND timing-neutral: all account-dependent outcomes are held to a response-time floor, with delivery fired after the response. Any new claim-adjacent endpoint must keep account existence unknowable in body and timing.
- Send caps are enforced atomically in the database (advisory lock + count + insert in one function). **Why:** a check-then-insert pair let concurrent requests race past the hourly cap; per-IP limiters don't count because `trust proxy: true` makes IPs spoofable — treat them as dampers, never controls.
- Patient DOB disambiguation is ONE attempt, then a neutral clinic dead-end. Do not add retries.
- Claiming writes ONLY `auth_user_id` + `claimed_at` on the matched row; a 0-row link deletes the just-created auth user and 409s.
- Password rules: 8+/upper/lower/symbol, NO digit rule (spec explicitly drops it); leaked-password protection lives in Supabase (HIBP), char classes app-side.
- Claimed accounts get NO demo profile row. The web session falls back to the claim whoami endpoint when the profile lookup is empty — new signed-in surfaces must handle a claimed workspace (or patient) instead of assuming a profile row exists.
- Twilio Verify SMS + Resend email are the ONLY outbound messages, and only user-triggered. Dev delivery mode (default) returns codes in-band.

## GoTrue trigger timing (the big gotcha)
GoTrue admin-create INSERTs `auth.users` first and merges `app_metadata` later in the same transaction, so plain AFTER INSERT triggers never see server-set markers. Fix: DEFERRABLE INITIALLY DEFERRED CONSTRAINT triggers that re-read `auth.users` at commit (row gone → return). **Why:** marker-gated provisioning silently skipped otherwise. Elevation paths must require server-set markers or self-signups can hijack staff emails.

## Big-table RLS
Helper functions in policies on large tables must be wrapped in scalar subselects — `(SELECT private.helper())` — or per-row evaluation causes statement timeouts.

## Durable test lessons
- Live-vs-Supabase suites must delete synthetic rows children-first and FAIL LOUDLY on any blocked delete; silently-blocked deletes leave stale rows that corrupt later runs.
- A Node UI suite that stubs a lib but re-exports its real pure helpers pulls that lib's whole native import graph — every native module the graph touches needs a stub mapping.
- Known data flaw: the analytics table's person id does NOT join the patients table (orphan identities), so claimed patients see no metrics history yet.
