---
name: Account security & session ledger
description: Non-obvious rules behind the sign-in ledger, self-service session management, new-device alerts, and "this wasn't me" links.
---

# Account security & session ledger

**Rules:**
- The ledger row is created by the server at login/recovery/claim completion, but the GoTrue *session id* is only known to the client after it redeems the token hash — clients must POST the returned `signInId` to the attach endpoint right after `signInWithTokenHash`. Treat `signInId` as optional on the client (older servers / failures must not block login) and only warn when attach fails.
- Send-cap behavior after a proven password is a 429 on the send pot, not the forced-reset 403: tests asserting "forced reset cleared" must check the *absence* of the `PASSWORD_RESET_REQUIRED` code, not a 200 — earlier steps in the same test spend the shared hourly pot.
- "This wasn't me" landing pages (web + mobile) never fire on open; the report POST happens only on an explicit button. Link scanners/prefetchers would otherwise sign the account out of every device.
- Stolen/misdirected security codes are fail-closed: another account redeeming a change-password code spends it for the owner too (claim-before-work), so the owner must restart the flow.
- Security push rides the existing `account` notification category; no new preference toggle.
- Demo persona: the mobile Account screen is reachable from the FAB menu for demo accounts too (read-only security preview); only `unresolved` accounts hide the row.

- Containment is a required pre-step, never best-effort: recovery/claim-reset/password-change/report call GoTrue logout BEFORE consuming proof or moving the password, and a refused logout answers 502 `SESSION_SIGN_OUT_FAILED` (retryable) with nothing changed and no confirmation. Code review rejects any "logged the failure, returned ok" pattern here.

**Why:** the whole point is that a lost phone can be cut off without help; auto-firing links or hidden previews defeat that, and misreading the send cap as a bug wasted a test cycle.

**Testing gotchas:**
- Workspace env leaks `CLAIM_SMS_DELIVERY_MODE`/`CLAIM_EMAIL_DELIVERY_MODE` into vitest — pin all three delivery-mode knobs to `dev` in the suite or SMS-channel flows silently return neutral bodies.
- Fake GoTrue `logout` must reply 204 with a `null` body (`new Response(null, {status: 204})`); a 204 with a body throws in undici and surfaces as a 502.
- Office-team member ids in fakes must be UUIDs; staff first sign-in needs the `provision_staff_login` RPC faked.
