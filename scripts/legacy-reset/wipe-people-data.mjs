/**
 * One-time transactional wipe of all people data (deliberately NOT a
 * migration — it must never re-run on a future database).
 *
 * Hard gates before any delete:
 *   1. /tmp/t366_archive_verify_PASS must exist (verify-archive.mjs proved
 *      counts AND full-content checksums for every table).
 *   2. Live counts are re-compared against legacy_archive counts for every
 *      table this script touches — any drift since archiving aborts.
 *   3. The whole wipe runs inside ONE database transaction (a single DO
 *      block): owner-identity preconditions, TRUNCATE of the fully-wiped
 *      tables, partial deletes, then end-state assertions — zeros for wiped
 *      tables, exactly-Andrew for profiles/staff_role_assignments/
 *      hq_memberships, and pinned row counts for every kept content table.
 *      Any failed assertion raises, rolling everything back.
 *
 * Afterwards it stamps live_rows_after_reset into the archive manifest.
 *
 * Usage: node scripts/legacy-reset/wipe-people-data.mjs --confirm-wipe
 */
import { existsSync } from "node:fs";
import {
  sql,
  WIPE_TABLES,
  PARTIAL_TABLES,
  KEEP_TABLES,
  KEEP_COUNTS,
  OWNER_AUTH_ID,
  OWNER_EMAIL,
  STALE_ROLE_ASSIGNMENT_EMAIL,
} from "./lib.mjs";

if (process.argv[2] !== "--confirm-wipe") {
  console.error("Refusing to run without --confirm-wipe");
  process.exit(1);
}
if (!existsSync("/tmp/t366_archive_verify_PASS")) {
  console.error("BLOCKED: archive verification PASS marker not found. Run verify-archive.mjs first.");
  process.exit(1);
}

// Gate 2: live vs archived drift check for every table we are about to touch.
const touched = [...WIPE_TABLES, ...PARTIAL_TABLES];
const driftQuery = touched
  .map(
    (t) =>
      `select '${t}' as tbl, (select count(*) from public.${t}) as live, (select count(*) from legacy_archive.${t}) as archived`,
  )
  .join(" union all ");
const drift = (await sql(driftQuery)).filter((row) => row.live !== row.archived);
if (drift.length > 0) {
  console.error("BLOCKED: live tables drifted since archiving:", JSON.stringify(drift));
  process.exit(1);
}
console.log(`drift gate passed: ${touched.length} tables still match the archive`);

const zeroAfter = [...WIPE_TABLES, "tech_support_messages", "role_assignments"];
const keepAsserts = Object.entries(KEEP_COUNTS)
  .filter(([t]) => t !== "tech_support_messages" && t !== "hq_memberships")
  .map(
    ([t, n]) =>
      `select count(*) into n from public.${t};\n  if n <> ${n} then raise exception 'ABORT: kept table ${t} expected ${n} rows, found %', n; end if;`,
  )
  .join("\n  ");

const wipe = `
set local statement_timeout = '600s';
do $wipe$
declare
  v_owner_id constant uuid := '${OWNER_AUTH_ID}';
  v_owner_email constant text := '${OWNER_EMAIL}';
  v_stale_ra constant text := '${STALE_ROLE_ASSIGNMENT_EMAIL}';
  n bigint;
  t text;
begin
  -- Preconditions: the identity that must survive is present and correct.
  perform 1 from auth.users where id = v_owner_id and lower(email) = v_owner_email;
  if not found then raise exception 'ABORT: owner auth identity missing'; end if;
  perform 1 from public.profiles where id = v_owner_id and role::text = 'hq_admin';
  if not found then raise exception 'ABORT: owner profile missing'; end if;
  perform 1 from public.hq_memberships
    where auth_user_id = v_owner_id and status::text = 'active' and is_protected_owner;
  if not found then raise exception 'ABORT: protected owner hq membership missing'; end if;

  -- Full wipe. tech_support_messages (0 rows) rides along only because it
  -- holds an FK to patients; TRUNCATE requires every referencing table in
  -- the same statement. Structure is kept for all of these.
  truncate table
    public.transactions, public.product_subscriptions, public.app_subscriptions,
    public.chatbot_messages, public.coach_conversation_messages, public.coach_conversations,
    public.patient_messages, public.patient_logs, public.patient_log_flags,
    public.patient_feedback, public.patient_measurements, public.custom_foods,
    public.custom_recipes, public.customers, public.tech_support_messages,
    public.training_completions, public.training_invites, public.training_learner_sessions,
    public.training_viewers, public.claim_verifications, public.user_metrics,
    public.users_onboarded_daily, public.global_onboard_daily, public.patients,
    public.provider_measurements, public.provider_referrals, public.team_members,
    public.providers;

  -- Partial tables: keep only Andrew. The staff_role_assignments delete
  -- trigger demotes matching profiles — those rows are already gone, so it
  -- is a no-op. Deleting the stale pre-authorized provider row empties
  -- role_assignments.
  delete from public.profiles where id <> v_owner_id;
  delete from public.staff_role_assignments where lower(email) <> lower(v_owner_email);
  delete from public.role_assignments where lower(coalesce(email, '')) = lower(v_stale_ra);

  -- End-state assertions (any failure rolls the whole transaction back).
  foreach t in array array[${zeroAfter.map((t) => `'${t}'`).join(",")}] loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then raise exception 'ABORT: % still has % rows', t, n; end if;
  end loop;

  select count(*) into n from public.profiles;
  if n <> 1 then raise exception 'ABORT: profiles expected 1 row, found %', n; end if;
  perform 1 from public.profiles where id = v_owner_id and role::text = 'hq_admin';
  if not found then raise exception 'ABORT: owner profile lost'; end if;

  select count(*) into n from public.staff_role_assignments;
  if n <> 1 then raise exception 'ABORT: staff_role_assignments expected 1 row, found %', n; end if;
  perform 1 from public.staff_role_assignments
    where lower(email) = lower(v_owner_email) and role::text = 'hq_admin';
  if not found then raise exception 'ABORT: owner staff role assignment lost'; end if;

  select count(*) into n from public.hq_memberships;
  if n <> 1 then raise exception 'ABORT: hq_memberships expected 1 row, found %', n; end if;
  perform 1 from public.hq_memberships
    where auth_user_id = v_owner_id and status::text = 'active' and is_protected_owner;
  if not found then raise exception 'ABORT: owner hq membership lost'; end if;

  select count(*) into n from auth.users where id = v_owner_id;
  if n <> 1 then raise exception 'ABORT: owner auth user lost'; end if;

  -- Kept content tables must be untouched, byte for byte the same row counts
  -- that were classified and archived.
  ${keepAsserts}
end
$wipe$;`;

console.log("running transactional wipe...");
await sql(wipe, { label: "transactional wipe" });

// Stamp the after-reset counts into the audit manifest.
await sql(
  `do $stamp$
   declare t record; n bigint;
   begin
     for t in select table_name from legacy_archive.archive_manifest
              where table_name <> 'auth.users (manifest)'
     loop
       execute format('select count(*) from public.%I', t.table_name) into n;
       update legacy_archive.archive_manifest
         set live_rows_after_reset = n, reset_at = now()
         where table_name = t.table_name;
     end loop;
     select count(*) into n from auth.users;
     update legacy_archive.archive_manifest
       set live_rows_after_reset = n, reset_at = now()
       where table_name = 'auth.users (manifest)';
   end
   $stamp$;`,
  { label: "manifest after-counts" },
);

const after = await sql(
  "select table_name, source_rows, live_rows_after_reset from legacy_archive.archive_manifest order by table_name",
);
console.table(after.map((r) => ({ table: r.table_name, before: r.source_rows, after: r.live_rows_after_reset })));
console.log("WIPE COMPLETE — archive untouched, live people data cleared");
