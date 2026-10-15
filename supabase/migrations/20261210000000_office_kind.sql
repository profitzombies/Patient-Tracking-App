-- Software-only provider accounts.
--
-- THINNR also sells the platform to practices that are not THINNR resellers.
-- Those "software" offices run the same app and the same setup wizard with
-- three differences: no Marketing Assets (HQ file drive) and no Training,
-- a different agreement in the setup wizard, and a shorter included period
-- (30 days from the owner's first sign-in instead of the reseller default).
--
-- 1. providers.office_kind — 'reseller' (default; every existing office) or
--    'software'. Independent of providers.plan (Core/Plus/Concierge), which
--    stays an HQ classification that controls nothing.
-- 2. The HQ create/update RPCs accept p_office_kind (create defaults to
--    reseller; update leaves the kind alone when null).
-- 3. HQ organization settings gain the software agreement text and the
--    software included-period default (30 days, same bounds as the reseller
--    value).
-- 4. billing_office_access_subscriptions.disclosure_kind records WHICH
--    agreement the office accepted alongside the settings version.
-- 5. Training fails closed for software-office staff at the database layer
--    that already scopes training to the caller's office: the catalog read
--    policies, private.caller_provider_account() (office roster/progress
--    reads) and private.caller_is_staff() (own-row reads + self completion).
--    HQ admins and anonymous learner-preview reads are unchanged.
--
-- Safe to re-run: add column if not exists, create or replace, drop/create
-- policies.

-- ---------------------------------------------------------------------------
-- 1. Office kind
-- ---------------------------------------------------------------------------

alter table public.providers
  add column if not exists office_kind text not null default 'reseller';

alter table public.providers
  drop constraint if exists providers_office_kind_check;
alter table public.providers
  add constraint providers_office_kind_check
  check (office_kind in ('reseller', 'software'));

comment on column public.providers.office_kind is
  'reseller = THINNR reseller office (default); software = software-only practice: no Marketing Assets or Training, software agreement, shorter included period.';

-- ---------------------------------------------------------------------------
-- 2. HQ account RPCs carry the kind
-- ---------------------------------------------------------------------------

drop function if exists public.hq_create_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text
);

create or replace function public.hq_create_provider_account(
  p_created_by uuid,
  p_office_name text,
  p_provider_name text,
  p_provider_role text,
  p_email text,
  p_phone text,
  p_address_line_1 text,
  p_address_line_2 text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_plan text,
  p_office_kind text default 'reseller'
)
returns public.providers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider public.providers%rowtype;
  v_digits text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_state text := upper(trim(coalesce(p_state, '')));
  v_postal_code text := upper(trim(coalesce(p_postal_code, '')));
  v_office_kind text := coalesce(nullif(trim(p_office_kind), ''), 'reseller');
  v_phone text;
begin
  if not (
    exists (
      select 1
      from public.hq_memberships
      where auth_user_id = p_created_by
        and status = 'active'
        and department_role in ('super_admin', 'admin')
    )
    or (
      not exists (
        select 1 from public.hq_memberships where auth_user_id = p_created_by
      )
      and exists (
        select 1
        from public.profiles
        where id = p_created_by and role = 'hq_admin'::public.app_role
      )
    )
  ) then
    raise exception 'Only active HQ administrators can create provider accounts.';
  end if;

  if trim(coalesce(p_office_name, '')) = '' or trim(coalesce(p_provider_name, '')) = '' then
    raise exception 'Office and provider names are required.';
  end if;
  if trim(coalesce(p_address_line_1, '')) = '' or trim(coalesce(p_city, '')) = '' then
    raise exception 'Address 1 and city are required.';
  end if;
  if v_state !~ '^[A-Z]{2}$' then
    raise exception 'Choose a valid US state.';
  end if;
  if v_postal_code !~ '^[0-9]{5}(-[0-9]{4})?$' then
    raise exception 'Enter a valid ZIP code.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid provider email address.';
  end if;
  if p_plan is not null and p_plan not in ('Core', 'Plus', 'Concierge') then
    raise exception 'Choose a valid plan.';
  end if;
  if v_office_kind not in ('reseller', 'software') then
    raise exception 'Choose a valid office type.';
  end if;
  if length(v_phone_digits) = 11 and left(v_phone_digits, 1) = '1' then
    v_phone_digits := right(v_phone_digits, 10);
  end if;
  if length(v_phone_digits) <> 10 then
    raise exception 'Enter a valid 10-digit US office phone number.';
  end if;
  v_phone := '(' || substring(v_phone_digits from 1 for 3) || ') ' ||
    substring(v_phone_digits from 4 for 3) || '-' || substring(v_phone_digits from 7 for 4);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-email:' || v_email, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-phone:' || v_phone_digits, 0)
  );

  if exists (
    select 1
    from public.providers
    where lower(coalesce(email, '')) = v_email
       or right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_phone_digits
  ) then
    raise exception 'A provider with that contact already exists.';
  end if;
  if exists (
    select 1 from public.team_members where lower(coalesce(email, '')) = v_email
  ) then
    raise exception 'A staff member with that email already exists.';
  end if;
  if exists (
    select 1
    from auth.users
    where lower(coalesce(email, '')) = v_email
       or right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_phone_digits
  ) then
    raise exception 'That contact already has a login.';
  end if;

  loop
    v_digits := lpad((floor(random() * 1000000))::text, 6, '0');
    begin
      insert into public.providers (
        provider_id, provider_name, office_name, email, phone,
        address_line_1, address_line_2, city, state, postal_code,
        provider_role, plan, onboarding_code, access_disabled, office_kind
      )
      values (
        'live-' || replace(gen_random_uuid()::text, '-', ''),
        trim(p_provider_name), trim(p_office_name), v_email, v_phone,
        trim(p_address_line_1), nullif(trim(p_address_line_2), ''),
        trim(p_city), v_state, v_postal_code,
        nullif(trim(p_provider_role), ''), p_plan, v_digits, false, v_office_kind
      )
      returning * into v_provider;
      exit;
    exception when unique_violation then
      if not exists (
        select 1 from public.providers where onboarding_code = v_digits
      ) then
        raise;
      end if;
    end;
  end loop;

  return v_provider;
end;
$$;

revoke all on function public.hq_create_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.hq_create_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

drop function if exists public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text
);

create or replace function public.hq_update_provider_account(
  p_updated_by uuid,
  p_provider_id text,
  p_office_name text,
  p_provider_name text,
  p_provider_role text,
  p_email text,
  p_phone text,
  p_address_line_1 text,
  p_address_line_2 text,
  p_city text,
  p_state text,
  p_postal_code text,
  p_plan text,
  p_office_kind text default null
)
returns public.providers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider public.providers%rowtype;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_state text := upper(trim(coalesce(p_state, '')));
  v_postal_code text := upper(trim(coalesce(p_postal_code, '')));
  v_office_kind text := nullif(trim(coalesce(p_office_kind, '')), '');
  v_phone text;
begin
  if not (
    exists (
      select 1
      from public.hq_memberships
      where auth_user_id = p_updated_by
        and status = 'active'
        and department_role in ('super_admin', 'admin')
    )
    or (
      not exists (
        select 1 from public.hq_memberships where auth_user_id = p_updated_by
      )
      and exists (
        select 1
        from public.profiles
        where id = p_updated_by and role = 'hq_admin'::public.app_role
      )
    )
  ) then
    raise exception 'Only active HQ administrators can update provider accounts.';
  end if;

  select *
  into v_provider
  from public.providers
  where provider_id = p_provider_id
  for update;
  if not found then
    raise exception 'Provider account not found.';
  end if;

  if trim(coalesce(p_office_name, '')) = '' or trim(coalesce(p_provider_name, '')) = '' then
    raise exception 'Office and provider names are required.';
  end if;
  if trim(coalesce(p_address_line_1, '')) = '' or trim(coalesce(p_city, '')) = '' then
    raise exception 'Address 1 and city are required.';
  end if;
  if v_state !~ '^[A-Z]{2}$' then
    raise exception 'Choose a valid US state.';
  end if;
  if v_postal_code !~ '^[0-9]{5}(-[0-9]{4})?$' then
    raise exception 'Enter a valid ZIP code.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid provider email address.';
  end if;
  if p_plan is not null and p_plan not in ('Core', 'Plus', 'Concierge') then
    raise exception 'Choose a valid plan.';
  end if;
  if v_office_kind is not null and v_office_kind not in ('reseller', 'software') then
    raise exception 'Choose a valid office type.';
  end if;
  if length(v_phone_digits) = 11 and left(v_phone_digits, 1) = '1' then
    v_phone_digits := right(v_phone_digits, 10);
  end if;
  if length(v_phone_digits) <> 10 then
    raise exception 'Enter a valid 10-digit US office phone number.';
  end if;
  v_phone := '(' || substring(v_phone_digits from 1 for 3) || ') ' ||
    substring(v_phone_digits from 4 for 3) || '-' || substring(v_phone_digits from 7 for 4);

  if exists (
    select 1
    from public.providers
    where provider_id <> p_provider_id
      and (
        lower(coalesce(email, '')) = v_email
        or right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_phone_digits
      )
  ) then
    raise exception 'A provider with that contact already exists.';
  end if;
  if exists (
    select 1
    from public.team_members
    where lower(coalesce(email, '')) = v_email
      and provider_id <> p_provider_id
  ) then
    raise exception 'A staff member with that email already exists.';
  end if;
  if exists (
    select 1
    from auth.users
    where id is distinct from v_provider.auth_user_id
      and (
        lower(coalesce(email, '')) = v_email
        or right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = v_phone_digits
      )
  ) then
    raise exception 'That contact already has a login.';
  end if;

  update public.providers
  set office_name = trim(p_office_name),
      provider_name = trim(p_provider_name),
      provider_role = nullif(trim(p_provider_role), ''),
      email = v_email,
      phone = v_phone,
      address_line_1 = trim(p_address_line_1),
      address_line_2 = nullif(trim(p_address_line_2), ''),
      city = trim(p_city),
      state = v_state,
      postal_code = v_postal_code,
      plan = p_plan,
      office_kind = coalesce(v_office_kind, office_kind)
  where provider_id = p_provider_id
  returning * into v_provider;

  return v_provider;
end;
$$;

revoke all on function public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Organization settings: software agreement + software included period
-- ---------------------------------------------------------------------------

alter table public.hq_organization_settings
  add column if not exists access_software_agreement_text text not null default
    'THINNR provides your practice with the provider dashboard, the provider mobile app and the patient app under this software agreement, and charges your practice an access fee for them. '
    'We keep a bank account and two credit cards on file and charge the bank account first; if it fails we try your cards. '
    'Your included period is free — the first access charge lands the day it ends, at the price shown above. '
    'If an access payment lapses and stays unpaid through the recovery window, your practice keeps operating but THINNR''s share of each patient payment increases until the balance is settled. '
    'You can change cards, re-verify your bank account, or pay a balance at any time from Payment methods. '
    'THINNR marketing assets and reseller training are not part of this agreement.';

alter table public.hq_organization_settings
  add column if not exists access_software_included_period_days integer not null default 30;

alter table public.hq_organization_settings
  drop constraint if exists hq_organization_settings_access_software_included_period_days_check;
alter table public.hq_organization_settings
  add constraint hq_organization_settings_access_software_included_period_days_check
  check (access_software_included_period_days >= 0 and access_software_included_period_days <= 1095);

comment on column public.hq_organization_settings.access_software_agreement_text is
  'HQ-owned wording of the access-fee terms a software-only office accepts in setup (resellers accept access_disclosure_text).';
comment on column public.hq_organization_settings.access_software_included_period_days is
  'Days of free access a software-only office gets from the owner''s first dashboard sign-in (resellers use access_included_period_days).';

-- ---------------------------------------------------------------------------
-- 4. Which agreement an office accepted
-- ---------------------------------------------------------------------------

alter table public.billing_office_access_subscriptions
  add column if not exists disclosure_kind text;

alter table public.billing_office_access_subscriptions
  drop constraint if exists billing_office_access_subscriptions_disclosure_kind_check;
alter table public.billing_office_access_subscriptions
  add constraint billing_office_access_subscriptions_disclosure_kind_check
  check (disclosure_kind is null or disclosure_kind in ('reseller', 'software'));

comment on column public.billing_office_access_subscriptions.disclosure_kind is
  'Which agreement the office accepted: reseller (access disclosure) or software (software agreement). Null for acknowledgments recorded before office kinds existed (all resellers).';

-- ---------------------------------------------------------------------------
-- 5. Training fails closed for software-office staff
-- ---------------------------------------------------------------------------

-- Is the signed-in user the owner or a staff member of a software-only office?
-- False for HQ admins, patients, anon and every reseller office.
create or replace function private.caller_office_is_software()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.providers office
    where office.office_kind = 'software'
      and (
        office.auth_user_id = (select auth.uid())
        or office.provider_id = (
          select profile.provider_account_code
          from public.profiles profile
          where profile.id = (select auth.uid())
        )
        or exists (
          select 1
          from public.team_members tm
          where tm.auth_user_id = (select auth.uid())
            and tm.provider_id = office.provider_id
        )
      )
  );
$$;

revoke all on function private.caller_office_is_software() from public;
grant execute on function private.caller_office_is_software() to authenticated;

-- Office roster/progress reads: a software office is never "the caller's
-- office" for training (full replacement of the 20260927 version; only the
-- kind check is new).
create or replace function private.caller_provider_account()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select profile.provider_account_code
  from public.profiles profile
  where profile.id = (select auth.uid())
    and profile.role = 'provider_staff'::public.app_role
    and not exists (
      select 1 from public.team_members tm
      where tm.auth_user_id = profile.id
        and tm.activation_status = 'disabled'
    )
    and not private.caller_office_is_software();
$$;

revoke all on function private.caller_provider_account() from public;
grant execute on function private.caller_provider_account() to authenticated;

-- Own-row reads + self completion (full replacement of the 20260829 version;
-- HQ admins unchanged, software-office staff now false).
create or replace function private.caller_is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and (
        profile.role = 'hq_admin'::public.app_role
        or (
          profile.role = 'provider_staff'::public.app_role
          and (
            profile.provider_account_code is null
            or not private.provider_account_is_locked(profile.provider_account_code)
          )
          and not private.caller_office_is_software()
        )
      )
  );
$$;

revoke all on function private.caller_is_staff() from public;
grant execute on function private.caller_is_staff() to authenticated;

-- Catalog reads stay open to everyone else (learner preview, HQ, resellers);
-- software-office staff get an empty catalog. Anonymous readers keep their own
-- policy so the anon role never needs the private schema.
drop policy if exists "Training courses are readable by everyone" on public.training_courses;
create policy "Training courses are readable by everyone"
  on public.training_courses for select to anon using (true);
drop policy if exists "Training courses are readable outside software offices" on public.training_courses;
create policy "Training courses are readable outside software offices"
  on public.training_courses for select to authenticated
  using (not private.caller_office_is_software());

drop policy if exists "Training modules are readable by everyone" on public.training_modules;
create policy "Training modules are readable by everyone"
  on public.training_modules for select to anon using (true);
drop policy if exists "Training modules are readable outside software offices" on public.training_modules;
create policy "Training modules are readable outside software offices"
  on public.training_modules for select to authenticated
  using (not private.caller_office_is_software());

drop policy if exists "Training subgroups are readable by everyone" on public.training_subgroups;
create policy "Training subgroups are readable by everyone"
  on public.training_subgroups for select to anon using (true);
drop policy if exists "Training subgroups are readable outside software offices" on public.training_subgroups;
create policy "Training subgroups are readable outside software offices"
  on public.training_subgroups for select to authenticated
  using (not private.caller_office_is_software());

drop policy if exists "Training videos are readable by everyone" on public.training_videos;
create policy "Training videos are readable by everyone"
  on public.training_videos for select to anon using (true);
drop policy if exists "Training videos are readable outside software offices" on public.training_videos;
create policy "Training videos are readable outside software offices"
  on public.training_videos for select to authenticated
  using (not private.caller_office_is_software());
