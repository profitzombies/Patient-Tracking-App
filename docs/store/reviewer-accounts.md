# Reviewer accounts and the App Review office

Apple and Google reviewers sign in with a username and password typed from the
listing form. THINNR signs everyone in with a one-time code (SMS or email) and
staff add a texted second factor, so reviewers need a path that works without
a phone THINNR controls. This is how that path works and how to set it up.

## How the rule works

- A production environment variable, `APP_REVIEW_SIGN_IN`, names exactly two
  identities and their fixed six-digit codes:

  ```json
  {"patient":{"identifier":"appreview-patient@trythinnr.com","code":"NNNNNN"},
   "staff":{"identifier":"appreview-staff@trythinnr.com","code":"NNNNNN"}}
  ```

- When one of those identities asks for a sign-in code, the API records a
  normal code row with delivery kind `app_review` and the fixed code **and
  sends nothing** — no SMS, no email, and the code is never returned to the
  client (not even in development). Attempt limits, expiry and single use
  apply exactly as for any other code.
- The staff identity skips the SMS second factor. The patient identity still
  needs its password (patients always do).
- Every successful reviewer sign-in writes an `app_review_sign_in` audit event
  before any session is issued. If the audit write fails the sign-in fails.
- The fixed code only applies while the identity's account sits in the
  flagged App Review office. That is checked when the code is issued and
  again when it is verified: the account must still be the same record and
  class the code was issued for, inside an office whose `app_review` flag is
  still set. A listed email that belongs to an ordinary office gets a normal
  delivered code; an identity promoted to HQ, moved to another office, or
  whose office lost the flag after issuance is refused.
- Every other identity is unaffected. HQ logins can never be reviewer
  identities. The patient identity never unlocks the staff rule and vice versa
  (the realm comes from the directory hit, not the request).
- The variable is read on every request. **Remove it and the path is gone**:
  codes are delivered normally again and any `app_review` code row issued
  before removal is refused at verify time. A malformed value (missing
  identity, non-email staff identity, bad code format, identical identities,
  invalid JSON) disables the path and logs one warning.

Source: `artifacts/api-server/src/auth/app-review.ts`, the send and verify
handlers in `artifacts/api-server/src/routes/auth.ts`, tests in
`src/auth/app-review.test.ts` and `src/routes/auth.test.ts` ("store reviewer
sign-in").

## The App Review office

The reviewer identities live in one dedicated office flagged
`providers.app_review = true` (a database index allows only one). The office
is fully usable — staff sign-in, the patient app, Stripe **Test** checkout —
but it is not a customer:

| Surface | Behaviour |
| --- | --- |
| HQ → Accounts | Row shows an **App review** chip; not counted toward customer totals |
| HQ overview counts (`nonfinancial_operational_rollup`) | Office and its patients excluded |
| Customer health (HQ page + weekly email) | Excluded |
| Patient retention page | Excluded |
| Stall-nudge and other retention outreach | Excluded |
| App usage / active-user office pickers, Insights totals and date bounds | Excluded |
| Warehouse order submission, renewal reminders | Excluded (reviewer orders in Test mode never reach the warehouse) |
| Office roster, inbox, alerts *inside* the office | Work normally so reviewers see the real product |

## Setup (one time, on the published site)

1. **Create the office.** HQ → Accounts → Add provider account. Office name
   `App Review`, owner email = the staff reviewer mailbox (a THINNR-controlled
   address, for example `appreview-staff@trythinnr.com`). Sign in as that
   owner once the normal way (email code + SMS enrollment on a THINNR phone)
   so the membership and second factor exist.
2. **Flag it and open the gate.** From the project root:

   ```bash
   pnpm --filter @workspace/api-server exec tsx scripts/app-review-office.ts mark-office --office=<provider_id>
   pnpm --filter @workspace/api-server exec tsx scripts/app-review-office.ts mark-office --office=<provider_id> --apply
   ```

   This sets `app_review`, turns on the HQ setup override (so Stripe
   onboarding is not required) and makes office access complimentary for life
   in every configured Stripe mode. It refuses a disabled or offboarding
   office and refuses to flag a second office. The HQ chip appears
   immediately.
3. **Enroll the reviewer patient.** In the office → Patients → Invite patient,
   using the patient reviewer mailbox (for example
   `appreview-patient@trythinnr.com`). On a THINNR phone, open the app →
   Create New Account → I have an invitation → enter the email and the real
   emailed code → set the password that will go on the listing form → accept
   consent → finish onboarding. (Enrollment always uses a real code; only
   sign-in uses the fixed one.)
4. **Seed the sample history.**

   ```bash
   pnpm --filter @workspace/api-server exec tsx scripts/app-review-office.ts reset-patient --patient=<patient uuid> --apply
   ```

   The patient id is on the office patient record URL. The command refuses
   any patient outside the App Review office.
5. **Set the variable on the published deployment** (Replit → Deployments →
   Secrets, production only; never in the development workspace):
   `APP_REVIEW_SIGN_IN` = the JSON above with the two mailboxes and two
   different six-digit codes you choose. Republish.
6. **Prove it.** On a phone with the store/TestFlight build: patient → Log In
   → email + password → the fixed code; staff → Provider login → email → the
   fixed code, no SMS step. HQ → Audit should show two `app_review_sign_in`
   rows. Then paste the credentials into the listing forms
   ([reviewer-notes.md](reviewer-notes.md)).

## Reset before each submission

```bash
pnpm --filter @workspace/api-server exec tsx scripts/app-review-office.ts reset-patient --patient=<patient uuid> --apply
```

Puts the reviewer patient back to: onboarding complete, current consent
recorded, 14 days of diary entries (today half-logged), water and three
check-ins with a gentle weight trend. Food preferences and target overrides
are cleared. Coach and care-team chat history, photos and orders are left as
they are; delete them from the office screens if a reviewer left anything
awkward.

Run without `--apply` first to see the plan. Rotate the fixed codes (edit the
variable, republish) after each review cycle.

## Removing the path

Delete `APP_REVIEW_SIGN_IN` from the deployment and republish. The two
mailboxes become ordinary accounts again (codes are emailed). The office can
stay flagged; it never counts as a customer.
