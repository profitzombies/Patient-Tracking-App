-- THINNR provider account locks: HQ shuts off a provider office's access.
--
-- Provider accounts themselves are seeded demo data inside the operations
-- web app (React + sessionStorage, no server); only the lock flag lives in
-- the database so it holds across browsers and sessions. A row in
-- public.provider_account_locks means that account is locked.
--
--   1. public.provider_account_locks — presence-keyed lock, one row per
--      locked provider account code (e.g. acct-p1). World-readable by
--      design (non-PII: an account code plus a timestamp) so demo personas
--      can render Locked badges; INSERT/DELETE only for a real signed-in
--      HQ admin — the same author-write rule the training editor uses.
--   2. private.provider_account_is_locked(text) — the shared lock check.
--   3. private.caller_provider_account() (full replacement of the 20260827
--      version) returns null while the caller's office is locked, so every
--      office-scoped RLS branch keyed on it (office roster reads, office
--      completion reads, add-staff targeting) shuts off together.
--   4. private.caller_is_staff() (full replacement of the 20260828 version)
--      stays true for HQ admins but goes false for provider staff of a
--      locked office — the own-row RLS branches and
--      training_mark_video_complete_self close with it.
--   5. training_add_staff (full replacement of the 20260827 version)
--      additionally refuses provider-staff callers while their office is
--      locked; HQ admins can still add staff anywhere.
--
-- Unlocking deletes the lock row and nothing else: profiles, viewer links,
-- and completions were never touched, so access returns exactly as it was.
--
-- Safe to re-run: IF NOT EXISTS, CREATE OR REPLACE, drop-and-recreate policies.

-- ---------------------------------------------------------------------------
-- 1. Lock table
-- ---------------------------------------------------------------------------

create table if not exists public.provider_account_locks (
  account_id text primary key,
  locked_at timestamptz not null default now()
);

comment on table public.provider_account_locks is
  'Provider accounts THINNR has locked out of the office side; presence of a row = locked. Non-sensitive by design (world-readable so demo badges render).';
comment on column public.provider_account_locks.account_id is
  'Provider account code (profiles.provider_account_code / seeded account id, e.g. acct-p1).';

alter table public.provider_account_locks enable row level security;

revoke all on public.provider_account_locks from anon, authenticated;
grant select on public.provider_account_locks to anon, authenticated;
grant insert, delete on public.provider_account_locks to authenticated;

-- Lock state is non-sensitive and drives Locked badges in the anonymous demo.
drop policy if exists "Anyone can read lock state" on public.provider_account_locks;
create policy "Anyone can read lock state"
  on public.provider_account_locks for select
  to anon, authenticated
  using (true);

drop policy if exists "HQ admins lock accounts" on public.provider_account_locks;
create policy "HQ admins lock accounts"
  on public.provider_account_locks for insert
  to authenticated
  with check (private.is_hq_admin());

drop policy if exists "HQ admins unlock accounts" on public.provider_account_locks;
create policy "HQ admins unlock accounts"
  on public.provider_account_locks for delete
  to authenticated
  using (private.is_hq_admin());

-- Realtime (where the publication exists) lets open sessions react to a
-- lock flip immediately; the app also polls, so this is best-effort. The
-- guard also skips FOR ALL TABLES publications, which already carry it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'provider_account_locks'
    )
  then
    alter publication supabase_realtime add table public.provider_account_locks;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Shared lock check (private schema, fixed search_path)
-- ---------------------------------------------------------------------------

create or replace function private.provider_account_is_locked(p_account_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.provider_account_locks lock_row
    where lock_row.account_id = p_account_id
  );
$$;

revoke all on function private.provider_account_is_locked(text) from public;
grant execute on function private.provider_account_is_locked(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. A locked office no longer counts as the caller's office
--    (full replacement of the 20260827 version)
-- ---------------------------------------------------------------------------

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
    and profile.provider_account_code is not null
    and not private.provider_account_is_locked(profile.provider_account_code);
$$;

revoke all on function private.caller_provider_account() from public;
grant execute on function private.caller_provider_account() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Provider staff of a locked office are not "active staff"
--    (full replacement of the 20260828 version; HQ admins unaffected)
-- ---------------------------------------------------------------------------

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
        )
      )
  );
$$;

revoke all on function private.caller_is_staff() from public;
grant execute on function private.caller_is_staff() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Self-serve teammate adds refuse locked offices
--    (full replacement of the 20260827 version; only the lock check is new)
-- ---------------------------------------------------------------------------

create or replace function public.training_add_staff(
  p_account_id text,
  p_name text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_account text := trim(coalesce(p_account_id, ''));
  v_name text := trim(coalesce(p_name, ''));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_caller_office text;
  v_existing public.staff_role_assignments%rowtype;
  v_viewer public.training_viewers%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to add teammates.';
  end if;

  if v_account = '' or char_length(v_account) > 80 then
    raise exception 'Choose a valid office.';
  end if;

  if not private.is_hq_admin() then
    select profile.provider_account_code into v_caller_office
    from public.profiles profile
    where profile.id = v_uid
      and profile.role = 'provider_staff'::public.app_role;

    if v_caller_office is null or v_caller_office <> v_account then
      raise exception 'You can only add teammates to your own office.';
    end if;

    -- A locked office cannot grow its roster while locked.
    if private.provider_account_is_locked(v_caller_office) then
      raise exception 'This account is locked by THINNR. Contact THINNR to restore access.';
    end if;
  end if;

  if char_length(v_email) < 3 or char_length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;

  if v_name = '' then
    raise exception 'Enter the teammate''s name.';
  end if;

  select * into v_existing
  from public.staff_role_assignments
  where lower(email) = v_email;

  if found then
    if v_existing.role <> 'provider_staff'::public.app_role
      or coalesce(v_existing.provider_account_code, '') <> v_account then
      raise exception 'That email already has a different staff assignment.';
    end if;
    -- Same office, same role: fall through and make sure the viewer exists.
  else
    insert into public.staff_role_assignments (email, role, provider_account_code)
    values (v_email, 'provider_staff'::public.app_role, v_account);
    -- The sync trigger elevates an already-confirmed account and links
    -- its viewer row immediately.
  end if;

  select * into v_viewer
  from public.training_viewers
  where lower(email) = v_email
  order by created_at asc
  limit 1;

  if found then
    update public.training_viewers
    set account_id = v_account,
        name = case
          when coalesce(trim(name), '') in ('', '—') then left(v_name, 120)
          else name
        end
    where id = v_viewer.id
    returning * into v_viewer;
  else
    if (select count(*) from public.training_viewers) >= 5000 then
      raise exception 'The demo viewer roster is full.';
    end if;

    insert into public.training_viewers
      (name, email, phone, account_id, location, sessions, is_demo)
    values
      (left(v_name, 120), v_email, '—', v_account, '—', 0, false)
    returning * into v_viewer;
  end if;

  return jsonb_build_object('viewer', to_jsonb(v_viewer));
end;
$$;

revoke all on function public.training_add_staff(text, text, text) from public, anon;
grant execute on function public.training_add_staff(text, text, text) to authenticated;
