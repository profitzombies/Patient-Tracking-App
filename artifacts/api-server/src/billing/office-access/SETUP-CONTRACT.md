# Office access setup — HTTP contract

The office's own money arrangements with THINNR: a bank account (ACH debit),
two distinct credit cards, a chosen plan, and an acknowledged disclosure. The
office's *connected* Stripe account (how its patients pay it) is a separate
thing owned by practice launch; this surface only reports its state.

All routes are under `/api`, bearer authenticated, office resolved
server-side. `?office=<id>` is honoured for HQ read-only inspection. Errors are
`{error, code?}`. Nothing here is generated from `openapi.yaml` — billing office
routes are handwritten by convention.

**Reachable while the setup gate is closed** (`isLaunchAllowedPath`): this is
how an office gets through the gate.

## Authorization

| Route | Who |
| --- | --- |
| `GET /billing/office/access` | any office staff; HQ read-only |
| `POST /billing/office/access/setup-intent` | any office staff |
| `POST /billing/office/access/instruments` | any office staff |
| `POST /billing/office/access/bank/verify` | any office staff |
| `POST /billing/office/access/pay` | any office staff |
| `POST /billing/office/access/plan` | practice owner only |
| `POST /billing/office/access/disclosure` | practice owner only |

HQ receives 403 on every write: it may review an office's payment setup but
never act on it.

## GET `/billing/office/access`

```jsonc
{
  "office": { "providerId": "…", "officeName": "…" },
  "complete": false,                 // gate verdict INCLUDING the connected account
  "connectAlreadyDone": true,        // office connected Stripe before this gate shipped
  "steps": [                         // fixed order: connect, bank, card_primary, card_backup, plan, disclosure
    { "id": "connect", "status": "done|pending|todo|blocked", "detail": "…|null" }
  ],
  "connect": { "state": "not_started|action_required|pending|ready", "sandbox": true },
  "instruments": [
    { "slot": "bank|card_primary|card_backup", "kind": "bank|card", "brand": "visa|null",
      "last4": "4242", "expMonth": 4, "expYear": 2030, "bankName": "…|null",
      "verificationStatus": "verified|pending|failed", "verificationDeadline": "ISO|null",
      "holderName": "…|null",       // cardholder / account-holder name saved on the method
      "addedAt": "ISO" }
  ],
  "plan": {
    "selected": "monthly|yearly|null",  // null until the office actively chose
    "monthlyPriceCents": 20000, "yearlyPriceCents": 200000,
    "priceCents": 20000,                // what THIS office pays (an HQ override wins)
    "firstChargeAt": "ISO|null",        // end of the included period
    "includedPeriodDays": 365,
    "nextPeriodEndsAt": "ISO|null"
  },
  "disclosure": { "text": "…", "version": 7, "acknowledgedAt": "ISO|null" },
  "bank": { "verificationPending": true, "deadline": "ISO|null", "overdue": false,
            "windowHours": 48, "verificationUrl": "https://…|null",
            // A replacement bank waiting on test deposits beside the verified
            // bank still in service (which the instruments list keeps showing).
            "replacement": { "bankName": "…|null", "last4": "1111", "holderName": "…|null",
                             "deadline": "ISO|null", "verificationUrl": "https://…|null",
                             "addedAt": "ISO" } | null },
  "balance": { "state": "setup_incomplete|included_period|paid_current|past_due|restricted",
               "outstanding": false, "amountCents": 20000, "graceEndsAt": "ISO|null" },
  "canManage": true,      // caller may add/replace instruments and pay a balance
  "canChoosePlan": true   // caller is the owner
}
```

`disclosure.text` is HQ-authored (`hq_organization_settings.access_disclosure_text`,
surfaced through the org policy). It is never hard-coded in a client.

## Writes

Every write returns the same snapshot as `GET` (the bank-verify route returns
`{verified, setup}`), so a client never has to re-read.

- `POST /setup-intent` `{slot}` → `{clientSecret, setupIntentId, publishableKey, slot, billingDetails}`.
  The browser confirms this with Stripe's payment element; Stripe renders its
  own ACH authorization text, so no mandate copy is written by us.
  `billingDetails` `{name, email}` is what the form's holder fields start as
  (office name, else owner name; owner email). The office may edit both, and
  the browser sends them as `payment_method_data.billing_details`; the server
  fills either one in from the office when a method arrives without it.
- `POST /instruments` `{slot, paymentMethodId, setupIntentId?}` → snapshot.
  A second card that is the same *physical* card as the first is refused
  `409 {code:"duplicate_card"}` on Stripe's fingerprint (survives a re-issued
  number, a new expiry, or a wallet token); a refused method is detached again.
  Re-posting an occupied slot replaces it: the old row is kept for history
  (`removed_at`) and the old method is detached from the office's Stripe
  customer (`detached_at`), so Stripe only ever shows the three in service. A
  detach waits while a charge on that slot is `processing`; the billing job's
  sweep finishes it. A new primary card becomes the customer's
  `invoice_settings.default_payment_method`.
  Replacing a *verified* bank with one that still needs test deposits stages
  it (`bank.replacement`): the old bank stays in service and chargeable, the
  new one takes over when its SetupIntent succeeds, and on failure or expiry
  of the 48-hour window it drops away (its SetupIntent is cancelled). Stripe
  will not attach an unverified bank, so the SetupIntent attaches it on
  verification instead of this route.
- `DELETE /instruments[/:slot]` → always `405 {code:"replace_only"}`. An office
  keeps one bank and two different cards on file; there is no removal.
- `POST /plan` `{plan:"monthly"|"yearly"}` → snapshot. `409 {code:"plan_locked"}`
  once the office has paid periods; plan changes then go through HQ.
- `POST /disclosure` `{version}` → snapshot. Acknowledgment is permanent: a
  later HQ wording change does not re-gate the office.
- `POST /bank/verify` `{}` → `{verified, setup}`. Re-reads the stored
  SetupIntent after the office entered its microdeposit amounts on Stripe's
  hosted page (`bank.verificationUrl`). Amounts never reach this server.
- `POST /pay` `{}` → `{status, setup}` where `status` is the charge outcome
  (`succeeded|processing|failed`), a skip reason, or `nothing_due`.

## Gate semantics

`accessGateSatisfied(providerId)` — consumed by
`practice-launch/state.operationalLaunchComplete`, which is what
`resolveOfficeScope` enforces on every office request:

- all three slots hold an instrument, **and**
- the plan was actively chosen (`plan_selected_at`, because the `plan` column
  has always had a default), **and**
- the disclosure was acknowledged, **and**
- the bank account is not past its verification deadline.

A bank account awaiting microdeposits does **not** block the office: it gets in
on the strength of its cards for `BANK_VERIFICATION_WINDOW_HOURS` (48), after
which the block returns until the account verifies or is replaced.

An office that connected Stripe before this shipped keeps that connection
(`connectAlreadyDone: true`, the connect step reads `done`) and is taken
through the remaining steps on its next sign-in.

## Stripe customer identity

The office's access customer (on THINNR's platform account) carries `name`
(office name, else owner name), `business_name`, `individual_name` (owner),
`email`, `phone`, `address`, a `description` naming the office, and metadata
`thinnr_provider_id`, `thinnr_office_name`, `thinnr_payment_mode`,
`thinnr_purpose`. It is set on create, re-synced when practice details or the
owner contact change, and back-filled for older offices by
`scripts/backfill-office-access-identity.ts` (dry run by default; `--apply`,
`--mode=test|live`). A field the office has no value for is left out, never
blanked. `scripts/verify-office-access-replace-live.ts` proves identity,
holder names, detach-on-replace and the staged-bank swap in Test mode.
