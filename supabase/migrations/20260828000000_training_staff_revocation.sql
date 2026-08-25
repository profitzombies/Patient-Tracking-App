-- THINNR training: revoking a staff assignment revokes training access too.
--
-- Review follow-up to 20260827000000_training_staff_logins.sql. That
-- migration demoted a revoked staffer's profile to patient but kept
-- training_viewers.auth_user_id linked — and the own-row RLS branches plus
-- training_mark_video_complete_self keyed on that link alone, so a revoked
-- sign-in could still read and write its training record by calling the API
-- directly. This migration makes revocation sever the whole chain:
--
--   1. private.caller_is_staff() — active-role check (hq_admin or
--      provider_staff, straight from profiles).
--   2. Own-row RLS branches (viewers + completions) now require an active
--      staff role, not just the historical link.
--   3. training_mark_video_complete_self requires an active staff role.
--   4. sync_staff_role_assignment additionally unlinks the viewer row when
--      an assignment is deleted or moved off an email. The row itself stays
--      (HQ keeps the training history); only the sign-in's grip on it goes.
--      An office move (same email, new office) re-links in the same trigger
--      pass, so moves keep working.
--
-- Safe to re-run: CREATE OR REPLACE + drop/recreate policies.

-- ---------------------------------------------------------------------------
-- 1. Active-staff check (private schema, fixed search_path, non-recursive)
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
      and profile.role in ('hq_admin'::public.app_role, 'provider_staff'::public.app_role)
  );
$$;

revoke all on function private.caller_is_staff() from public;
grant execute on function private.caller_is_staff() to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Office reads require an ACTIVE staff role on the own-row branch
-- ---------------------------------------------------------------------------

drop policy if exists "Office staff read their own office roster" on public.training_viewers;
create policy "Office staff read their own office roster"
  on public.training_viewers for select
  to authenticated
  using (
    (auth_user_id = (select auth.uid()) and private.caller_is_staff())
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
          (viewer.auth_user_id = (select auth.uid()) and private.caller_is_staff())
          or (viewer.account_id is not null and viewer.account_id = private.caller_provider_account())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Self progress tracking requires an ACTIVE staff role
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

  if not private.caller_is_staff() then
    raise exception 'No training profile is linked to this sign-in yet.';
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

-- ---------------------------------------------------------------------------
-- 4. Revoking (or moving) an assignment unlinks the viewer row
-- ---------------------------------------------------------------------------

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

    -- Sever the training link too: the viewer row (and its history) stays
    -- for HQ, but the revoked sign-in loses its own-row read/write path.
    -- On an office move (same email still assigned below) the non-DELETE
    -- branch re-links immediately, so active staff are unaffected.
    update public.training_viewers viewer
    set auth_user_id = null
    from auth.users user_record
    where viewer.auth_user_id = user_record.id
      and lower(user_record.email) = lower(old.email);
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

revoke all on function public.sync_staff_role_assignment() from public, anon, authenticated;
