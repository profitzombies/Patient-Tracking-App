-- THINNR office staff management + office audit trail.
--
-- Provider offices could only add teammates (HQ provisioning / the training
-- invite RPC). This migration gives offices a self-service staff lifecycle
-- and closes the remaining access seams:
--
--   1. team_members.office_role — owner / admin / staff. Owners and admins
--      manage the team; staff only use the dashboard. The provider account
--      holder (providers row) is always an owner and is never a team row.
--   2. Deactivated teammates fail closed EVERYWHERE the profile role used to
--      be enough: private.caller_provider_account() (office RLS) and
--      private.claimed_provider_id() (claimed-identity RLS) now refuse a
--      disabled team member even while profiles.role still says staff.
--   3. office_set_team_member_role / office_set_team_member_status —
--      service-role RPCs the API calls after resolving the caller's office
--      and role. Both re-check the last-owner invariant under a row lock so
--      two concurrent demotions cannot leave an office ownerless.
--      Deactivation also removes the staff pre-approval row, which the
--      existing sync_staff_role_assignment trigger turns into an immediate
--      profile demotion (the operations app signs the browser out on the
--      next role refresh) and a training-viewer unlink. Reactivation puts
--      the pre-approval back, so the same login is re-elevated without a
--      new invitation — no re-provisioning.
--   4. Training publish / unpublish / delete are browser-side Supabase
--      writes with no API hop, so the audit event is captured by a trigger
--      on the training tables (kind + id only, never titles or content).
--
-- Safe to re-run: add column if not exists, create or replace, drop/create
-- triggers.

-- ---------------------------------------------------------------------------
-- 1. Office roles
-- ---------------------------------------------------------------------------

alter table public.team_members
  add column if not exists office_role text not null default 'staff';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'team_members_office_role_check'
      and conrelid = 'public.team_members'::regclass
  ) then
    alter table public.team_members
      add constraint team_members_office_role_check
      check (office_role in ('owner', 'admin', 'staff'));
  end if;
end;
$$;

comment on column public.team_members.office_role is
  'Office-level authority: owner/admin manage the team and see the office audit trail; staff use the dashboard only. The provider account holder is implicitly an owner.';

create index if not exists team_members_provider_role_idx
  on public.team_members (provider_id, office_role, activation_status);

-- ---------------------------------------------------------------------------
-- 2. Deactivated teammates fail closed at the RLS choke points
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
    and not exists (
      select 1 from public.team_members tm
      where tm.auth_user_id = profile.id
        and tm.activation_status = 'disabled'
    );
$$;

revoke all on function private.caller_provider_account() from public;
grant execute on function private.caller_provider_account() to authenticated;

create or replace function private.claimed_provider_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with resolved as (
    select coalesce(
      (select provider_id from public.providers where auth_user_id = (select auth.uid()) limit 1),
      (select provider_id from public.team_members
        where auth_user_id = (select auth.uid())
          and activation_status is distinct from 'disabled'
        limit 1)
    ) as provider_id
  )
  select provider_id
  from resolved
  where provider_id is not null
    and not private.provider_account_is_locked(provider_id);
$$;

revoke all on function private.claimed_provider_id() from public;
grant execute on function private.claimed_provider_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Office staff lifecycle RPCs (service role only; the API authorizes)
-- ---------------------------------------------------------------------------

-- Active owners of an office: team owners who are not disabled, plus the
-- provider account holder when that account can actually sign in (a claimed
-- login) and is not disabled. Unclaimed legacy offices therefore lean on
-- their team owners, and the guard protects the last one.
create or replace function private.office_active_owner_count(p_provider_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select (
    select count(*)::integer
    from public.team_members tm
    where tm.provider_id = p_provider_id
      and tm.office_role = 'owner'
      and tm.activation_status is distinct from 'disabled'
  ) + (
    select count(*)::integer
    from public.providers p
    where p.provider_id = p_provider_id
      and p.auth_user_id is not null
      and p.access_disabled is not true
  );
$$;

revoke all on function private.office_active_owner_count(text) from public, anon, authenticated;
grant execute on function private.office_active_owner_count(text) to service_role;

create or replace function public.office_set_team_member_role(p_member_id uuid, p_role text)
returns public.team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.team_members%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_role not in ('owner', 'admin', 'staff') then
    raise exception 'Choose owner, admin, or staff.';
  end if;

  select * into v_member from public.team_members where id = p_member_id for update;
  if not found then
    raise exception 'Team member not found.';
  end if;
  if v_member.provider_id is null then
    raise exception 'That teammate is not attached to an office.';
  end if;

  if v_member.office_role = 'owner' and p_role <> 'owner'
     and v_member.activation_status is distinct from 'disabled' then
    -- Serialize with every other owner change in this office.
    perform 1 from public.team_members
      where provider_id = v_member.provider_id and office_role = 'owner'
      for update;
    if private.office_active_owner_count(v_member.provider_id) <= 1 then
      raise exception 'The last remaining owner cannot be demoted.';
    end if;
  end if;

  update public.team_members
  set office_role = p_role
  where id = p_member_id
  returning * into v_member;

  return v_member;
end;
$$;

revoke all on function public.office_set_team_member_role(uuid, text) from public, anon, authenticated;
grant execute on function public.office_set_team_member_role(uuid, text) to service_role;

create or replace function public.office_set_team_member_status(p_member_id uuid, p_active boolean)
returns public.team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.team_members%rowtype;
  v_email text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;

  select * into v_member from public.team_members where id = p_member_id for update;
  if not found then
    raise exception 'Team member not found.';
  end if;
  if v_member.provider_id is null then
    raise exception 'That teammate is not attached to an office.';
  end if;
  v_email := lower(trim(coalesce(v_member.email, '')));

  if not p_active then
    if v_member.activation_status = 'disabled' then
      return v_member;
    end if;
    if v_member.office_role = 'owner' then
      perform 1 from public.team_members
        where provider_id = v_member.provider_id and office_role = 'owner'
        for update;
      if private.office_active_owner_count(v_member.provider_id) <= 1 then
        raise exception 'The last remaining owner cannot be deactivated.';
      end if;
    end if;

    update public.team_members
    set activation_status = 'disabled'
    where id = p_member_id
    returning * into v_member;

    -- The pre-approval row is what elevates the profile; removing it makes
    -- sync_staff_role_assignment demote the profile and unlink training
    -- immediately. The team row, login, and history all stay for reactivation.
    if v_email <> '' then
      delete from public.staff_role_assignments where lower(email) = v_email;
    end if;
    return v_member;
  end if;

  if v_member.activation_status <> 'disabled' then
    return v_member;
  end if;

  update public.team_members
  set activation_status = 'activated'
  where id = p_member_id
  returning * into v_member;

  if v_email <> '' then
    insert into public.staff_role_assignments (email, role, provider_account_code)
    values (v_email, 'provider_staff'::public.app_role, v_member.provider_id)
    on conflict (email) do update
      set role = excluded.role,
          provider_account_code = excluded.provider_account_code,
          updated_at = now();
  end if;
  return v_member;
end;
$$;

revoke all on function public.office_set_team_member_status(uuid, boolean) from public, anon, authenticated;
grant execute on function public.office_set_team_member_status(uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Training publish / unpublish / delete audit (browser-side writes)
-- ---------------------------------------------------------------------------

create or replace function private.audit_training_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_action text;
  v_id uuid;
  v_parent uuid;
  v_uid uuid := (select auth.uid());
begin
  v_kind := case tg_table_name
    when 'training_courses' then 'course'
    when 'training_modules' then 'module'
    when 'training_subgroups' then 'subgroup'
    when 'training_videos' then 'video'
    else tg_table_name
  end;

  if tg_op = 'DELETE' then
    -- Rows removed by an FK cascade see their parent already gone; only the
    -- row the staffer actually deleted is recorded (one event per action,
    -- not one per descendant).
    v_parent := case tg_table_name
      when 'training_modules' then (to_jsonb(old) ->> 'course_id')::uuid
      when 'training_subgroups' then (to_jsonb(old) ->> 'module_id')::uuid
      when 'training_videos' then (to_jsonb(old) ->> 'module_id')::uuid
      else null
    end;
    if tg_table_name = 'training_modules' then
      if not exists (select 1 from public.training_courses c where c.id = v_parent) then
        return old;
      end if;
    elsif tg_table_name in ('training_subgroups', 'training_videos') then
      if not exists (select 1 from public.training_modules m where m.id = v_parent) then
        return old;
      end if;
    end if;
    v_action := 'training_deleted';
    v_id := old.id;
  else
    if tg_table_name = 'training_courses' then
      if new.status is not distinct from old.status then return new; end if;
      v_action := case when new.status = 'live' then 'training_published' else 'training_unpublished' end;
    else
      if new.published is not distinct from old.published then return new; end if;
      v_action := case when new.published = 'published' then 'training_published' else 'training_unpublished' end;
    end if;
    v_id := new.id;
  end if;

  insert into public.admin_audit_events
    (action, actor_user_id, actor_kind, provider_id, target_kind, target_id, request_id, metadata)
  values (
    v_action,
    v_uid,
    case when v_uid is null then 'system' else 'hq' end,
    null,
    'training_' || v_kind,
    v_id::text,
    null,
    jsonb_build_object('kind', v_kind)
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.audit_training_change() from public, anon, authenticated;

drop trigger if exists training_courses_audit on public.training_courses;
create trigger training_courses_audit
  after update of status or delete on public.training_courses
  for each row execute function private.audit_training_change();

drop trigger if exists training_modules_audit on public.training_modules;
create trigger training_modules_audit
  after update of published or delete on public.training_modules
  for each row execute function private.audit_training_change();

drop trigger if exists training_subgroups_audit on public.training_subgroups;
create trigger training_subgroups_audit
  after update of published or delete on public.training_subgroups
  for each row execute function private.audit_training_change();

drop trigger if exists training_videos_audit on public.training_videos;
create trigger training_videos_audit
  after update of published or delete on public.training_videos
  for each row execute function private.audit_training_change();
