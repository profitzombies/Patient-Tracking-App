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
];
const url = process.env.SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!url || !token) throw new Error("Supabase migration configuration is missing.");
const ref = new URL(url).hostname.split(".")[0];

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
       then raise exception 'Coach migration postconditions are not satisfied'; end if;
    end $proof$;
  notify pgrst, 'reload schema';
`);
console.log("Coach and bloodwork schema postconditions verified.");