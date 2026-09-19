---
name: Staff SMS second factor
description: How the texted second step after the emailed staff sign-in code is keyed, gated, and tested; traps hit while building it.
---

**Rule:** the second step is decided per sign-in from the freshly read HQ policy OR the person's own opt-in row; a policy outage falls back to the defaults (HQ + office managers required), never to "no second step". The emailed-code verify does NOT mint a session when the rule applies — it hands back a step token bound to the email row, and only the texted-code verify mints.
**Why:** anyone holding the work mailbox must not reach patient records; failing open on a settings outage would silently remove the control.
**How to apply:** new staff entry points (any client) must handle the `secondFactor` branch of `/auth/login/verify` (mode `sms` = send with no phone; mode `enroll` = phone required) and treat `STEP_EXPIRED`/409 as "restart from email". Phones are keyed by the directory identity (hq membership id / provider id / team_members.id), clearing = deleting the row, and only masked phones leave the API.

Traps:
- Literal routes such as `/office/team/account-owner/...` must be registered BEFORE `/:memberId` routes or the UUID loader 404s them.
- Route-suite fetch fakes that answer `record_admin_audit_event` must return 200 with a null body; a 204 with a body throws inside `Response`.
- The web org-policy PUT infers the section from the fields present — never send a `section` key.
- `verify-org-policies.tsx` used to hang after passing (open query timers); it now ends with an explicit `process.exit(0)`.
- A 10-digit phone may be sent raw from clients; the server normalizes to E.164 itself.

**Clear-phone is fresh-code gated.** Clearing a teammate's sign-in phone lowers their security, so it sits behind the same re-auth gate as forced sign-out (401 `reauth_required`; the web request helpers retry through the re-auth sheet automatically). Route tests must `proveCode()` the acting session first.
**Why:** it landed alongside the idle-timeout/re-auth work; an ungated clear would be the one destructive team action not needing proof of presence.
