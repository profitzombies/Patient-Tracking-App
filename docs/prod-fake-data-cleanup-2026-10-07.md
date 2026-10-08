# Production fake-data cleanup — 2026-10-07

The production Supabase project (ref `xkdhmqexlvkipwgkaiyk`) had offices, patients, customers, orders and logins left over from testing. The owner's rule: anything with a made-up name or address goes, and anything that belongs to a real person stays. The owner approved the candidate list before anything was deleted, re-confirmed the fourth test office, and approved removing the orphaned rows the scan found. This report gives counts only and contains no personal details.

Every step named production explicitly by its project ref or URL. SQL ran through the Supabase management API. Development (`hempvunqnyutzbrgcaqr`) received only the migration that drops the old tool (see the end).

## What was removed

| Group | Before | After |
|---|---:|---:|
| Made-up offices (1 synthetic Stripe-verification office, 2 offices left behind by a failed office-access proof, 1 office the scan classed as a test office; the owner re-confirmed it) | 4 | 0 |
| Made-up patients | 2 | 0 |
| Tagged sample orders (`metadata.sample_seed`), with 78 order items, 74 ledger entries, 68 shipments, 6 refunds and 6 sample subscriptions | 68 | 0 |
| Made-up customers with example-domain emails, with their 10 untagged test orders and 1 test subscription | 9 | 0 |
| Made-up staff allowlist addresses (example domains) | 23 | 0 |
| Made-up logins: the two named in the plan, plus one more that belonged to a removed test office | 3 | 0 |
| Training portal viewers: 12 seeded demo viewers plus 28 test viewers with example-domain addresses (a 41st viewer was removed with the test office), with 247 completions and 3 invites | 40 | 0 |

The same pass removed other rows that were clearly test data or pointed at records that no longer existed:
- Orphans from earlier test teardowns that pointed at patients, offices, conversations or logins that were already gone: 260 chat messages, 28 outreach states, 2 operational follow-ups, 8 attention digests, 9 app events, 2 app-event rollups, 1 presence row and 1 sign-in record.
- 6 second-factor rows and 2 audit rows for test HQ members that no longer exist.
- 406 access-denied audit rows written by one of the removed logins.
- 4 audit rows that described test sales to a removed patient.
- 136 job-failure rows that pointed at the removed offices, an end-to-end test run, or the removed test subscriptions.
- 1 test catalog product and its 4 catalog-change rows.
- 330 Stripe test-mode webhook events. They covered the removed accounts and customers, plus development's own test events that had landed in production's inbox and name no account production knows.

Office- and patient-scoped records were removed one office or patient at a time through the old testing hard-delete function (still in the database at the time), so related rows went in foreign-key order. Each logged run removed its records in a single transaction. The three logins were then removed from Supabase Auth, along with their identities, sessions and sign-in tokens.

## Per-table counts

Exact `count(*)` on production, before (15:21 UTC) and after (15:53 UTC). Only tables that changed are listed. In total, 52 tables lost 2,147 rows.

| Table | Before | After | Removed |
|---|---:|---:|---:|
| `auth.identities` | 13 | 10 | 3 |
| `auth.mfa_amr_claims` | 25 | 16 | 9 |
| `auth.refresh_tokens` | 47 | 32 | 15 |
| `auth.sessions` | 20 | 11 | 9 |
| `auth.users` | 10 | 7 | 3 |
| `public.admin_audit_events` | 981 | 510 | 471 |
| `public.auth_sign_ins` | 29 | 27 | 2 |
| `public.billing_account_events` | 298 | 236 | 62 |
| `public.billing_carts` | 6 | 1 | 5 |
| `public.billing_catalog_changes` | 45 | 31 | 14 |
| `public.billing_connect_guards` | 4 | 2 | 2 |
| `public.billing_connected_accounts` | 6 | 4 | 2 |
| `public.billing_customer_emails` | 2 | 1 | 1 |
| `public.billing_ledger` | 99 | 5 | 94 |
| `public.billing_office_access_events` | 22 | 16 | 6 |
| `public.billing_office_access_instruments` | 9 | 6 | 3 |
| `public.billing_office_access_subscriptions` | 6 | 3 | 3 |
| `public.billing_office_prices` | 36 | 25 | 11 |
| `public.billing_order_items` | 101 | 5 | 96 |
| `public.billing_orders` | 87 | 3 | 84 |
| `public.billing_payers` | 12 | 1 | 11 |
| `public.billing_payment_links` | 5 | 4 | 1 |
| `public.billing_payouts` | 3 | 2 | 1 |
| `public.billing_prebuilt_carts` | 3 | 1 | 2 |
| `public.billing_products` | 12 | 11 | 1 |
| `public.billing_refunds` | 8 | 0 | 8 |
| `public.billing_sandbox_verifications` | 1 | 0 | 1 |
| `public.billing_shipments` | 87 | 3 | 84 |
| `public.billing_subscriptions` | 9 | 1 | 8 |
| `public.billing_warehouse_submissions` | 1 | 0 | 1 |
| `public.billing_webhook_events` | 533 | 203 | 330 |
| `public.office_attention_digests` | 60 | 36 | 24 |
| `public.patient_app_event_rollups` | 27 | 25 | 2 |
| `public.patient_app_events` | 112 | 101 | 11 |
| `public.patient_app_presence` | 10 | 8 | 2 |
| `public.patient_chat_messages` | 281 | 21 | 260 |
| `public.patient_consents` | 3 | 2 | 1 |
| `public.patient_flags` | 3 | 2 | 1 |
| `public.patient_operational_follow_ups` | 2 | 0 | 2 |
| `public.patient_outreach_state` | 32 | 3 | 29 |
| `public.patients` | 6 | 4 | 2 |
| `public.practice_launch` | 6 | 3 | 3 |
| `public.practice_launch_completions` | 3 | 2 | 1 |
| `public.practice_launch_product_receipts` | 4 | 3 | 1 |
| `public.profiles` | 7 | 4 | 3 |
| `public.providers` | 7 | 3 | 4 |
| `public.staff_role_assignments` | 28 | 4 | 24 |
| `public.staff_second_factors` | 11 | 4 | 7 |
| `public.system_job_item_failures` | 333 | 197 | 136 |
| `public.training_completions` | 247 | 0 | 247 |
| `public.training_invites` | 3 | 0 | 3 |
| `public.training_viewers` | 44 | 3 | 41 |

Notes on the counts:
- Every decrease matches the logged deletes, with one exception: the webhook steps logged 332 deletions against a net drop of 330. Two Stripe test-mode events arrived during the cleanup window and were removed with the rest. Stripe sends every test-mode event to every test destination, so production's inbox also receives development's test events. No remaining webhook row arrived after 2026-09-28.
- Three tables grew from activity outside this cleanup. `private.application_migrations` went 29 → 30 from another task's migration. `api_request_metrics` and `system_job_runs` grew from normal activity.

## Stripe test environment (done before the database deletes)

Live mode was not touched.
- 2 test subscriptions belonging to made-up customers were canceled.
- 17 made-up test customers were deleted:
  - 11 tied to the removed records
  - 5 more example-domain customers that existed only in Stripe
  - 1 office-access customer of a removed office, after detaching its 3 saved test cards
- 2 test connected accounts that belonged only to removed offices were removed. One was deleted. The other is linked to Stripe's newer accounts API, which refuses deletion, so it was closed instead.
- Deauthorizing the connections through OAuth failed: Stripe answered that the configured test Connect client id (`STRIPE_TEST_CONNECT_CLIENT_ID`) does not belong to the platform behind the test secret key. A later harmless probe (deauthorizing a non-existent account) showed that the older, unprefixed `STRIPE_CONNECT_CLIENT_ID` does belong to it. Deleting or closing the accounts made that step unnecessary for this cleanup.

## Kept, unchanged

A before/after fingerprint of the kept records matched, apart from the expected changes listed below. The kept records are:
- the 3 real offices and their 4 real patients
- the HQ team: memberships, logins and profiles
- the 4 remaining staff allowlist rows
- the 3 real training viewers
- the owner's own test-card customer, orders and active test subscription, which stay Test records (`stripe_mode = test`, `livemode = false`) and are never relabeled Live
- the legacy archive and all reference content

These fingerprint differences are expected, and every one falls inside the approved scope:
- Kept-office audit rows went from 262 to 257. The 5 removed rows described the removed patient, who was registered under a kept office.
- 5 tagged sample orders were linked to a kept patient, because the sample seed reused that patient's existing customer record as a buyer. They were removed with the other sample orders. That patient's 3 own test orders are unchanged and are now the only orders in production.
- 1 example-domain allowlist address was assigned to a kept office and was removed.
- 12 demo or example-domain training viewers were attached to kept offices and were removed.

## Proof

- **Inventory re-run:** every removal group above is 0. Production has 3 offices and 4 patients.
- **Database-wide scans:** four scans covered every text, UUID, JSON and array column in the `public`, `private`, `auth` and `storage` schemas. Only the read-only food reference tables were skipped.
  - Removed office, patient and login ids: no hits.
  - Removed test HQ member and fixture ids: no hits.
  - Removed Stripe ids and the test product: hits only in the 3 flagged audit rows below.
  - Test markers (example domains, "synthetic", "sample", "smoke", QA prefixes): only the known false positives below.
- **Foreign-key orphan check:** none remain.

## Flagged and left in place

- **3 HQ audit rows** record HQ actions on the removed test catalog product. They are kept as audit history.
- **13 test-mode connected accounts** sit on the shared Stripe test platform, and no office in either database references them. They were not on the approved list. One of them is a newer-API account with a linked example-domain platform customer, which can only be removed by closing the account.
- **Known false positives** were kept. These rows match a marker only because the string appears inside a UUID or ordinary text:
  - 3 audit rows and 2 bloodwork job-failure rows whose ids contain "e2e"
  - 2 webhook events on a kept office's account
  - one product's nutrition facts text
  - one knowledge document
  - two bloodwork file paths
  - one storage migration hash
- **Fixture scripts:** `artifacts/api-server/scripts/verify-office-access-live.ts` and `artifacts/thinnr-operations/scripts/verify-training-access.ts` create the same kinds of fixtures. They now reach only development, because the workspace preload refuses production URLs, so they were left unchanged.

## Testing hard-delete tool retired

- **App:** removed from the HQ account and patient screens, the API (the four `/api/hq/testing-delete/...` routes, which now return 404), the server module, its live-proof script and its web suite. The two validation steps (`testing-delete-api`, `testing-delete-web`) are gone too.
- **Database:** `public.hq_testing_hard_delete(text, uuid)` is dropped by `supabase/migrations/20261202000000_drop_hq_testing_hard_delete.sql`. It was applied to development first, then to production, and both projects confirm the function is gone. Security advisors on both projects show no errors and nothing related to the function. The migration is also listed in the application migration runner (`scripts/apply-coach-migrations.mjs`), which recorded it on both projects. The runner's final checks now fail if the function ever comes back.
- **Remaining deletion paths:** production keeps only its normal ones: patient purge, office offboarding, legal holds and the retention jobs. The original `20261129000000_hq_testing_hard_delete.sql` stays in the repository as migration history.
