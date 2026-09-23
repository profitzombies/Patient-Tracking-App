---
name: Customer email delivery ledger
description: Retry, fan-out, and staff-resend rules for billing customer emails; PostgREST mock pitfalls the ledger suites hit.
---
Rules (all under the single transport seam, bodies never stored):
- One ledger row = one email to one address. Automatic sends keep the transition dedupe key; contact copies key `<key>:contact:<contact_id>`; staff resend / send-to-other rows get a random suffix and `parent_id`. Each row owns its 3-attempt budget.
- Only vendor/transport errors retry (1 min, then 5 min, drained by the job tick). Deterministic failures — missing template variable, PHI lint refusal — are terminal on attempt one; retrying them would just burn attempts.
- Preview re-renders from stored template id + variables; rows created before variables were snapshotted return 409 rather than a guessed body.
- Logs and audit metadata carry recipient hash/domain only; the ledger row itself holds the address because staff act on it.
- Test scope never sees Live rows through the store, so a Test-mode staff send 404s before the Live-only guard runs; assert 404 there, not 409.

**Why:** the user wants three tries per transition without ever producing a second automatic email, and staff features (resend, extra recipients, HQ outbox) need linked rows rather than re-flipped claims.

**How to apply:** new customer-email templates that should copy extra contacts must be added to the contact-copy template list; extending the send result shape (e.g. subject) breaks `toEqual` in transport.test — update it deliberately.

Mock pitfall: an in-memory PostgREST that compares `gte./lte.` bounds as strings fails on `T00:00:00Z` vs `.000Z`; compare `*_at` columns as instants.
