-- Complete provider-office contact details and membership-aware HQ writes.

alter table public.providers
  add column if not exists address_line_1 text,
  add column if not exists address_line_2 text,
  add column if not exists postal_code text;

comment on column public.providers.address_line_1 is
  'Primary US business street address. Required for provider accounts created after this migration.';
comment on column public.providers.address_line_2 is
  'Optional suite, unit, floor, or other secondary business address.';
comment on column public.providers.postal_code is
  'US five-digit or ZIP+4 postal code. Required for provider accounts created after this migration.';

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
  p_plan text
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
        provider_role, plan, onboarding_code, access_disabled
      )
      values (
        'live-' || replace(gen_random_uuid()::text, '-', ''),
        trim(p_provider_name), trim(p_office_name), v_email, v_phone,
        trim(p_address_line_1), nullif(trim(p_address_line_2), ''),
        trim(p_city), v_state, v_postal_code,
        nullif(trim(p_provider_role), ''), p_plan, v_digits, false
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
  uuid, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.hq_create_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text
) to service_role;

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
  p_plan text
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
      plan = p_plan
  where provider_id = p_provider_id
  returning * into v_provider;

  return v_provider;
end;
$$;

revoke all on function public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.hq_update_provider_account(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text
) to service_role;