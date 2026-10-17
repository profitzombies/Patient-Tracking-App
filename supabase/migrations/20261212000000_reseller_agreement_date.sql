-- Reseller agreement date: the anchor for a reseller office's included period.
--
-- Leadership expects a THINNR reseller's access billing to begin 12 months
-- (the organization's reseller included period) after the office signs its
-- reseller agreement. The agreement is signed off-platform, so HQ records the
-- date on the account; when it is set the included period runs from that day
-- instead of from the owner's first dashboard sign-in. Without a date the
-- clock still starts at the first sign-in. Software-only offices ignore it.
--
-- 1. providers.reseller_agreement_signed_on — nullable calendar date.
-- 2. The HQ create/update RPCs carry it. Create takes it as an optional
--    parameter; update takes the value plus a "set" flag so an older client
--    that sends nothing leaves the date alone while HQ can still clear it.
-- 3. billing_office_access_subscriptions.owner_first_sign_in_at — when the
--    owner first opened the dashboard, recorded once. Until now that instant
--    only lived in included_period_started_at, which the agreement date now
--    overwrites; keeping it separately is what lets HQ clear a wrongly entered
--    date and fall back to the real first sign-in. Backfilled from the access
--    history, where every sign-in-started period left an event.
--
-- Safe to re-run: add column if not exists, drop/create function, backfill
-- only where still null.

-- ---------------------------------------------------------------------------
-- 1. The agreement date
-- ---------------------------------------------------------------------------

alter table public.providers
  add column if not exists reseller_agreement_signed_on date;

comment on column public.providers.reseller_agreement_signed_on is
  'Day the office signed its THINNR reseller agreement, entered by HQ. When set, a reseller office''s included access period runs from this day (ends after the organization''s reseller included period) instead of from the owner''s first dashboard sign-in. Ignored for software-only offices.';

-- ---------------------------------------------------------------------------
-- 2. HQ account RPCs carry the date
-- ---------------------------------------------------------------------------

drop function if exists public.hq_create_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text
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
  p_office_kind text default 'reseller',
  p_reseller_agreement_signed_on date default null
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
        provider_role, plan, onboarding_code, access_disabled, office_kind,
        reseller_agreement_signed_on
      )
      values (
        'live-' || replace(gen_random_uuid()::text, '-', ''),
        trim(p_provider_name), trim(p_office_name), v_email, v_phone,
        trim(p_address_line_1), nullif(trim(p_address_line_2), ''),
        trim(p_city), v_state, v_postal_code,
        nullif(trim(p_provider_role), ''), p_plan, v_digits, false, v_office_kind,
        p_reseller_agreement_signed_on
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
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, date
) from public, anon, authenticated;
grant execute on function public.hq_create_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, date
) to service_role;

drop function if exists public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text
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
  p_office_kind text default null,
  p_reseller_agreement_signed_on date default null,
  p_set_reseller_agreement boolean default false
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
      office_kind = coalesce(v_office_kind, office_kind),
      -- Only an explicit "set" touches the date, so a form that does not know
      -- about it leaves it alone while HQ can still clear it with null + set.
      reseller_agreement_signed_on = case
        when p_set_reseller_agreement then p_reseller_agreement_signed_on
        else reseller_agreement_signed_on
      end
  where provider_id = p_provider_id
  returning * into v_provider;

  return v_provider;
end;
$$;

revoke all on function public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, date, boolean
) from public, anon, authenticated;
grant execute on function public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, text, date, boolean
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The owner's first sign-in, kept apart from the included period
-- ---------------------------------------------------------------------------

alter table public.billing_office_access_subscriptions
  add column if not exists owner_first_sign_in_at timestamptz;

comment on column public.billing_office_access_subscriptions.owner_first_sign_in_at is
  'When the office owner first opened the provider dashboard (recorded once). The included period falls back to this instant when no reseller agreement date is on the account.';

-- Every period the sign-in path started left an included_period_started event
-- by the provider actor; its first occurrence is the first sign-in.
update public.billing_office_access_subscriptions subscription
set owner_first_sign_in_at = started.at
from (
  select subscription_id, min(created_at) as at
  from public.billing_office_access_events
  where event = 'included_period_started'
    and actor_kind = 'provider'
  group by subscription_id
) started
where started.subscription_id = subscription.id
  and subscription.owner_first_sign_in_at is null;
