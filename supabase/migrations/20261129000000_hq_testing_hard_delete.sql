-- HQ testing override: permanently erase one office (and everything tied to
-- it) or one patient. This is deliberately NOT the compliant lifecycle — no
-- tombstone, no audit row, no grace period — and exists only while THINNR is
-- being tested. It is self-contained so it can be dropped in one migration:
--
--   drop function if exists public.hq_testing_hard_delete(text, uuid);
--
-- Exactly one of p_provider_id / p_patient_id must be given. Every database
-- row keyed to the target is removed in this one transaction; the caller
-- (API) then deletes the returned login accounts and storage objects. Anyone
-- with an HQ membership keeps their login and only loses office links.
create or replace function public.hq_testing_hard_delete(
  p_provider_id text default null,
  p_patient_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_provider text := nullif(btrim(coalesce(p_provider_id, '')), '');
  v_pids uuid[];
  v_ptxt text[];
  v_team_ids text[] := '{}'::text[];
  v_users uuid[] := '{}'::uuid[];
  v_preserved uuid[] := '{}'::uuid[];
  v_delete_users uuid[] := '{}'::uuid[];
  v_identifiers text[] := '{}'::text[];
  v_orders uuid[] := '{}'::uuid[];
  v_subs uuid[] := '{}'::uuid[];
  v_payers uuid[] := '{}'::uuid[];
  v_contacts uuid[] := '{}'::uuid[];
  v_emails uuid[] := '{}'::uuid[];
  v_accounts text[] := '{}'::text[];
  v_customers text[] := '{}'::text[];
  v_exports uuid[] := '{}'::uuid[];
  v_paths text[] := '{}'::text[];
  v_viewers uuid[] := '{}'::uuid[];
  v_accounts_keys text[] := '{}'::text[];
  v_tables jsonb := '{}'::jsonb;
  v_pending text[];
  v_blocked text[];
  v_name text;
  v_col text;
  v_type text;
  v_pass integer;
  v_count bigint;
  v_pid uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if (v_provider is null) = (p_patient_id is null) then
    raise exception 'exactly one of provider or patient is required';
  end if;

  -- ── Scope ────────────────────────────────────────────────────────────────
  if v_provider is not null then
    if not exists (select 1 from providers where provider_id = v_provider) then
      raise exception 'unknown office' using errcode = 'P0002';
    end if;
    v_pids := array(select id from patients where provider_id = v_provider);
    v_team_ids := array(select id::text from team_members where provider_id = v_provider);
    v_accounts_keys := array[v_provider, 'acct-' || v_provider];
  else
    if not exists (select 1 from patients where id = p_patient_id) then
      raise exception 'unknown patient' using errcode = 'P0002';
    end if;
    -- Identity-reconciliation leftovers of the same person go with them.
    v_pids := array(
      select p_patient_id
      union select id from patients where archived_into_patient_id = p_patient_id
    );
  end if;
  v_pids := coalesce(v_pids, '{}'::uuid[]);
  v_ptxt := array(select unnest(v_pids)::text);

  foreach v_pid in array v_pids loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_pid::text, 40421001));
  end loop;

  -- ── Logins ───────────────────────────────────────────────────────────────
  v_users := array(
    select distinct u from (
      select auth_user_id as u from patients where id = any(v_pids)
      union all select auth_user_id from providers where v_provider is not null and provider_id = v_provider
      union all select auth_user_id from team_members where v_provider is not null and provider_id = v_provider
      union all select id from profiles where v_provider is not null and provider_account_code = v_provider
      union all select pr.id from profiles pr join staff_role_assignments s on lower(s.email) = lower(pr.email)
        where v_provider is not null and s.provider_account_code = v_provider
    ) x where u is not null
  );
  v_preserved := array(
    select distinct m.auth_user_id from hq_memberships m
    where m.auth_user_id = any(v_users) and m.status::text is distinct from 'revoked'
  );

  -- Sign-in identifiers (lower-cased emails, raw phones) for claim ledgers
  -- and second-factor rows; HQ members' own addresses stay untouched.
  v_identifiers := array(
    select distinct lower(i) from (
      select email as i from patients where id = any(v_pids)
        and (auth_user_id is null or not (auth_user_id = any(v_preserved)))
      union all select phone from patients where id = any(v_pids)
        and (auth_user_id is null or not (auth_user_id = any(v_preserved)))
      union all select email from providers where v_provider is not null and provider_id = v_provider
        and (auth_user_id is null or not (auth_user_id = any(v_preserved)))
      union all select phone from providers where v_provider is not null and provider_id = v_provider
        and (auth_user_id is null or not (auth_user_id = any(v_preserved)))
      union all select email from team_members where v_provider is not null and provider_id = v_provider
        and (auth_user_id is null or not (auth_user_id = any(v_preserved)))
      union all select email from auth.users where id = any(v_users) and not (id = any(v_preserved))
      union all select phone from auth.users where id = any(v_users) and not (id = any(v_preserved))
    ) x where i is not null and btrim(i) <> ''
  );

  -- ── Files ────────────────────────────────────────────────────────────────
  v_exports := array(
    select id from data_exports
    where (v_provider is not null and provider_id = v_provider)
       or params->>'patientId' = any(v_ptxt)
       or (requested_by = any(v_users) and not (requested_by = any(v_preserved)))
  );
  v_paths := array(
    select distinct p from (
      select object_path as p from patient_media where patient_id = any(v_pids)
      union all select photo_path from patient_custom_foods where patient_id = any(v_pids)
      union all select photo_path from patient_saved_recipes where patient_id = any(v_pids)
      union all select object_path from patient_progress_photos where patient_id = any(v_pids)
      union all select object_path from patient_data_exports where patient_id = any(v_pids)
      union all select object_path from patient_bloodwork_files where patient_id = any(v_pids)
      union all select staging_object_path from patient_bloodwork_files where patient_id = any(v_pids)
      union all select object_path from data_exports where id = any(v_exports)
    ) x where p is not null and p like '/objects/%'
  );

  -- ── Billing scope (both payment modes: no mode filter anywhere) ─────────
  v_orders := array(select id from billing_orders
    where patient_id = any(v_pids) or (v_provider is not null and provider_id = v_provider));
  v_subs := array(select id from billing_subscriptions
    where patient_id = any(v_pids) or (v_provider is not null and provider_id = v_provider));
  v_payers := array(select id from billing_payers
    where patient_id = any(v_pids) or (v_provider is not null and provider_id = v_provider));
  v_contacts := array(select id from billing_notification_contacts
    where payer_id = any(v_payers) or (v_provider is not null and provider_id = v_provider));
  if v_provider is not null then
    v_accounts := array(
      select distinct a from (
        select stripe_account_id as a from billing_connected_accounts where provider_id = v_provider
        union all select account_snapshot->>'stripe_account_id' from billing_connect_archive where provider_id = v_provider
      ) x where a is not null
    );
    v_customers := array(
      select distinct stripe_customer_id from billing_office_access_subscriptions
      where provider_id = v_provider and stripe_customer_id is not null
    );
  end if;
  with recursive tree as (
    select id, 0 as depth from billing_customer_emails
    where (v_provider is not null and provider_id = v_provider)
       or order_id = any(v_orders) or subscription_id = any(v_subs)
       or payer_id = any(v_payers) or contact_id = any(v_contacts)
    union
    select e.id, t.depth + 1 from billing_customer_emails e join tree t on e.parent_id = t.id
    where t.depth < 20
  )
  select coalesce(array_agg(id order by depth desc), '{}'::uuid[]) into v_emails
  from (select id, max(depth) as depth from tree group by id) d;

  -- Only this routine may pass the append-only and connection guards.
  perform set_config('app.audit_retention_run', 'on', true);
  perform set_config('thinnr.connect_mutation', 'allowed', true);
  alter table public.analytics_events disable trigger analytics_events_append_only;

  -- ── Rows without a patient/provider column, children first ──────────────
  delete from email_vendor_events
  where email_id = any(v_emails)
     or vendor_message_id in (
       select e.vendor_message_id from billing_customer_emails e
       where e.id = any(v_emails) and e.vendor_message_id is not null
     );
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('email_vendor_events', v_count);
  delete from billing_customer_email_events where email_id = any(v_emails);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_customer_email_events', v_count);
  update billing_customer_emails set parent_id = null where id = any(v_emails) and parent_id is not null;
  delete from billing_customer_emails where id = any(v_emails);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_customer_emails', v_count);
  delete from billing_refunds where order_id = any(v_orders);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_refunds', v_count);
  delete from billing_disputes where order_id = any(v_orders);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_disputes', v_count);
  delete from billing_ledger where order_id = any(v_orders) or subscription_id = any(v_subs);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_ledger_linked', v_count);
  delete from billing_shipments where order_id = any(v_orders);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_shipments_linked', v_count);
  delete from billing_notification_contacts where id = any(v_contacts);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_notification_contacts', v_count);
  if cardinality(v_accounts) > 0 or cardinality(v_customers) > 0 then
    delete from billing_webhook_events
    where account = any(v_accounts)
       or payload->'data'->'object'->>'customer' = any(v_customers)
       or payload->'data'->'object'->>'id' = any(v_customers);
    get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('billing_webhook_events', v_count);
  end if;

  -- Text-keyed references to the office, its patients, or its people.
  delete from admin_audit_events
  where target_id = any(v_ptxt)
     or metadata->>'patientId' = any(v_ptxt)
     or (v_provider is not null and (provider_id = v_provider or target_id = v_provider
         or target_id = any(v_team_ids) or metadata->>'providerId' = v_provider))
     or (actor_user_id = any(v_users) and not (actor_user_id = any(v_preserved)));
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('admin_audit_events', v_count);
  if v_provider is not null then
    delete from admin_audit_event_archives where provider_id = v_provider;
    get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('admin_audit_event_archives', v_count);
  end if;
  delete from admin_audit_read_windows
  where actor_user_id = any(v_users) and not (actor_user_id = any(v_preserved));
  delete from analytics_events
  where actor_user_id = any(v_users) and not (actor_user_id = any(v_preserved));
  delete from legal_holds
  where target_id = any(v_ptxt) or (v_provider is not null and target_id = v_provider);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('legal_holds', v_count);
  delete from patient_tombstones
  where id = any(v_pids) or (v_provider is not null and provider_id = v_provider);
  delete from private.patient_identity_reconciliation_audit
  where canonical_patient_id = any(v_pids) or archived_patient_id = any(v_pids);
  delete from claim_verifications
  where resolved_ref = any(v_ptxt)
     or (v_provider is not null and (resolved_ref = v_provider or resolved_ref = any(v_team_ids)))
     or (auth_user_id = any(v_users) and not (auth_user_id = any(v_preserved)))
     or lower(identifier) = any(v_identifiers);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('claim_verifications', v_count);
  delete from staff_second_factors
  where (v_provider is not null and (staff_ref = v_provider or staff_ref = any(v_team_ids)));
  delete from coach_conversations
  where patient_ref = any(v_ptxt) or (v_provider is not null and provider_account_code = v_provider);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('coach_conversations', v_count);
  delete from coach_usage_daily
  where scope = any(array(select 'account:' || t from unnest(v_ptxt) t));
  delete from coach_usage_leases
  where scope = any(array(select 'account:' || t from unnest(v_ptxt) t))
     or (v_provider is not null and office = v_provider);
  delete from storage_upload_intents
  where owner_id = any(v_ptxt)
     or object_path = any(v_paths)
     or exists (select 1 from unnest(v_ptxt) t
                where storage_upload_intents.object_path like '/objects/patient-media/' || t || '/%'
                   or storage_upload_intents.object_path like '/objects/patients/' || t || '/%');
  delete from auth_session_revocations
  where user_id = any(v_users) and not (user_id = any(v_preserved));
  delete from data_exports where id = any(v_exports);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('data_exports', v_count);
  if v_provider is not null then
    v_viewers := array(select id from training_viewers
      where account_id = any(v_accounts_keys)
         or (auth_user_id = any(v_users) and not (auth_user_id = any(v_preserved))));
    delete from training_viewers where staff_of_viewer_id = any(v_viewers);
    delete from training_viewers where id = any(v_viewers);
    get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('training_viewers', v_count);
    delete from provider_account_locks where account_id = any(v_accounts_keys);
    delete from role_assignments where provider_account_code = v_provider;
    delete from staff_role_assignments where provider_account_code = v_provider;
    get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('staff_role_assignments', v_count);
  end if;

  -- ── Every table with a patient_id, then (office) every provider_id ─────
  -- Retried in passes so FK order sorts itself out, like the purge.
  foreach v_col in array array['patient_id', 'provider_id'] loop
    continue when v_col = 'provider_id' and v_provider is null;
    v_pending := array(
      select c.table_name::text
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema
        and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name = v_col
        and c.table_name not in ('patients', 'providers')
      order by c.table_name
    );
    for v_pass in 1..8 loop
      v_blocked := '{}'::text[];
      foreach v_name in array v_pending loop
        select c.data_type into v_type from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = v_name and c.column_name = v_col;
        begin
          if v_col = 'patient_id' and v_type = 'uuid' then
            execute format('delete from public.%I where patient_id = any($1)', v_name) using v_pids;
          elsif v_col = 'patient_id' then
            execute format('delete from public.%I where patient_id::text = any($1)', v_name) using v_ptxt;
          else
            execute format('delete from public.%I where provider_id::text = $1', v_name) using v_provider;
          end if;
          get diagnostics v_count = row_count;
          if v_count > 0 then
            v_tables := v_tables || jsonb_build_object(v_name,
              coalesce((v_tables->>v_name)::bigint, 0) + v_count);
          end if;
        exception when foreign_key_violation or restrict_violation then
          v_blocked := v_blocked || v_name;
        end;
      end loop;
      exit when cardinality(v_blocked) = 0;
      if v_pass = 8 then
        raise exception 'hard delete blocked by foreign keys on %', array_to_string(v_blocked, ', ');
      end if;
      v_pending := v_blocked;
    end loop;
  end loop;

  alter table public.analytics_events enable trigger analytics_events_append_only;

  update patients set archived_into_patient_id = null where archived_into_patient_id = any(v_pids);
  delete from patients where id = any(v_pids);
  get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('patients', v_count);
  if v_provider is not null then
    delete from providers where provider_id = v_provider;
    get diagnostics v_count = row_count; v_tables := v_tables || jsonb_build_object('providers', v_count);
  end if;

  -- Preserved HQ members: re-apply their HQ profile (the office role
  -- assignment delete above demoted them) via the membership sync trigger.
  update hq_memberships set updated_at = now()
  where auth_user_id = any(v_preserved) and status::text is distinct from 'revoked';
  update profiles set provider_account_code = null
  where id = any(v_preserved) and provider_account_code = v_provider;

  -- Never delete a login still linked to anything that survives.
  v_delete_users := array(
    select u from unnest(v_users) u
    where not (u = any(v_preserved))
      and not exists (select 1 from providers where auth_user_id = u)
      and not exists (select 1 from team_members where auth_user_id = u)
      and not exists (select 1 from patients where auth_user_id = u)
      and not exists (select 1 from hq_memberships where auth_user_id = u)
  );

  return jsonb_build_object(
    'providerId', v_provider,
    'patientIds', to_jsonb(v_ptxt),
    'authUserIds', to_jsonb(v_delete_users),
    'preservedUserIds', to_jsonb(v_preserved),
    'objectPaths', to_jsonb(v_paths),
    'exportIds', to_jsonb(v_exports),
    'tables', v_tables
  );
end;
$$;
revoke all on function public.hq_testing_hard_delete(text, uuid) from public, anon, authenticated;
grant execute on function public.hq_testing_hard_delete(text, uuid) to service_role;
