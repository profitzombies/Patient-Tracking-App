-- Legacy archive: a complete, locked-away copy of every public table taken
-- immediately BEFORE the live people-data reset (archive first, wipe second).
--
--   * `legacy_archive` is data-only cold storage for the later selective
--     re-import: CREATE TABLE ... AS SELECT copies columns and rows, not
--     constraints/indexes/triggers/RLS. The live schema stays canonical in
--     `public` and in the repo migrations.
--   * The schema is invisible to the data plane. PostgREST exposes only
--     `public,graphql_public` (verified against the live config), and every
--     privilege is revoked from public/anon/authenticated here as well, so
--     only the database owner path (management API / service tooling) can
--     read it.
--   * `auth_users_manifest` captures auth.users identity metadata WITHOUT any
--     secret-bearing column: no password hashes and no confirmation /
--     recovery / email-change / phone-change / reauthentication tokens.
--   * CREATE TABLE IF NOT EXISTS keeps a partially-applied run retryable:
--     each CTAS is atomic (a table either exists fully copied or not at all),
--     so re-applying skips finished copies and never duplicates rows.
--   * `-- apply-batch:` markers split the file into management-API calls so
--     the big copies (user_metrics is ~512 MB) get their own statement-
--     timeout window. The applied SQL is exactly this file's statements.

-- apply-batch: 1
set local statement_timeout = '1500s';

create schema if not exists legacy_archive;

revoke all on schema legacy_archive from public;
revoke all on schema legacy_archive from anon;
revoke all on schema legacy_archive from authenticated;
alter default privileges in schema legacy_archive revoke all on tables from public;
alter default privileges in schema legacy_archive revoke all on tables from anon;
alter default privileges in schema legacy_archive revoke all on tables from authenticated;

comment on schema legacy_archive is
  'Frozen pre-reset copy of every public table plus an auth.users manifest, taken 2026-08-30 before the live people-data wipe. Cold storage for the later selective re-import; never granted to anon/authenticated and never exposed through PostgREST.';

-- Audit record: per-table source vs archived counts (populated in the final
-- batch), and the live row count after the reset (written by the one-time
-- wipe script). This is the durable before/archived/after manifest.
create table if not exists legacy_archive.archive_manifest (
  table_name text primary key,
  source_rows bigint not null,
  archived_rows bigint not null,
  archived_at timestamptz not null default now(),
  live_rows_after_reset bigint,
  reset_at timestamptz
);

-- Identity metadata only — never password hashes or one-time tokens.
create table if not exists legacy_archive.auth_users_manifest as
select
  id, aud, role, email, phone,
  created_at, updated_at, last_sign_in_at,
  email_confirmed_at, phone_confirmed_at, confirmed_at,
  invited_at, confirmation_sent_at, recovery_sent_at, email_change_sent_at,
  banned_until, deleted_at, is_sso_user, is_anonymous, is_super_admin,
  raw_app_meta_data, raw_user_meta_data
from auth.users;

-- apply-batch: 2
set local statement_timeout = '1500s';

create table if not exists legacy_archive.app_subscriptions as select * from public.app_subscriptions;
create table if not exists legacy_archive.barcode_nutrition_facts as select * from public.barcode_nutrition_facts;
create table if not exists legacy_archive.claim_verifications as select * from public.claim_verifications;
create table if not exists legacy_archive.coach_conversation_messages as select * from public.coach_conversation_messages;
create table if not exists legacy_archive.coach_conversations as select * from public.coach_conversations;
create table if not exists legacy_archive.craving_foods as select * from public.craving_foods;
create table if not exists legacy_archive.craving_foods_flagged as select * from public.craving_foods_flagged;
create table if not exists legacy_archive.custom_foods as select * from public.custom_foods;
create table if not exists legacy_archive.customers as select * from public.customers;
create table if not exists legacy_archive.global_onboard_daily as select * from public.global_onboard_daily;
create table if not exists legacy_archive.hq_invitations as select * from public.hq_invitations;
create table if not exists legacy_archive.hq_memberships as select * from public.hq_memberships;
create table if not exists legacy_archive.ingredient_macros as select * from public.ingredient_macros;
create table if not exists legacy_archive.knowledge_documents as select * from public.knowledge_documents;
create table if not exists legacy_archive.patient_feedback as select * from public.patient_feedback;
create table if not exists legacy_archive.patient_log_flags as select * from public.patient_log_flags;
create table if not exists legacy_archive.patient_measurements as select * from public.patient_measurements;
create table if not exists legacy_archive.patient_messages as select * from public.patient_messages;
create table if not exists legacy_archive.patients as select * from public.patients;
create table if not exists legacy_archive.possible_free_foods as select * from public.possible_free_foods;
create table if not exists legacy_archive.product_subscriptions as select * from public.product_subscriptions;
create table if not exists legacy_archive.profiles as select * from public.profiles;
create table if not exists legacy_archive.provider_account_locks as select * from public.provider_account_locks;
create table if not exists legacy_archive.provider_measurements as select * from public.provider_measurements;
create table if not exists legacy_archive.provider_referrals as select * from public.provider_referrals;
create table if not exists legacy_archive.providers as select * from public.providers;
create table if not exists legacy_archive.role_assignments as select * from public.role_assignments;
create table if not exists legacy_archive.staff_role_assignments as select * from public.staff_role_assignments;
create table if not exists legacy_archive.team_members as select * from public.team_members;
create table if not exists legacy_archive.tech_support_messages as select * from public.tech_support_messages;
create table if not exists legacy_archive.training_completions as select * from public.training_completions;
create table if not exists legacy_archive.training_courses as select * from public.training_courses;
create table if not exists legacy_archive.training_invites as select * from public.training_invites;
create table if not exists legacy_archive.training_learner_sessions as select * from public.training_learner_sessions;
create table if not exists legacy_archive.training_media_cleanup as select * from public.training_media_cleanup;
create table if not exists legacy_archive.training_modules as select * from public.training_modules;
create table if not exists legacy_archive.training_subgroups as select * from public.training_subgroups;
create table if not exists legacy_archive.training_video_transcripts as select * from public.training_video_transcripts;
create table if not exists legacy_archive.training_videos as select * from public.training_videos;
create table if not exists legacy_archive.training_viewers as select * from public.training_viewers;
create table if not exists legacy_archive.transactions as select * from public.transactions;
create table if not exists legacy_archive.users_onboarded_daily as select * from public.users_onboarded_daily;

-- apply-batch: 3
set local statement_timeout = '1500s';

create table if not exists legacy_archive.approved_foods as select * from public.approved_foods;

-- apply-batch: 4
set local statement_timeout = '1500s';

create table if not exists legacy_archive.patient_logs as select * from public.patient_logs;

-- apply-batch: 5
set local statement_timeout = '1500s';

create table if not exists legacy_archive.chatbot_messages as select * from public.chatbot_messages;
create table if not exists legacy_archive.custom_recipes as select * from public.custom_recipes;

-- apply-batch: 6
set local statement_timeout = '1500s';

create table if not exists legacy_archive.user_metrics as select * from public.user_metrics;

-- apply-batch: 7
set local statement_timeout = '1500s';

-- Record source vs archived counts for every archived table while both sides
-- still exist. Equality here is the gate the wipe script re-checks before any
-- delete is allowed.
--
-- WRITE-ONCE: rows insert with ON CONFLICT DO NOTHING. Once a table's counts
-- are recorded they are frozen — re-applying this migration after the live
-- wipe must NEVER overwrite the pre-reset audit record with post-reset counts.
do $manifest$
declare
  t record;
  src bigint;
  arch bigint;
begin
  for t in
    select table_name
    from information_schema.tables
    where table_schema = 'legacy_archive'
      and table_type = 'BASE TABLE'
      and table_name not in ('archive_manifest', 'auth_users_manifest')
  loop
    execute format('select count(*) from public.%I', t.table_name) into src;
    execute format('select count(*) from legacy_archive.%I', t.table_name) into arch;
    insert into legacy_archive.archive_manifest (table_name, source_rows, archived_rows)
    values (t.table_name, src, arch)
    on conflict (table_name) do nothing;
  end loop;

  select count(*) into src from auth.users;
  select count(*) into arch from legacy_archive.auth_users_manifest;
  insert into legacy_archive.archive_manifest (table_name, source_rows, archived_rows)
  values ('auth.users (manifest)', src, arch)
  on conflict (table_name) do nothing;
end
$manifest$;
