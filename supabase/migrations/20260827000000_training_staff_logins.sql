-- THINNR training: real staff sign-ins under provider offices.
--
-- Builds on 20260825000000_training.sql (schema) and
-- 20260826000000_training_learner_privacy.sql (demo-scoped anon reads,
-- token-keyed learner RPCs). This migration adds the identity chain that
-- turns a training viewer into a real signed-in teammate:
--
--   staff_role_assignments(email -> provider_staff + provider_account_code)
--     -> user signs up / confirms (existing auth triggers)
--     -> profiles.role + provider_account_code    (already in place)
--     -> training_viewers.auth_user_id            (NEW: linked viewer row)
--
--   1. `training_viewers.auth_user_id` — a confirmed staff sign-in claims the
--      viewer row that carries their email (seeded, invited, or email-gate
--      registered), or gets a fresh row under their office.
--   2. Office reads — signed-in provider staff can read their own office's
--      roster and its completions (on top of the world-readable demo rows).
--      Anon/demo visibility is unchanged.
--   3. `training_add_staff` — self-serve teammate adds: HQ admins for any
--      office, provider staff for their own office. Creates the
--      pre-approval row (so the teammate's signup elevates automatically)
--      plus the office's viewer row. No email is sent by design.
--   4. `training_mark_video_complete_self` — signed-in staff track progress
--      keyed by auth.uid(); same completion semantics as the token RPC.
--
-- Safe to re-run: columns/indexes use IF NOT EXISTS, policies are dropped
-- and recreated, functions are CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- 1. Viewer <-> auth user link
-- ---------------------------------------------------------------------------

alter table public.training_viewers
  add column if not exists auth_user_id uuid;

comment on column public.training_viewers.auth_user_id is
  'Confirmed staff sign-in that owns this viewer row; null for demo/email-gate viewers.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'training_viewers_auth_user_id_fkey'
      and conrelid = 'public.training_viewers'::regclass
  ) then
    alter table public.training_viewers
      add constraint training_viewers_auth_user_id_fkey
      foreign key (auth_user_id) references auth.users (id) on delete set null;
  end if;
end
$$;

create unique index if not exists training_viewers_auth_user_key
  on public.training_viewers (auth_user_id)
  where auth_user_id is not null;

create index if not exists training_viewers_account_idx
  on public.training_viewers (account_id);

-- ---------------------------------------------------------------------------
-- 2. Helpers (private schema, fixed search_path, non-recursive)
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Which office does the signed-in provider staffer belong to? (null for
-- everyone else — HQ admins, patients, anon.)
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
    and profile.role = 'provider_staff'::public.app_role;
$$;

revoke all on function private.caller_provider_account() from public;
grant execute on function private.caller_provider_account() to authenticated;

-- Link a confirmed staff sign-in to its training viewer row. Order:
-- already-linked row wins; otherwise claim the oldest unlinked row carrying
-- the email; otherwise create a fresh non-demo row under the office. The
-- staff assignment's office is authoritative for the linked viewer.
-- Never raises: signup/confirmation must not fail on training bookkeeping.
create or replace function private.link_staff_training_viewer(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_account_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_viewer public.training_viewers%rowtype;
  v_name text;
begin
  if p_user_id is null or v_email = '' then
    return;
  end if;

  select * into v_viewer
  from public.training_viewers
  where auth_user_id = p_user_id;

  if found then
    update public.training_viewers
    set account_id = coalesce(p_account_code, account_id),
        email = v_email
    where id = v_viewer.id;
    return;
  end if;

  select * into v_viewer
  from public.training_viewers
  where lower(email) = v_email
    and auth_user_id is null
  order by created_at asc
  limit 1;

  if found then
    update public.training_viewers
    set auth_user_id = p_user_id,
        account_id = coalesce(p_account_code, account_id),
        name = case
          when coalesce(trim(name), '') in ('', '—')
            then coalesce(nullif(left(trim(coalesce(p_display_name, '')), 120), ''), name)
          else name
        end
    where id = v_viewer.id;
    return;
  end if;

  -- Roster cap mirrors the learner RPCs; skip silently rather than failing
  -- the auth trigger that called us.
  if (select count(*) from public.training_viewers) >= 5000 then
    return;
  end if;

  v_name := coalesce(
    nullif(trim(coalesce(p_display_name, '')), ''),
    nullif(trim(initcap(regexp_replace(split_part(v_email, '@', 1), '[._+\-0-9]+', ' ', 'g'))), ''),
    'New Teammate'
  );

  insert into public.training_viewers
    (name, email, phone, account_id, location, sessions, is_demo, auth_user_id)
  values
    (left(v_name, 120), v_email, '—', p_account_code, '—', 0, false, p_user_id);
end;
$$;

revoke all on function private.link_staff_training_viewer(uuid, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- 3. Auth triggers now also link the training viewer
--    (full replacements of the 20260824000000_profiles.sql versions; the
--    original behavior is preserved verbatim, with the linking call added)
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_thinnr_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment public.staff_role_assignments%rowtype;
  v_approved boolean;
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
  v_approved := found;

  update public.profiles
  set role = case
        when v_approved and new.email_confirmed_at is not null then assignment.role
        else 'patient'::public.app_role
      end,
      provider_account_code = case
        when v_approved and new.email_confirmed_at is not null then assignment.provider_account_code
        else null
      end
  where id = new.id;

  -- A confirmed provider staffer gets (or claims) their training viewer row.
  if v_approved
    and new.email_confirmed_at is not null
    and assignment.role = 'provider_staff'::public.app_role
  then
    perform private.link_staff_training_viewer(
      new.id,
      new.email,
      nullif(coalesce(new.raw_user_meta_data ->> 'display_name', ''), ''),
      assignment.provider_account_code
    );
  end if;

  return new;
end;
$$;

-- Adding a staff approval after an account has already confirmed its email
-- immediately syncs the account; it does not require the user to sign up again.
create or replace function public.sync_staff_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_display_name text;
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

    -- If a confirmed account already exists for this email, link (or create)
    -- its training viewer row under the assigned office right away.
    if new.role = 'provider_staff'::public.app_role then
      select user_record.id, profile.display_name
      into v_user_id, v_display_name
      from auth.users user_record
      left join public.profiles profile on profile.id = user_record.id
      where lower(user_record.email) = lower(new.email)
        and user_record.email_confirmed_at is not null
      limit 1;

      if v_user_id is not null then
        perform private.link_staff_training_viewer(
          v_user_id, new.email, v_display_name, new.provider_account_code
        );
      end if;
    end if;

    return new;
  end if;

  return old;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Office reads: provider staff see their own office's roster + progress.
--    (Additive policies; demo/anon and HQ-admin visibility are unchanged.)
-- ---------------------------------------------------------------------------

drop policy if exists "Office staff read their own office roster" on public.training_viewers;
create policy "Office staff read their own office roster"
  on public.training_viewers for select
  to authenticated
  using (
    auth_user_id = (select auth.uid())
    or (account_id is not null and account_id = private.caller_provider_account())
  );

drop policy if exists "Office staff read their office completions" on public.training_completions;
create policy "Office staff read their office completions"
  on public.training_completions for select
  to authenticated
  using (
    exists (
      select 1
      from public.training_viewers viewer
      where viewer.id = training_completions.viewer_id
        and (
          viewer.auth_user_id = (select auth.uid())
          or (viewer.account_id is not null and viewer.account_id = private.caller_provider_account())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Self-serve teammate adds
-- ---------------------------------------------------------------------------

-- HQ admins may add staff to any office; provider staff only to their own.
-- Creates the signup pre-approval plus the office's viewer row, so the
-- teammate appears on the roster immediately and their future signup with
-- this email links automatically. Deliberately sends no email.
-- Note: adopting a viewer row that already carries this email keeps that
-- row's is_demo flag as-is, so the seeded public demo roster stays stable.
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
    -- The sync trigger above elevates an already-confirmed account and links
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

-- ---------------------------------------------------------------------------
-- 6. Signed-in progress tracking (same semantics as the token RPC)
-- ---------------------------------------------------------------------------

create or replace function public.training_mark_video_complete_self(p_video_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_viewer public.training_viewers%rowtype;
  v_duration integer;
  v_completion public.training_completions%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to track your training.';
  end if;

  select * into v_viewer
  from public.training_viewers
  where auth_user_id = v_uid;

  if not found then
    raise exception 'No training profile is linked to this sign-in yet.';
  end if;

  select duration_seconds into v_duration
  from public.training_videos
  where id = p_video_id;
  if not found then
    raise exception 'That video no longer exists.';
  end if;

  insert into public.training_completions (viewer_id, video_id, watch_seconds, completed_at)
  values (v_viewer.id, p_video_id, v_duration, now())
  on conflict (viewer_id, video_id) do update
    set watch_seconds = greatest(public.training_completions.watch_seconds, excluded.watch_seconds),
        completed_at = coalesce(public.training_completions.completed_at, excluded.completed_at)
  returning * into v_completion;

  -- Debounced activity bump, mirroring the learner-gate RPCs: a burst of
  -- marks counts as one session.
  update public.training_viewers
  set last_seen_at = now(),
      sessions = sessions
        + (case when last_seen_at < now() - interval '30 minutes' then 1 else 0 end)
  where id = v_viewer.id;

  return to_jsonb(v_completion);
end;
$$;

revoke all on function public.training_mark_video_complete_self(uuid) from public, anon;
grant execute on function public.training_mark_video_complete_self(uuid) to authenticated;

-- Trigger functions are invoked by triggers, never by clients; drop the
-- default PUBLIC execute grant (flagged by the security advisor).
revoke all on function public.handle_new_thinnr_user() from public, anon, authenticated;
revoke all on function public.sync_staff_role_assignment() from public, anon, authenticated;
revoke all on function public.set_thinnr_training_updated_at() from public, anon, authenticated;
revoke all on function public.set_thinnr_profile_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Backfill: link viewers for any already-confirmed provider staff
-- ---------------------------------------------------------------------------

do $$
declare
  staff record;
begin
  for staff in
    select user_record.id, user_record.email, profile.display_name, assignment.provider_account_code
    from auth.users user_record
    join public.staff_role_assignments assignment
      on lower(assignment.email) = lower(user_record.email)
    left join public.profiles profile on profile.id = user_record.id
    where assignment.role = 'provider_staff'::public.app_role
      and user_record.email_confirmed_at is not null
  loop
    perform private.link_staff_training_viewer(
      staff.id, staff.email, staff.display_name, staff.provider_account_code
    );
  end loop;
end
$$;
