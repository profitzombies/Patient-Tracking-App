---
name: Billing identity quarantine
description: Why pre-isolation billing rows vanish from HQ screens, and the rules for adopting them into an identity.
---

Billing tables carry an immutable (stripe_mode, stripe_platform_account_id) identity, and every
scoped read filters on it. Rows written before an identity column exists are therefore invisible
rather than missing — an empty HQ Transactions list is far more likely to be quarantined history
than deleted data. Check the scope columns before believing anything was lost.

**Adopting unlabelled history into an identity**

- Derive the account id from rows already stamped in the database. It comes from a secret, so it
  must never be written into a committed migration.
- Refuse to act unless the evidence is unambiguous: exactly one candidate platform account, no
  Live-scope rows anywhere in the billing tables, and no unknown UPDATE trigger on the tables being
  touched. Tables without a livemode column offer no independent proof that their rows are test
  data, so a single Live row anywhere has to disqualify the whole run.
- The identity guards (billing identity, Connect identity, financial-write protection) block the
  relabel by design; disable the named triggers for the duration and keep the updated_at touch off
  so original timestamps survive.
- Natural keys were widened with the identity columns, so a legacy row can collide with a current
  row of the same key. Update row at a time and leave the colliding row quarantined instead of
  overwriting current data.
- Prove the result: every scoped row must find a parent in its own identity across single-column
  FKs between billing tables. Abort the migration if it does not — a skipped parent with an adopted
  child is the failure mode this catches.
- Adopted financial history still counts as history: the Connect ever-used marker has to be set for
  providers whose orders were adopted, because the trigger that normally sets it was off.

**Why:** the isolation migration deliberately quarantined "unknown historical identities", and
guessing wrong would relabel real money as test data.
