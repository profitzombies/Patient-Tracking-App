#!/usr/bin/env node
/**
 * Apply this feature's canonical, additive Supabase migrations in order.
 * Never replay the legacy archive/reset migrations as part of application
 * startup. Successful files are recorded atomically by checksum; a changed
 * previously applied file fails rather than silently drifting live DDL.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationNames = [
  // Applied to development by hand before this list existed; production
  // receives it here (it was missing there until 2026-10-07).
  "20260926000000_patient_rewards.sql",
  "20261008000000_coach_conversations.sql",
  "20261008010000_coach_memory.sql",
  "20261008020000_coach_privacy.sql",
  "20261008030000_coach_review_guards.sql",
  "20261008040000_coach_memory_sentence_policy.sql",
  "20261009000000_patient_bloodwork_progress.sql",
  "20261010000000_bloodwork_extraction_scheduling.sql",
  "20261010010000_bloodwork_extraction_privacy_guard.sql",
  "20261011000000_staff_attention_alerts.sql",
  "20261014000000_staff_attention_alerts_privacy.sql",
  "20261017000000_app_store_links.sql",
  "20261018000000_hq_drive_ordering.sql",
  "20261019000000_coach_conversation_titles.sql",
  "20261019010000_coach_title_requeue.sql",
  "20261020000000_hq_file_size_limit.sql",
  "20261027000000_ledger_retention.sql",
  "20261106000000_clinical_record_retention.sql",
  "20261106010000_staff_second_factor.sql",
  "20261107000000_cold_archive.sql",
  "20261107000000_legal_holds.sql",
  "20261113000000_practice_launch.sql",
  "20261113010000_practice_launch_products.sql",
  "20261113020000_practice_launch_mode_completion.sql",
  "20261113030000_practice_launch_trigger_permissions.sql",
  "20261201000000_coach_chat_flags.sql",
  "20261201000001_coach_chat_flags_closure.sql",
  "20261201000002_patient_rewards_closure.sql",
  "20261201000000_patient_groups.sql",
  // Retires the HQ testing hard-delete override. Its create migration
  // (20261129000000) was never ledgered here; the proof below asserts the
  // function stays absent on every project this runner touches.
  "20261202000000_drop_hq_testing_hard_delete.sql",
];

// Also used to verify manually applied launch DDL before recording receipts.
// These assertions inspect schema/privileges only; they never replay CREATE.
const launchPostconditions = `
  do $launch_proof$
  declare routine regprocedure; relation regclass; role_name text;
  begin
    foreach relation in array array[
      to_regclass('public.practice_launch'),
      to_regclass('public.practice_launch_tours'),
      to_regclass('public.practice_launch_product_receipts'),
      to_regclass('public.practice_launch_completions')
    ] loop
      if relation is null or not exists(select 1 from pg_class where oid=relation and relrowsecurity) then
        raise exception 'Practice launch table or RLS missing';
      end if;
      foreach role_name in array array['anon','authenticated'] loop
        if has_table_privilege(role_name,relation,'INSERT,UPDATE,DELETE') then
          raise exception 'Practice launch table writable by browser role';
        end if;
      end loop;
    end loop;
    if to_regprocedure('public.complete_practice_launch(text,integer)') is not null
      or not exists(select 1 from information_schema.columns where table_schema='public'
        and table_name='billing_office_prices' and column_name='enabled' and data_type='boolean' and is_nullable='NO')
      or not exists(select 1 from pg_trigger where tgrelid='public.providers'::regclass
        and tgname='initialize_practice_launch' and tgenabled='O' and not tgisinternal
        and tgfoid=to_regprocedure('public.initialize_practice_launch()'))
    then raise exception 'Practice launch rollout/product/mode schema missing'; end if;
    foreach routine in array array[
      to_regprocedure('public.initialize_practice_launch()'),
      to_regprocedure('public.save_practice_launch_details(text,integer,jsonb)'),
      to_regprocedure('public.save_practice_launch_products(text,uuid,integer,jsonb,text,text)'),
      to_regprocedure('public.complete_practice_launch(text,integer,text,text)')
    ] loop
      if routine is null then raise exception 'Practice launch routine missing'; end if;
      foreach role_name in array array['anon','authenticated'] loop
        if has_function_privilege(role_name,routine,'EXECUTE') then
          raise exception 'Practice launch routine executable by browser role';
        end if;
      end loop;
    end loop;
    if (select count(*) from information_schema.columns where table_schema='public'
      and table_name='practice_launch' and column_name in
      ('provider_id','required','version','details_confirmed','products_confirmed','completed_at'))<>6
      or not exists(select 1 from pg_constraint where conrelid='public.practice_launch_completions'::regclass
        and contype='p' and pg_get_constraintdef(oid)='PRIMARY KEY (provider_id, stripe_mode, platform_account_id)')
    then raise exception 'Practice launch state/identity contract missing'; end if;
  end $launch_proof$;
`;
// Targets the workspace project (development) unless a ref is named
// explicitly: `node scripts/apply-coach-migrations.mjs --project <ref>` is how
// a migration reaches production after it has been applied to development.
const projectArg = process.argv.indexOf("--project");
const explicitRef = projectArg === -1 ? null : process.argv[projectArg + 1];
if (projectArg !== -1 && !/^[a-z]{20}$/.test(explicitRef ?? "")) throw new Error("--project needs a Supabase project ref.");
const url = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if ((!url && !explicitRef) || !token) throw new Error("Supabase migration configuration is missing.");
const ref = explicitRef ?? new URL(url).hostname.split(".")[0];
console.log(`Applying application migrations to Supabase project ${ref}.`);

// Only statuses the management API returns BEFORE running the statement are
// retried (maintenance / rate limit). Anything else could have executed
// server-side, and replaying DDL blindly is worse than failing the merge.
const RETRY_STATUSES = new Set([429, 503]);
const RETRY_DELAYS_MS = [5_000, 20_000];

async function query(sql) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
      signal: AbortSignal.timeout(90_000),
    });
    if (response.ok) return response.json();
    if (RETRY_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
      console.log(`Supabase management API unavailable (HTTP ${response.status}); retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    // PostgreSQL error detail can contain private row values. Never print it.
    throw new Error(`Supabase migration request failed (HTTP ${response.status}).`);
  }
}

await query(`
  create schema if not exists private;
  create table if not exists private.application_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now()
  );
  revoke all on private.application_migrations from public, anon, authenticated;
`);

for (const name of migrationNames) {
  const path = fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url));
  const source = await readFile(path, "utf8");
  const checksum = createHash("sha256").update(source).digest("hex");
  const applied = await query(`select checksum from private.application_migrations where name = '${name}'`);
  if (applied.length) {
    if (applied[0].checksum !== checksum) throw new Error(`Previously applied migration changed: ${name}`);
    console.log(`Already applied: ${name}`);
    continue;
  }
  // Canonical files own no external side effects. The advisory lock and
  // checksum insert share their transaction with DDL, including on retry.
  // Migration files may contain their own transaction wrapper; remove only
  // whole-line wrappers before supplying this outer transaction.
  const body = source.replace(/^\s*(?:begin|commit);\s*$/gim, "");
  await query(`
    begin;
    select pg_advisory_xact_lock(hashtextextended('thinnr-application-migrations', 0));
    do $guard$ begin
      if exists (select 1 from private.application_migrations where name = '${name}') then
        raise exception 'Concurrent migration application; retry setup';
      end if;
    end $guard$;
    ${body}
    insert into private.application_migrations(name, checksum) values ('${name}', '${checksum}');
    commit;
  `);
  console.log(`Applied: ${name}`);
}

await query(`
  do $proof$ begin
    if to_regclass('public.coach_memories') is null
       or to_regclass('public.coach_memory_source_suppressions') is null
       or to_regclass('public.coach_conversation_work') is null
       or to_regclass('public.patient_bloodwork_reports') is null
       or to_regprocedure('private.bloodwork_extraction_patient_allowed(uuid)') is null
       or not exists (
         select 1 from information_schema.columns
          where table_schema='public' and table_name='patient_bloodwork_files' and column_name='content_sha256'
       )
       or (select count(*) from information_schema.columns
           where table_schema='public' and table_name='patient_bloodwork_reports'
             and column_name in (
               'extraction_phase', 'extraction_completed_pages', 'extraction_total_pages',
               'extraction_started_at', 'extraction_progress_updated_at',
               'extraction_completed_at', 'extraction_finished_at'
             )) <> 7
       or not exists (
         select 1 from information_schema.columns
          where table_schema='public' and table_name='patient_chat_conversations' and column_name='legacy_compat'
       )
       or (select count(*) from information_schema.columns
           where table_schema='public' and table_name='hq_organization_settings'
             and column_name in ('app_store_url', 'google_play_url')) <> 2
       or not exists (
         select 1 from pg_constraint
          where conrelid = 'public.hq_private_files'::regclass
            and conname = 'hq_private_files_size_bytes_check'
            and pg_get_constraintdef(oid) like '%262144000%'
       )
       or (select count(*) from information_schema.columns
           where table_schema='public' and table_name='hq_organization_settings'
             and column_name in ('retention_job_run_days', 'retention_sign_in_days', 'retention_webhook_event_days')) <> 3
       or to_regprocedure('public.retention_trim_job_runs(timestamptz,integer,integer,boolean)') is null
       or to_regprocedure('public.retention_trim_sign_ins(timestamptz,timestamptz,integer,boolean)') is null
       or to_regprocedure('public.retention_trim_billing_webhook_events(timestamptz,integer,boolean)') is null
       or not exists (
         select 1 from information_schema.columns
          where table_schema='public' and table_name='hq_organization_settings' and column_name='retention_clinical_record_days'
       )
       or not exists (
         select 1 from pg_constraint
          where conrelid = 'public.hq_organization_settings'::regclass
            and conname = 'hq_organization_settings_retention_audit_days_check'
            and pg_get_constraintdef(oid) like '%2190%'
       )
       or not exists (
         select 1 from information_schema.columns
          where table_schema='public' and table_name='hq_organization_settings' and column_name='cold_archive_enabled'
       )
       or to_regclass('public.system_cold_archive_days') is null
       or to_regprocedure('public.cold_archive_rows(text,date,text,integer)') is null
       or to_regprocedure('public.cold_archive_status(date)') is null
       or to_regclass('public.legal_holds') is null
       or to_regprocedure('public.legal_hold_active(uuid)') is null
       or to_regprocedure('public.legal_hold_office_active(text)') is null
       or to_regprocedure('public.legal_hold_place(text,text,text,uuid)') is null
       or to_regprocedure('public.legal_hold_lift(uuid,text,uuid)') is null
       or not exists (
         select 1 from pg_constraint
          where conrelid = 'public.patient_deletion_requests'::regclass
            and contype = 'c' and pg_get_constraintdef(oid) like '%held%'
       )
       or to_regclass('public.staff_second_factors') is null
       or (select count(*) from information_schema.columns
           where table_schema='public' and table_name='hq_organization_settings'
             and column_name in ('second_factor_hq_users', 'second_factor_office_managers', 'second_factor_all_staff')) <> 3
       or not exists (
         select 1 from pg_constraint
          where conrelid = 'public.auth_sign_ins'::regclass
            and conname = 'auth_sign_ins_method_check'
            and pg_get_constraintdef(oid) like '%email_sms_code%'
       )
       -- Office patient groups: the roster and patient-record reads join the
       -- membership table, so publishing without it breaks every office.
       or to_regclass('public.patient_groups') is null
       or to_regclass('public.patient_group_members') is null
       or not exists (
         select 1 from pg_indexes
          where schemaname = 'public' and tablename = 'patient_groups' and indexname = 'patient_groups_provider_name_ci_idx'
       )
       or not exists (
         select 1 from pg_trigger
          where tgrelid = 'public.patient_group_members'::regclass and tgname = 'patient_identity_write_guard' and not tgisinternal
       )
       or has_table_privilege('anon', 'public.patient_group_members', 'SELECT')
       or has_table_privilege('authenticated', 'public.patient_groups', 'SELECT')
       -- The retired testing hard-delete wipe must never come back: production
       -- keeps only patient purge, office offboarding, legal holds and retention.
       or to_regprocedure('public.hq_testing_hard_delete(text,uuid)') is not null
       then raise exception 'Coach migration postconditions are not satisfied'; end if;
    end $proof$;
  notify pgrst, 'reload schema';
`);
await query(launchPostconditions);
console.log("Coach, bloodwork and practice launch schema postconditions verified.");