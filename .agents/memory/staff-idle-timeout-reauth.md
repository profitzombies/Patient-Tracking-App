---
name: Staff idle timeout & fresh-code re-auth
description: Decisions behind the operations-web inactivity sign-out and the fresh-code gate on sensitive staff routes; what is deliberately client-side vs server-side.
---

**Idle timeout is a client control over an unchanged server session.** HQ sets staff/HQ windows (5–120 min) on the org policy; an office override can only shorten (API refuses a longer one with a field error, and if HQ later lowers under a stored override the read takes the smaller). The web app fetches its effective window from the staff bootstrap route and falls back to 15 minutes on any bootstrap failure. Supabase hard session lifetime is untouched.
**Why:** HIPAA automatic logoff is about the unattended workstation; changing GoTrue lifetimes would also cut mobile/patient sessions.
**How to apply:** new staff web shells must mount the shared idle dialog; the idle hook must be given a stable `signOut` (a fresh function identity per render re-arms the deadline on every render). Activity/sign-out ride a BroadcastChannel so one tab's activity counts for all; the sign-out reason is a sessionStorage flag read once by the sign-in screen.

**Fresh-code proof lives on the sign-in ledger row of the session**, never in the JWT. Every sign-in method stamps `code_verified_at`; inline re-auth re-uses the login code purpose under a `staff-reauth:<userId>` scope and re-stamps the same row (no new GoTrue session). Gated routes call the gate AFTER validation and authorization; the gate answers 401 `code: "reauth_required"`, a ledger outage answers 503 (fail closed). Session ids in bearers must be UUID-shaped or the claim reader ignores them (test fixtures too).
**Why:** re-issuing tokens would invalidate other tabs/devices; a session-bound ledger stamp keeps the proof per device.
**How to apply:** to gate a new sensitive route, call `requireFreshCode` after the authz check and wrap the client call in `withReauthRetry` (the office/HQ request helpers already do). Fake-bearer route suites mock the gate via a hoisted switch; real gate coverage belongs in the security route suite.
