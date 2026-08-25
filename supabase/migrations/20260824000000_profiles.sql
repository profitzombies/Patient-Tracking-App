-- THINNR account profiles and role routing.
-- Safe to apply to a fresh project or to the existing THINNR profiles table.

do $$
begin
  if not exists (
    select 1
    from pg_type type
    join pg_namespace namespace on namespace.oid = type.typnamespace
    where type.typname = 'app_role'
      and namespace.nspname = 'public'
  ) then
    create type public.app_role as enum ('hq_admin', 'provider_staff', 'patient');
  end if;
end
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'patient',
  display_name text,
  email text,
  phone text,
  provider_account_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Earlier THINNR environments use provider_account_code as the optional link
-- to a provider account. Keep that stable rather than creating a duplicate ID.
alter table public.profiles
  add column if not exists provider_account_code text,
  add column if not exists email text,
  add column if not exists phone text;

-- Some earlier THINNR environments use a text/check-constraint role column.
-- Convert only known values; fail loudly instead of silently changing a role.
do $$
declare
  current_role_type regtype;
begin
  select attribute.atttypid::regtype
  into current_role_type
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace schema on schema.oid = relation.relnamespace
  where schema.nspname = 'public'
    and relation.relname = 'profiles'
    and attribute.attname = 'role'
    and not attribute.attisdropped;

  if current_role_type is distinct from 'public.app_role'::regtype then
    if exists (
      select 1 from public.profiles
      where role::text not in ('hq_admin', 'provider_staff', 'patient')
    ) then
      raise exception 'Cannot migrate profiles.role: unexpected role value exists';
    end if;
    alter table public.profiles alter column role drop default;
    alter table public.profiles
      alter column role type public.app_role using role::text::public.app_role;
  end if;
  alter table public.profiles
    alter column role set default 'patient'::public.app_role;
end
$$;

comment on table public.profiles is 'THINNR account roles and display metadata; authorization is enforced by RLS.';
comment on column public.profiles.provider_account_code is 'Optional link to the seeded or future provider account.';

-- Database administrators pre-approve staff here before account creation.
-- It is intentionally not readable or writable from a signed-in client.
create table if not exists public.staff_role_assignments (
  email text primary key,
  role public.app_role not null
    check (role in ('hq_admin'::public.app_role, 'provider_staff'::public.app_role)),
  provider_account_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.staff_role_assignments enable row level security;
revoke all on public.staff_role_assignments from anon, authenticated;

-- Bootstrap the owner as a pre-approved HQ admin. Other provider and HQ
-- accounts are inserted by a database administrator using the same table.
insert into public.staff_role_assignments (email, role)
values ('andrew@thinnrweightloss.com', 'hq_admin'::public.app_role)
on conflict (email) do update
  set role = excluded.role,
      provider_account_code = excluded.provider_account_code,
      updated_at = now();

-- RLS policies must not select profiles from inside profiles (that recurses).
-- This fixed-search-path helper runs as its migration owner, so it can safely
-- answer the narrow "is the caller an HQ admin?" question without recursion.
create schema if not exists private;
revoke all on schema private from public;

create or replace function private.is_hq_admin()
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
      and profile.role = 'hq_admin'::public.app_role
  );
$$;

revoke all on function private.is_hq_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_hq_admin() to authenticated;

create or replace function public.handle_new_thinnr_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment public.staff_role_assignments%rowtype;
begin
  insert into public.profiles (id, role, display_name, email, phone)
  values (
    new.id,
    'patient'::public.app_role,
    nullif(coalesce(new.raw_user_meta_data ->> 'display_name', ''), ''),
    new.email,
    new.phone
  )
  on conflict (id) do update
    set display_name = coalesce(excluded.display_name, public.profiles.display_name),
        email = excluded.email,
        phone = excluded.phone;

  -- Role elevation requires both a database pre-approval and Supabase-confirmed
  -- control of the email, never a bare signup claim.
  select *
  into assignment
  from public.staff_role_assignments
  where lower(email) = lower(coalesce(new.email, ''));

  update public.profiles
  set role = case
        when found and new.email_confirmed_at is not null then assignment.role
        else 'patient'::public.app_role
      end,
      provider_account_code = case
        when found and new.email_confirmed_at is not null then assignment.provider_account_code
        else null
      end
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_thinnr on auth.users;
create trigger on_auth_user_created_thinnr
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute procedure public.handle_new_thinnr_user();

-- Adding a staff approval after an account has already confirmed its email
-- immediately syncs the account; it does not require the user to sign up again.
create or replace function public.sync_staff_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Revoke the prior address first. This covers an assignment being deleted
  -- or moved to a new address, and keeps no stale elevated profile behind.
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
      and user_record.email_confirmed_at is not null;
    return new;
  end if;

  return old;
end;
$$;

drop trigger if exists sync_thinnr_staff_role_assignment on public.staff_role_assignments;
create trigger sync_thinnr_staff_role_assignment
  after insert or update or delete on public.staff_role_assignments
  for each row execute procedure public.sync_staff_role_assignment();

create or replace function public.set_thinnr_profile_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_thinnr_profile_updated_at on public.profiles;
create trigger set_thinnr_profile_updated_at
  before update on public.profiles
  for each row execute procedure public.set_thinnr_profile_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "Users can read their own THINNR profile" on public.profiles;
create policy "Users can read their own THINNR profile"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

drop policy if exists "HQ admins can read all THINNR profiles" on public.profiles;
create policy "HQ admins can read all THINNR profiles"
  on public.profiles for select
  to authenticated
  using (private.is_hq_admin());

-- Role changes are intentionally service-role/database-admin operations, not
-- client operations. This prevents a signed-in user promoting themselves.
revoke all on public.profiles from anon;
grant select on public.profiles to authenticated;

-- Sync all existing confirmed, pre-approved accounts after applying the
-- migration. Future signups are covered by the auth-users trigger above.
update public.profiles p
set role = assignment.role,
    provider_account_code = assignment.provider_account_code,
    updated_at = now()
from auth.users u
join public.staff_role_assignments assignment
  on lower(assignment.email) = lower(u.email)
where p.id = u.id
  and u.email_confirmed_at is not null;