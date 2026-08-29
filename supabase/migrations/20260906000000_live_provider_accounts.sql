-- Live provider accounts.
--
-- A provider row is the canonical account row. Existing migrated providers are
-- deliberately left unclaimed and receive no generated code or communication.
-- New rows get their account fields and six-digit onboarding code atomically
-- through hq_create_provider_account.

alter table public.providers
  add column if not exists onboarding_code text,
  add column if not exists plan text,
  add column if not exists provider_role text,
  add column if not exists phone text,
  add column if not exists city text,
  add column if not exists state text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_onboarding_code_check'
      and conrelid = 'public.providers'::regclass
  ) then
    alter table public.providers
      add constraint providers_onboarding_code_check
      check (onboarding_code is null or onboarding_code ~ '^[0-9]{6}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'providers_plan_check'
      and conrelid = 'public.providers'::regclass
  ) then
    alter table public.providers
      add constraint providers_plan_check
      check (plan is null or plan in ('Core', 'Plus', 'Concierge'));
  end if;
end
$$;

create unique index if not exists providers_onboarding_code_key
  on public.providers (onboarding_code)
  where onboarding_code is not null;

comment on column public.providers.onboarding_code is
  'Six-digit code patients enter during onboarding; null for existing records not yet assigned a code.';
comment on column public.providers.plan is
  'Authoritative provider plan when known; null when the source has no plan assignment.';

-- The API verifies the bearer token before calling this function and passes the
-- verified user id. Re-check the HQ role here so the atomic write has a
-- database-side authorization boundary too.
create or replace function public.hq_create_provider_account(
  p_created_by uuid,
  p_office_name text,
  p_provider_name text,
  p_provider_role text,
  p_email text,
  p_phone text,
  p_city text,
  p_state text,
  p_plan text
)
returns public.providers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider public.providers%rowtype;
  v_code text;
  v_digits text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if not exists (
    select 1 from public.profiles
    where id = p_created_by and role = 'hq_admin'::public.app_role
  ) then
    raise exception 'Only HQ administrators can create provider accounts.';
  end if;

  if trim(coalesce(p_office_name, '')) = '' or trim(coalesce(p_provider_name, '')) = '' then
    raise exception 'Office and provider names are required.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid provider email address.';
  end if;
  if p_plan is not null and p_plan not in ('Core', 'Plus', 'Concierge') then
    raise exception 'Choose a valid plan.';
  end if;
  if length(v_phone_digits) > 0 and length(v_phone_digits) < 10 then
    raise exception 'Enter a valid provider phone number.';
  end if;

  -- Serialize intentional account creates by normalized contact. This keeps
  -- read/check/insert atomic even though imported legacy rows cannot accept a
  -- global unique-email index (some contacts legitimately repeat today).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-email:' || v_email, 0)
  );
  if length(v_phone_digits) >= 10 then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('provider-phone:' || right(v_phone_digits, 10), 0)
    );
  end if;

  if exists (
    select 1 from public.providers
    where lower(coalesce(email, '')) = v_email
       or (
         length(v_phone_digits) >= 10
         and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
         and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(v_phone_digits, 10)
       )
  ) then
    raise exception 'A provider with that contact already exists.';
  end if;
  if exists (
    select 1 from public.team_members
    where lower(coalesce(email, '')) = v_email
  ) then
    raise exception 'A staff member with that email already exists.';
  end if;
  if exists (
    select 1 from auth.users
    where lower(coalesce(email, '')) = v_email
       or (
         length(v_phone_digits) >= 10
         and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
         and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(v_phone_digits, 10)
       )
  ) then
    raise exception 'That email already has a login.';
  end if;

  loop
    v_digits := lpad((floor(random() * 1000000))::text, 6, '0');
    begin
      insert into public.providers (
        provider_id, provider_name, office_name, email, phone, city, state,
        provider_role, plan, onboarding_code, access_disabled
      )
      values (
        'live-' || replace(gen_random_uuid()::text, '-', ''),
        trim(p_provider_name), trim(p_office_name), v_email, nullif(trim(p_phone), ''),
        nullif(trim(p_city), ''), nullif(upper(trim(p_state)), ''),
        nullif(trim(p_provider_role), ''), p_plan, v_digits, false
      )
      returning * into v_provider;
      exit;
    exception when unique_violation then
      -- The only uniqueness expected for new legacy-compatible provider rows
      -- is onboarding_code. If another constraint fired, do not hide it.
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

revoke all on function public.hq_create_provider_account(uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;