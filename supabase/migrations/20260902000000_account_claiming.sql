-- THINNR account claiming: link columns, claim-code ledger, trigger guards,
-- lookup RPC, and the RLS access matrix for the 26 migrated production tables.
--
-- Ground rules (from the build spec):
--   * The ONLY writes to migrated tables are adding auth_user_id + claimed_at
--     and setting those two values when an account is claimed.
--   * No anonymous access to any migrated table, ever.
--   * Demo tables and their policies are untouched.
--   * Claimed logins must not create demo rows (profiles, role_assignments,
--     training_viewers) — except a pre-approved HQ admin, which is exactly
--     how the real admin login is wired to the admin role.

-- @chunk link-columns ---------------------------------------------------------

alter table public.patients
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists claimed_at timestamptz;

alter table public.providers
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists claimed_at timestamptz;

alter table public.team_members
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists claimed_at timestamptz;

-- One auth user links at most one row per table, and the RLS helpers look up
-- rows by auth_user_id, so these uniques double as the lookup indexes.
create unique index if not exists patients_auth_user_id_key on public.patients (auth_user_id);
create unique index if not exists providers_auth_user_id_key on public.providers (auth_user_id);
create unique index if not exists team_members_auth_user_id_key on public.team_members (auth_user_id);

-- @chunk claim-ledger ---------------------------------------------------------

-- Server-side ledger for claim verification codes. Service-role only: RLS is
-- enabled with zero policies and every client grant is revoked, so neither
-- anon nor signed-in users can read codes, attempts, or identifiers.
create table if not exists public.claim_verifications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  purpose text not null default 'claim' check (purpose in ('claim', 'add_phone')),
  identifier_kind text not null check (identifier_kind in ('phone', 'email')),
  identifier text not null,
  account_type text check (account_type in ('patient', 'provider', 'team_member', 'hq_admin')),
  candidates jsonb not null default '[]'::jsonb,
  resolved_ref text,
  delivery text not null check (delivery in ('dev', 'twilio_verify', 'resend')),
  code_salt text,
  code_hash text,
  code_expires_at timestamptz,
  code_attempts integer not null default 0,
  verified_at timestamptz,
  claim_token_hash text,
  birthday_checked boolean not null default false,
  consumed_at timestamptz,
  auth_user_id uuid
);

alter table public.claim_verifications enable row level security;
revoke all on public.claim_verifications from anon, authenticated;

create index if not exists claim_verifications_identifier_idx
  on public.claim_verifications (identifier, created_at desc);
create index if not exists claim_verifications_token_idx
  on public.claim_verifications (claim_token_hash)
  where claim_token_hash is not null;

-- @chunk lookup-rpc -----------------------------------------------------------

-- Candidate lookup used by the claim API (service role only). Matching rules:
--   * email — providers, team members, and patients, case-insensitive.
--   * phone — patients only (staff claim with their work email); matches on
--     the last 10 digits so stored formatting never matters.
--   * disabled records never match: patients.activation_status = 'disabled',
--     team_members.activation_status = 'disabled', providers.access_disabled.
create or replace function public.claim_find_candidates(p_kind text, p_value text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
  from (
    select 'provider' as type,
           pr.provider_id as ref,
           coalesce(nullif(pr.provider_name, ''), pr.office_name) as name,
           pr.email,
           null::text as phone,
           null::date as dob,
           (pr.auth_user_id is not null) as claimed,
           pr.auth_user_id
    from public.providers pr
    where p_kind = 'email'
      and pr.email is not null
      and lower(pr.email) = lower(p_value)
      and coalesce(pr.access_disabled, false) = false
    union all
    select 'team_member',
           tm.id::text,
           tm.name,
           tm.email,
           null::text,
           null::date,
           (tm.auth_user_id is not null),
           tm.auth_user_id
    from public.team_members tm
    where p_kind = 'email'
      and tm.email is not null
      and lower(tm.email) = lower(p_value)
      and coalesce(tm.activation_status, '') <> 'disabled'
    union all
    select 'patient',
           pa.id::text,
           pa.name,
           pa.email,
           pa.phone,
           pa.date_of_birth,
           (pa.auth_user_id is not null),
           pa.auth_user_id
    from public.patients pa
    where coalesce(pa.activation_status, '') <> 'disabled'
      and (
        (p_kind = 'email' and pa.email is not null and lower(pa.email) = lower(p_value))
        or (
          p_kind = 'phone'
          and pa.phone is not null
          and right(regexp_replace(pa.phone, '\D', '', 'g'), 10)
              = right(regexp_replace(p_value, '\D', '', 'g'), 10)
          and length(regexp_replace(pa.phone, '\D', '', 'g')) >= 10
        )
      )
  ) c;
$$;

revoke all on function public.claim_find_candidates(text, text) from public, anon, authenticated;

-- @chunk trigger-guards -------------------------------------------------------

-- Claim-created auth users carry app_metadata.thinnr_claim (server-set only;
-- clients cannot write app_metadata). Both signup triggers skip ALL demo
-- provisioning for them — no profiles row, no role assignment, no training
-- viewer — with one exception: an email pre-approved as hq_admin still routes,
-- which is how the real HQ admin login gets the admin role.
--
-- TIMING: GoTrue's admin create inserts the auth.users row first and merges
-- app_metadata in a later statement of the same transaction, so a plain AFTER
-- INSERT trigger fires before the markers exist on the row. Both provisioning
-- triggers are therefore DEFERRABLE INITIALLY DEFERRED constraint triggers:
-- they run at commit and re-read the row, seeing the final metadata. The
-- re-read also makes create-then-rollback flows safe — a user created and
-- deleted in one transaction provisions nothing.
--
-- Elevation tightening that ships with autoconfirmed email (confirmations are
-- off for the claim flow): a bare signup no longer proves mailbox ownership,
-- so role elevation additionally requires app_metadata.thinnr_provisioned —
-- set only by the server-side staff provisioning path and admin setup. This
-- applies to BOTH assignment tables (role_assignments predates
-- staff_role_assignments and gets the same guard).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  u auth.users%rowtype;
  assigned public.role_assignments%rowtype;
  resolved_role public.app_role := 'patient';
  resolved_account text := null;
begin
  -- Deferred to commit time: re-read the row for its final state.
  select * into u from auth.users where id = new.id;
  if not found then
    return new; -- created and deleted within the same transaction
  end if;

  -- Claimed real-data accounts never join the demo tables.
  if coalesce(u.raw_app_meta_data ->> 'thinnr_claim', '') <> '' then
    return new;
  end if;

  select ra.* into assigned
  from public.role_assignments ra
  where (u.email is not null and ra.email is not null and lower(ra.email) = lower(u.email))
     or (u.phone is not null and ra.phone is not null and ra.phone = u.phone)
  order by case
    when u.email is not null and ra.email is not null and lower(ra.email) = lower(u.email) then 0
    else 1
  end
  limit 1;

  -- Pre-approved contact details elevate only server-provisioned accounts.
  if found and coalesce(u.raw_app_meta_data ->> 'thinnr_provisioned', '') = 'true' then
    resolved_role := assigned.role;
    resolved_account := assigned.provider_account_code;
  end if;

  insert into public.profiles (id, role, display_name, email, phone, provider_account_code)
  values (
    u.id,
    resolved_role,
    coalesce(
      nullif(u.raw_user_meta_data ->> 'display_name', ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), '')
    ),
    u.email,
    u.phone,
    resolved_account
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.handle_new_thinnr_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  u auth.users%rowtype;
  assignment public.staff_role_assignments%rowtype;
  v_approved boolean;
  v_provisioned boolean;
begin
  -- Deferred to commit time: re-read the row for its final state.
  select * into u from auth.users where id = new.id;
  if not found then
    return new; -- created and deleted within the same transaction
  end if;

  -- Claimed real-data accounts skip demo provisioning entirely, unless the
  -- email is pre-approved as an HQ admin (that is the real admin login).
  if coalesce(u.raw_app_meta_data ->> 'thinnr_claim', '') <> '' and not exists (
    select 1
    from public.staff_role_assignments a
    where lower(a.email) = lower(coalesce(u.email, ''))
      and a.role = 'hq_admin'::public.app_role
  ) then
    return new;
  end if;

  insert into public.profiles (id, role, display_name, email, phone)
  values (
    u.id,
    'patient'::public.app_role,
    nullif(coalesce(u.raw_user_meta_data ->> 'display_name', ''), ''),
    u.email,
    u.phone
  )
  on conflict (id) do update
    set display_name = coalesce(excluded.display_name, public.profiles.display_name),
        email = excluded.email,
        phone = excluded.phone;

  -- Role elevation requires a database pre-approval AND a server-provisioned
  -- account. With email autoconfirm on, email_confirmed_at alone no longer
  -- proves mailbox ownership, so a bare signup claim can never elevate.
  select *
  into assignment
  from public.staff_role_assignments
  where lower(email) = lower(coalesce(u.email, ''));
  v_approved := found;
  v_provisioned := coalesce(u.raw_app_meta_data ->> 'thinnr_provisioned', '') = 'true'
    or coalesce(u.raw_app_meta_data ->> 'thinnr_claim', '') <> '';

  update public.profiles
  set role = case
        when v_approved and v_provisioned and u.email_confirmed_at is not null then assignment.role
        else 'patient'::public.app_role
      end,
      provider_account_code = case
        when v_approved and v_provisioned and u.email_confirmed_at is not null then assignment.provider_account_code
        else null
      end
  where id = u.id;

  -- A confirmed provider staffer gets (or claims) their training viewer row.
  if v_approved
    and v_provisioned
    and u.email_confirmed_at is not null
    and assignment.role = 'provider_staff'::public.app_role
  then
    perform private.link_staff_training_viewer(
      u.id,
      u.email,
      nullif(coalesce(u.raw_user_meta_data ->> 'display_name', ''), ''),
      assignment.provider_account_code
    );
  end if;

  return new;
end;
$$;

-- Recreate both provisioning triggers as deferred constraint triggers so they
-- observe commit-time row state (see TIMING note above).
drop trigger if exists on_auth_user_created on auth.users;
create constraint trigger on_auth_user_created
  after insert on auth.users
  deferrable initially deferred
  for each row
  execute function public.handle_new_user();

drop trigger if exists on_auth_user_created_thinnr on auth.users;
create constraint trigger on_auth_user_created_thinnr
  after insert or update of email, email_confirmed_at on auth.users
  deferrable initially deferred
  for each row
  execute function public.handle_new_thinnr_user();

-- Assignment-sync elevation gets the same tightening: only server-provisioned
-- accounts can be elevated after the fact.
create or replace function public.sync_staff_role_assignment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update public.profiles
    set role = 'patient'::public.app_role,
        provider_account_code = null
    where lower(email) = lower(old.email);
  end if;

  if tg_op <> 'DELETE' then
    update public.profiles profile
    set role = new.role,
        provider_account_code = new.provider_account_code
    from auth.users user_record
    where profile.id = user_record.id
      and lower(user_record.email) = lower(new.email)
      and user_record.email_confirmed_at is not null
      and coalesce(user_record.raw_app_meta_data ->> 'thinnr_provisioned', '') = 'true';
    return new;
  end if;

  return old;
end;
$$;

-- @chunk rls-helpers ----------------------------------------------------------

-- Non-recursive, fixed-search-path scope helpers (same pattern as
-- private.is_hq_admin from the profiles migration).
create or replace function private.claimed_patient_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id
  from public.patients
  where auth_user_id = (select auth.uid())
  limit 1;
$$;

create or replace function private.claimed_provider_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select provider_id from public.providers where auth_user_id = (select auth.uid()) limit 1),
    (select provider_id from public.team_members where auth_user_id = (select auth.uid()) limit 1)
  );
$$;

revoke all on function private.claimed_patient_id() from public;
revoke all on function private.claimed_provider_id() from public;
grant execute on function private.claimed_patient_id() to authenticated;
grant execute on function private.claimed_provider_id() to authenticated;

-- @chunk grants ---------------------------------------------------------------

-- Client-role grants on migrated tables were wide open (full CRUD for anon and
-- authenticated, held back only by policy-less RLS). Trim to the real matrix:
-- anon gets nothing; authenticated gets SELECT (rows still gated by the
-- policies below) plus a column-limited UPDATE on patients.
do $$
declare
  t text;
begin
  foreach t in array array[
    'app_subscriptions', 'approved_foods', 'chatbot_messages', 'craving_foods',
    'craving_foods_flagged', 'custom_foods', 'custom_recipes', 'customers',
    'global_onboard_daily', 'ingredient_macros', 'patient_feedback',
    'patient_log_flags', 'patient_logs', 'patient_measurements',
    'patient_messages', 'patients', 'possible_free_foods',
    'product_subscriptions', 'provider_measurements', 'provider_referrals',
    'providers', 'team_members', 'tech_support_messages', 'transactions',
    'user_metrics', 'users_onboarded_daily'
  ]
  loop
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end
$$;

-- Patients may edit their own preferences; identity, linkage, billing, and
-- clinical columns stay server-managed.
grant update (
  timezone, saved_diet_prefs, is_gluten_free, is_vegetarian, is_vegan,
  lunch_time, dinner_time, reminder_one, reminder_two, reminder_three,
  goal_weight
) on public.patients to authenticated;

-- @chunk policies-core --------------------------------------------------------

-- patients: own row (read + limited update), staff of the same provider, admin.
drop policy if exists "Patients read their own record" on public.patients;
create policy "Patients read their own record"
  on public.patients for select to authenticated
  using (auth_user_id = (select auth.uid()));

drop policy if exists "Patients update their own preferences" on public.patients;
create policy "Patients update their own preferences"
  on public.patients for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

drop policy if exists "Provider staff read their patients" on public.patients;
create policy "Provider staff read their patients"
  on public.patients for select to authenticated
  using (provider_id = (select private.claimed_provider_id()));

drop policy if exists "HQ admins read all patients" on public.patients;
create policy "HQ admins read all patients"
  on public.patients for select to authenticated
  using ((select private.is_hq_admin()));

-- providers: own row, staff of the same provider, admin.
drop policy if exists "Providers read their own record" on public.providers;
create policy "Providers read their own record"
  on public.providers for select to authenticated
  using (auth_user_id = (select auth.uid()));

drop policy if exists "Provider staff read their provider" on public.providers;
create policy "Provider staff read their provider"
  on public.providers for select to authenticated
  using (provider_id = (select private.claimed_provider_id()));

drop policy if exists "HQ admins read all providers" on public.providers;
create policy "HQ admins read all providers"
  on public.providers for select to authenticated
  using ((select private.is_hq_admin()));

-- team_members: own row, same-provider colleagues (roster), admin.
drop policy if exists "Team members read their own record" on public.team_members;
create policy "Team members read their own record"
  on public.team_members for select to authenticated
  using (auth_user_id = (select auth.uid()));

drop policy if exists "Provider staff read their roster" on public.team_members;
create policy "Provider staff read their roster"
  on public.team_members for select to authenticated
  using (provider_id = (select private.claimed_provider_id()));

drop policy if exists "HQ admins read all team members" on public.team_members;
create policy "HQ admins read all team members"
  on public.team_members for select to authenticated
  using ((select private.is_hq_admin()));

-- @chunk policies-patient-data ------------------------------------------------

-- Patient-owned data: the patient, their provider's staff, and admins.
do $$
declare
  t text;
begin
  foreach t in array array[
    'patient_logs', 'patient_log_flags', 'patient_measurements',
    'patient_messages', 'chatbot_messages', 'tech_support_messages',
    'patient_feedback', 'custom_foods', 'custom_recipes'
  ]
  loop
    execute format('drop policy if exists "Patients read their own rows" on public.%I', t);
    execute format(
      'create policy "Patients read their own rows" on public.%I for select to authenticated using (patient_id = (select private.claimed_patient_id()))',
      t
    );
    execute format('drop policy if exists "Provider staff read their patients'' rows" on public.%I', t);
    execute format(
      'create policy "Provider staff read their patients'' rows" on public.%I for select to authenticated using (provider_id = (select private.claimed_provider_id()))',
      t
    );
    execute format('drop policy if exists "HQ admins read all rows" on public.%I', t);
    execute format(
      'create policy "HQ admins read all rows" on public.%I for select to authenticated using ((select private.is_hq_admin()))',
      t
    );
  end loop;
end
$$;

-- @chunk policies-financial ---------------------------------------------------

-- Financial and billing data: provider staff (their own provider) and admins.
-- Patients do not read billing tables directly. Orphaned rows (their patient
-- was deleted upstream) still carry provider_id, so the right office and
-- admins can see them and nobody else can.
do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'app_subscriptions', 'product_subscriptions', 'customers']
  loop
    execute format('drop policy if exists "Provider staff read their billing rows" on public.%I', t);
    execute format(
      'create policy "Provider staff read their billing rows" on public.%I for select to authenticated using (provider_id = (select private.claimed_provider_id()))',
      t
    );
    execute format('drop policy if exists "HQ admins read all billing rows" on public.%I', t);
    execute format(
      'create policy "HQ admins read all billing rows" on public.%I for select to authenticated using ((select private.is_hq_admin()))',
      t
    );
  end loop;
end
$$;

-- @chunk policies-provider-and-reference ----------------------------------------

-- Provider-scoped business data.
do $$
declare
  t text;
begin
  foreach t in array array['provider_referrals', 'provider_measurements', 'users_onboarded_daily']
  loop
    execute format('drop policy if exists "Provider staff read their business rows" on public.%I', t);
    execute format(
      'create policy "Provider staff read their business rows" on public.%I for select to authenticated using (provider_id = (select private.claimed_provider_id()))',
      t
    );
    execute format('drop policy if exists "HQ admins read all business rows" on public.%I', t);
    execute format(
      'create policy "HQ admins read all business rows" on public.%I for select to authenticated using ((select private.is_hq_admin()))',
      t
    );
  end loop;
end
$$;

-- Global aggregates: any claimed provider/staff account plus admins.
drop policy if exists "Staff read global onboarding aggregates" on public.global_onboard_daily;
create policy "Staff read global onboarding aggregates"
  on public.global_onboard_daily for select to authenticated
  using ((select private.claimed_provider_id()) is not null or (select private.is_hq_admin()));

-- user_metrics: person_id does not join to patients.id in the migrated data
-- (verified against a 20k-row sample), so per-patient or per-provider scoping
-- is impossible today. Admin-only until the identifier mapping is clarified.
drop policy if exists "HQ admins read user metrics" on public.user_metrics;
create policy "HQ admins read user metrics"
  on public.user_metrics for select to authenticated
  using ((select private.is_hq_admin()));

-- Reference/program tables: readable by any signed-in account, never anon.
do $$
declare
  t text;
begin
  foreach t in array array[
    'approved_foods', 'craving_foods', 'craving_foods_flagged',
    'ingredient_macros', 'possible_free_foods'
  ]
  loop
    execute format('drop policy if exists "Signed-in accounts read reference data" on public.%I', t);
    execute format(
      'create policy "Signed-in accounts read reference data" on public.%I for select to authenticated using (true)',
      t
    );
  end loop;
end
$$;
