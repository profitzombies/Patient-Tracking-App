# Legacy data archive & database reset — 2026-08-30

The live Supabase database inherited ~14,600 patients, 562 provider offices, 85k legacy chat
messages, subscriptions/transactions, and ~2.5M analytics rows from the previous THINNR system.
On 2026-08-30 all of it was archived and the live tables were reset so the platform starts clean
with only Andrew's HQ login plus the program content. Nothing was deleted before both copies were
proven complete.

## Where the archived data lives

1. **`legacy_archive` schema (same database)** — a full copy of all 47 public tables plus
   `auth_users_manifest` (auth users' ids, emails, timestamps, metadata — never password hashes
   or tokens) and `archive_manifest` (the audit table below). All privileges are revoked from
   `anon`/`authenticated` and the schema is not exposed through PostgREST; only the service
   role / owner can read it. Every table's row count AND an order-independent md5 content checksum
   were verified equal to the source before any deletion.
2. **App Storage JSONL export** — `.private/legacy-export-2026-08-30/` in the default bucket:
   the 11 core business tables (providers, patients, customers, team_members, app_subscriptions,
   product_subscriptions, transactions, provider_referrals, patient_measurements,
   provider_measurements, claim_verifications) + `auth_users_manifest.jsonl` +
   `_row_count_manifest.jsonl` + `_export_summary.json` (14 files, ~33 MB).

## What the live database contains now

- **Identity:** exactly one auth user — Andrew (andrew+admin@thinnrweightloss.com), with his
  profile, staff_role_assignments row, and protected super_admin hq_membership. The two leftover
  test staff logins (dana.frontdesk@…, qa-ui-staff-…) were fully removed, along with a dangling
  staff_role_assignments row for riley-test@… and the stale pre-authorized role_assignments row
  for andrew+provider@…. Recreate demo staff any time with
  `pnpm --filter @workspace/thinnr-operations run create:demo-staff`.
- **Program content, untouched:** approved_foods, ingredient_macros, barcode_nutrition_facts,
  craving_foods(+flagged), possible_free_foods, all training content + its App Storage media,
  and knowledge_documents (checksummed counts pinned during the wipe transaction).
- **Everything people-related is empty** (see manifest below). Feature tables with no legacy rows
  (hq_invitations, provider_account_locks, tech_support_messages) keep their structure.

## Verification performed after the reset

- Supabase security advisors: no findings mention `legacy_archive`; anon/authenticated have no
  schema usage or table select on it (only the pre-existing, deliberate open-training WARNs remain).
- Live smoke (disposable @thinnr-staff-check.com admin, deleted afterwards): password sign-in ✓,
  `GET /api/provider-accounts` → 200 empty ✓, `GET /api/hq-team` → Andrew ✓,
  `GET /api/knowledge/documents` → 5 docs ✓.
- UI pass on the operations app: honest empty state + working Add Provider dialog on
  /admin/accounts, /admin/team shows only Andrew, training (3 courses / 48 lessons) and knowledge
  (5 docs) fully populated, no 500s or console errors.
- App Storage: training/knowledge media kept; nothing deleted (progress photos + one stray root
  video kept as uncertain-ownership; see follow-up task).

## Reapply safety

The archive migration (`supabase/migrations/20260910000000_legacy_archive.sql`) is registered in
`supabase_migrations.schema_migrations`, so standard migration tooling will not re-apply it. It is
also safe if ever re-run anyway: table copies use `CREATE TABLE IF NOT EXISTS` and the manifest
counts insert with `ON CONFLICT DO NOTHING` (write-once) — proven by re-running the populate block
against the post-reset database and confirming the manifest stayed byte-identical (48 rows,
pre-reset counts intact).

## Re-import (deliberate later phase)

Selected legacy records can be mapped and re-imported from `legacy_archive` (or the JSONL
export) once Andrew has built his real office. Nothing in this reset re-creates people data.
The one-time scripts live in `scripts/legacy-reset/` (archive → verify → export → wipe →
auth cleanup → smoke), each gated so the destructive steps cannot run without the archive
verification PASS marker.

## Per-table manifest (before → archived → after)

| Table | Rows before | Rows archived | Live rows after reset |
|---|---|---|---|
| app_subscriptions | 2066 | 2066 | 0 |
| approved_foods | 129677 | 129677 | 129677 |
| auth.users (manifest) | 3 | 3 | 1 |
| barcode_nutrition_facts | 7 | 7 | 7 |
| chatbot_messages | 85524 | 85524 | 0 |
| claim_verifications | 2 | 2 | 0 |
| coach_conversation_messages | 784 | 784 | 0 |
| coach_conversations | 448 | 448 | 0 |
| craving_foods | 13001 | 13001 | 13001 |
| craving_foods_flagged | 238 | 238 | 238 |
| custom_foods | 22537 | 22537 | 0 |
| custom_recipes | 53072 | 53072 | 0 |
| customers | 479 | 479 | 0 |
| global_onboard_daily | 512 | 512 | 0 |
| hq_invitations | 0 | 0 | 0 |
| hq_memberships | 1 | 1 | 1 |
| ingredient_macros | 68738 | 68738 | 68738 |
| knowledge_documents | 5 | 5 | 5 |
| patient_feedback | 1859 | 1859 | 0 |
| patient_log_flags | 3471 | 3471 | 0 |
| patient_logs | 84084 | 84084 | 0 |
| patient_measurements | 230 | 230 | 0 |
| patient_messages | 24887 | 24887 | 0 |
| patients | 14643 | 14643 | 0 |
| possible_free_foods | 4811 | 4811 | 4811 |
| product_subscriptions | 54 | 54 | 0 |
| profiles | 3 | 3 | 1 |
| provider_account_locks | 0 | 0 | 0 |
| provider_measurements | 73 | 73 | 0 |
| provider_referrals | 22 | 22 | 0 |
| providers | 562 | 562 | 0 |
| role_assignments | 1 | 1 | 0 |
| staff_role_assignments | 4 | 4 | 1 |
| team_members | 720 | 720 | 0 |
| tech_support_messages | 0 | 0 | 0 |
| training_completions | 236 | 236 | 0 |
| training_courses | 3 | 3 | 3 |
| training_invites | 11 | 11 | 0 |
| training_learner_sessions | 28 | 28 | 0 |
| training_media_cleanup | 0 | 0 | 0 |
| training_modules | 10 | 10 | 10 |
| training_subgroups | 3 | 3 | 3 |
| training_video_transcripts | 0 | 0 | 0 |
| training_videos | 48 | 48 | 48 |
| training_viewers | 48 | 48 | 0 |
| transactions | 495 | 495 | 0 |
| user_metrics | 2552524 | 2552524 | 0 |
| users_onboarded_daily | 4706 | 4706 | 0 |
