---
name: Production data cleanup
description: Lessons from removing test/fake rows from the production Supabase project and Stripe test mode — matching rules, orphan sweeps, Stripe deletion quirks, proof method.
---

The record of the 2026-10-07 cleanup is `docs/prod-fake-data-cleanup-2026-10-07.md`. The HQ testing hard-delete tool no longer exists, so any future removal must be hand-written SQL inside guarded transactions.

- **Never match `.invalid` broadly.** Real patients carry placeholder addresses of the form `pt-…@patients.thinnr.invalid`.
  **Why:** a generic "fake domain" pattern would have swept up real patients.
  **How to apply:** list exact example domains (`example.com/.org/.net/.test/.invalid`, `*.example`), limit deletes to `stripe_mode = 'test'` rows, and assert expected counts inside the transaction (raise when they don't match).
- **Replica-role teardowns leave orphans.** Earlier live-proof teardowns ran under `session_replication_role = replica`, which skips FK checks and cascades. That left production with chat messages, outreach states, digests, app events and sign-ins pointing at deleted patients, offices and logins.
  **How to apply:** every cleanup ends with a sweep over all declared FKs for orphans, plus a whole-database id scan (`query_to_xml` count per text/uuid/json column) for the removed ids. Skip the big read-only food tables, or the scan takes many minutes.
- **Login removal leftovers.** `auth.refresh_tokens.user_id` is varchar with no FK, so tokens can outlive a deleted user; sweep them. Sign-out list rows (`auth_session_revocations`) are different: they are opaque, self-expiring ids. Deleting them early lets unexpired tokens verify locally and hit routes that re-provision rows.
- **Stripe test-mode deletion order:** cancel subscriptions, then delete customers, then remove connected accounts.
  - On a connected account, use `customers.del(id, {}, { stripeAccount })`. With only two arguments, the options are sent as params.
  - Accounts on Stripe's newer (v2) accounts API refuse deletion; close them through v2 instead. Their linked platform customer cannot be deleted on its own.
  - OAuth deauthorize needs a Connect client id owned by the secret key's platform. As of 2026-10-07, Stripe says `STRIPE_TEST_CONNECT_CLIENT_ID` "does not belong to you" under the test key, while the older unprefixed `STRIPE_CONNECT_CLIENT_ID` is owned by it. Delete or close the account instead of deauthorizing.
  - Harmless ownership probe: `oauth.deauthorize` with a non-existent `acct_` id. "No such user" means the client id is owned; "does not belong to you" means it is not.
- **Webhook rows keep arriving during a cleanup.** Production's test webhook inbox receives development's test events (see prod-dev-split.md), so logged deletes can exceed the net drop. Explain the difference instead of chasing it.
- **Prove that kept records are unchanged with a fingerprint.** Before and after, count every table that has `provider_id`, `patient_id` or `provider_account_code` for the kept offices, excluding the deletion scope. Some in-scope rows legitimately live under kept offices: sample orders the seed attributed to a real patient's payer, audit rows about a removed patient, and example-domain viewers or allowlist rows. Every difference must trace to one of these.
- **Reaching production from the workspace:** app code and scripts cannot reach it, because the preload refuses production URLs. Run SQL through the management API with the explicit ref. A direct production API call from a plain shell can use the shared service-role secret, which holds production's key. Never write that key to a file.
  **Gotcha:** inside workspace Node processes, the preload copies `DEV_SUPABASE_SERVICE_ROLE_KEY` over `SUPABASE_SERVICE_ROLE_KEY`, so comparing the two from Node always says "same". Compare them, or probe production, from bash with `env -u NODE_OPTIONS`. Production answers 401 to the dev key.
