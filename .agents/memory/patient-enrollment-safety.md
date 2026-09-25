---
name: Patient enrollment safety
description: How patient sign-up/reset/password-change must handle GoTrue password refusals and roll back partial enrollment; client rule mirror.
---

**Rule:** a patient enrollment only activates the directory row after GoTrue has ACCEPTED the password. Any failure after the one-use code is reserved rolls back: restore prior row fields/status, unlink + delete only a login created by THIS attempt (a pre-linked login is kept), and release the code so the same sign-up can retry.
**Why:** a live invited patient hit GoTrue's breached-password check (HTTP 422); the old flow had already activated her row, linked a password-less login and burned the code — roster showed "signed up", she could neither log in nor restart. Repair needed a manual live reset.
**How to apply:**
- Live GoTrue refusal shape (verified 2026-09-25): `422 {code:422, error_code:"weak_password", weak_password:{reasons:["pwned"]}}`. Map to 400 `{field:"password"|"newPassword", code:"WEAK_PASSWORD"}` with patient copy; breach wins over rule misses.
- Any new route that creates a patient login or sets a patient password must go through the session helpers that throw WeakPasswordError — never the generic 502.
- Mobile checklist rules live in one lib mirror of the server `passwordIssue` (8–72 chars, upper, lower, symbol; a digit is NOT a symbol). Change both together.
- Probing the breach check live: admin-create a throwaway synthetic-email user with a common password; delete it if it unexpectedly succeeds.
- As of 2026-09-25, security.test.ts (12), account-closure-resignup (1) and patient-privacy data-export (2) fail with 502s on office routes even on a clean tree — pre-existing, not caused by auth changes.
