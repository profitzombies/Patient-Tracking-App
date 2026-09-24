---
name: HQ team invitations and setup links
description: Constraints on HQ invitation rows, the emailed setup token, and how to prove the whole invite → sign-in → removal path against the live project.
---

# Invitation rows are narrower than they look

- `hq_memberships` is unique on `lower(email)` across **every** status. Re-inviting
  an address therefore *revives* the existing row; it can never insert a second
  one. A membership that ever had `auth_user_id` or `activated_at` is a real former
  teammate, not a stalled invitation, and must not be revived silently.
- `hq_invitations` rows are identity-immutable: a trigger refuses any UPDATE that
  touches the token or a terminal row, and a row can never return to `pending`.
  Superseding a link means marking the old one `expired` (only allowed while the
  membership is still `invited`) and inserting a new row.
- The membership lifecycle trigger does the invitation bookkeeping for you:
  revoking a member auto-revokes their pending invitation, activating one
  auto-accepts it. Do not write those transitions by hand.

**Why:** every one of these was discovered by a live write being refused, after
SQL-text-only reasoning said it would work.

# The setup token

The plaintext token exists in exactly two places: the API process that minted it
and the invitation email. Nothing can read it back out of the database, so
acceptance cannot depend on it — the emailed link only *names* the invitation and
greets the invitee; the one-time email code (plus the texted step when policy
asks) is what actually signs them in.

**How to apply:** any harness that needs a usable token must either read the
delivered email or issue its own invitation row; it cannot re-stamp an existing one.

# Proving it live

- Use Resend's always-delivered recipient `delivered@resend.dev` for a real send
  with no real mailbox and no bounce.
- To recover the link that actually left the building: the transport logs the
  vendor message id, and `GET https://api.resend.com/emails/{id}` returns the
  rendered `html`. **Pretty-printed server logs wrap keys in ANSI escapes**, so
  strip `\u001b\[[0-9;]*m` before regexing the log or the ids silently never match.
- Workspace delivery modes are `live`, so the running server returns no inline
  codes. Start a throwaway api-server on its own port with
  `CLAIM_EMAIL_DELIVERY_MODE=dev CLAIM_SMS_DELIVERY_MODE=dev` for the sign-in leg;
  the invitation email itself is not gated by delivery mode and still really sends.
- The auth routes never return a session. They return a magic-link `tokenHash`;
  redeem it at `POST /auth/v1/verify` with `{type:'email', token_hash}` the way the
  web client's `verifyOtp` does.

# Before blaming your change for a red suite

`src/routes/security.test.ts` carries pre-existing failures on main. Establish the
baseline instead of guessing: `git stash push -- <your files>`, run the suite,
collect the `FAIL` lines, restore, re-run, and diff the two lists. Only the new
lines are yours.

**Why:** two genuinely-new failures were hiding inside a dozen inherited ones.

# Adding a Supabase read to a shared route

Route suites elsewhere hand-roll a fake PostgREST that 404s unknown tables, and a
404 becomes a thrown error and a 502 in the route. A new table read inside an
existing endpoint therefore breaks *other* suites that never mention the feature.
Register the table in those fakes as part of the change.
