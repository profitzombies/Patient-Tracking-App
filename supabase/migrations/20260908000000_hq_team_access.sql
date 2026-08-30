-- Durable THINNR HQ team roles, membership lifecycle, and authorization.
--
-- public.profiles.role = hq_admin remains a compatibility attribute for Super
-- Admin and Admin accounts only. It is never authorization: every HQ permission
-- helper below requires an active hq_memberships row.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'hq_department_role'
  ) then
    create type public.hq_department_role as enum
      ('super_admin', 'admin', 'clinical', 'support', 'content');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'hq_membership_status'
  ) then
    create type public.hq_membership_status as enum
      ('invited', 'active', 'revoked');
  end if;

  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'hq_invitation_status'
  ) then
    create type public.hq_invitation_status as enum
      ('pending', 'accepted', 'revoked', 'expired');
  end if;
end
$$;

create table if not exists public.hq_memberships (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  email text not null,
  display_name text not null,
  job_title text,
  department_role public.hq_department_role not null,
  status public.hq_membership_status not null default 'invited',
  is_protected_owner boolean not null default false,
  invited_by uuid references auth.users(id) on delete set null,
  invited_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hq_memberships_email_canonical_check
    check (email = lower(trim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint hq_memberships_name_check check (char_length(trim(display_name)) between 1 and 120),
  constraint hq_memberships_title_check check (job_title is null or char_length(trim(job_title)) between 1 and 120),
  constraint hq_memberships_owner_role_check
    check (
      (is_protected_owner and department_role = 'super_admin' and status = 'active')
      or (not is_protected_owner and department_role <> 'super_admin')
    ),
  constraint hq_memberships_lifecycle_check
    check (
      (status = 'invited' and auth_user_id is null and activated_at is null and revoked_at is null)
      or (status = 'active' and auth_user_id is not null and activated_at is not null and revoked_at is null)
      or (status = 'revoked' and revoked_at is not null)
    )
);

create unique index if not exists hq_memberships_email_key
  on public.hq_memberships (lower(email));
create unique index if not exists hq_memberships_one_protected_owner_key
  on public.hq_memberships (is_protected_owner)
  where is_protected_owner;
create unique index if not exists hq_memberships_one_super_admin_key
  on public.hq_memberships (department_role)
  where department_role = 'super_admin' and status = 'active';

create table if not exists public.hq_invitations (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.hq_memberships(id) on delete cascade,
  email text not null,
  token_hash text not null,
  status public.hq_invitation_status not null default 'pending',
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hq_invitations_email_canonical_check check (email = lower(trim(email))),
  constraint hq_invitations_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint hq_invitations_expiry_check check (expires_at > created_at),
  constraint hq_invitations_lifecycle_check
    check (
      (status = 'pending' and accepted_at is null and revoked_at is null)
      or (status = 'accepted' and accepted_at is not null and revoked_at is null)
      or (status = 'revoked' and accepted_at is null and revoked_at is not null)
      or (status = 'expired' and accepted_at is null and revoked_at is null)
    )
);

create unique index if not exists hq_invitations_token_hash_key
  on public.hq_invitations (token_hash);
create unique index if not exists hq_invitations_one_pending_per_member_key
  on public.hq_invitations (membership_id)
  where status = 'pending';
create unique index if not exists hq_invitations_one_pending_per_email_key
  on public.hq_invitations (lower(email))
  where status = 'pending';

comment on table public.hq_memberships is
  'Canonical live THINNR HQ roster. Active rows authorize immediately; revoked rows retain an audit trail but grant nothing.';
comment on column public.hq_memberships.department_role is
  'HQ department role. super_admin is reserved for the protected owner and cannot be assigned by ordinary team operations.';
comment on table public.hq_invitations is
  'One-time HQ setup invitations. Only a SHA-256 token hash is retained; plaintext setup tokens and passwords are never stored.';

-- Keep these limits aligned with the team API. The explicit replacement also
-- upgrades a database where an earlier draft of this migration used 120.
alter table public.hq_memberships
  drop constraint if exists hq_memberships_name_check,
  drop constraint if exists hq_memberships_title_check;
alter table public.hq_memberships
  add constraint hq_memberships_name_check
    check (char_length(trim(display_name)) between 1 and 160),
  add constraint hq_memberships_title_check
    check (job_title is null or char_length(trim(job_title)) between 1 and 160);

alter table public.hq_memberships enable row level security;
alter table public.hq_invitations enable row level security;
revoke all on public.hq_memberships, public.hq_invitations from anon, authenticated;
grant select on public.hq_memberships, public.hq_invitations to authenticated;
grant all on public.hq_memberships, public.hq_invitations to service_role;

-- Keep permission names as text so adding a permission does not require an enum
-- migration. Unknown permissions fail closed.
create or replace function private.hq_role_has_permission(
  p_role public.hq_department_role,
  p_permission text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_permission not in (
      'team_manage', 'settings_manage', 'provider_manage', 'provider_read',
      'provider_contact_read', 'clinical_read', 'analytics_read',
      'conversation_clinical', 'conversation_support', 'content_manage',
      'financial_read', 'account_lock'
    ) then false
    when p_role in ('super_admin', 'admin') then true
    when p_role = 'clinical' then p_permission in (
      'provider_read', 'provider_contact_read', 'clinical_read',
      'analytics_read', 'conversation_clinical'
    )
    when p_role = 'support' then p_permission in (
      'provider_contact_read', 'conversation_support'
    )
    when p_role = 'content' then p_permission = 'content_manage'
    else false
  end;
$$;

create or replace function private.hq_user_has_permission(
  p_user_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((
      select private.hq_role_has_permission(m.department_role, p_permission)
      from public.hq_memberships m
      where m.auth_user_id = p_user_id and m.status = 'active'
      limit 1
    ), false);
$$;

create or replace function private.has_hq_permission(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.hq_user_has_permission((select auth.uid()), p_permission);
$$;

create or replace function private.current_hq_department_role()
returns public.hq_department_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.department_role
  from public.hq_memberships m
  where m.auth_user_id = (select auth.uid()) and m.status = 'active'
  limit 1;
$$;

-- Existing migrations and API code use this name for full administrator
-- authority. Preserve the name, but make it membership-aware and fail closed
-- for Clinical, Support, Content, and revoked identities.
create or replace function private.is_hq_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.hq_user_has_permission((select auth.uid()), 'team_manage');
$$;

revoke all on function private.hq_role_has_permission(public.hq_department_role, text) from public;
revoke all on function private.hq_user_has_permission(uuid, text) from public;
revoke all on function private.has_hq_permission(text) from public;
revoke all on function private.current_hq_department_role() from public;
revoke all on function private.is_hq_admin() from public;
grant execute on function private.has_hq_permission(text) to authenticated;
grant execute on function private.current_hq_department_role() to authenticated;
grant execute on function private.is_hq_admin() to authenticated;
grant execute on function private.hq_user_has_permission(uuid, text) to service_role;

create or replace function private.validate_hq_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth auth.users%rowtype;
begin
  new.email := lower(trim(new.email));
  new.display_name := trim(new.display_name);
  new.job_title := nullif(trim(coalesce(new.job_title, '')), '');
  new.updated_at := now();

  if new.is_protected_owner and new.email <> 'andrew+admin@thinnrweightloss.com' then
    raise exception 'The protected owner identity is fixed.';
  end if;

  if tg_op = 'UPDATE' and old.is_protected_owner and (
    new.auth_user_id is distinct from old.auth_user_id
    or new.email is distinct from old.email
    or new.department_role is distinct from old.department_role
    or new.status is distinct from old.status
    or new.is_protected_owner is distinct from old.is_protected_owner
  ) then
    raise exception 'The protected Super Admin cannot be demoted, revoked, reassigned, or removed.';
  end if;

  if new.auth_user_id is not null then
    select * into v_auth from auth.users where id = new.auth_user_id;
    if not found or lower(coalesce(v_auth.email, '')) <> new.email then
      raise exception 'HQ membership and Auth email do not match.';
    end if;
    if new.status = 'active' and v_auth.email_confirmed_at is null then
      raise exception 'An HQ membership cannot activate before email confirmation.';
    end if;
  end if;

  -- New invitations must not claim a contact already used by any real-data,
  -- office-staff, profile, assignment, or Auth identity.
  if new.status = 'invited' and (
    exists (select 1 from auth.users u where lower(coalesce(u.email, '')) = new.email)
    or exists (select 1 from public.profiles p where lower(coalesce(p.email, '')) = new.email)
    or exists (select 1 from public.providers p where lower(coalesce(p.email, '')) = new.email)
    or exists (select 1 from public.patients p where lower(coalesce(p.email, '')) = new.email)
    or exists (select 1 from public.team_members t where lower(coalesce(t.email, '')) = new.email)
    or exists (select 1 from public.staff_role_assignments a where lower(a.email) = new.email)
    or exists (select 1 from public.role_assignments a where lower(coalesce(a.email, '')) = new.email)
  ) then
    raise exception 'That email already belongs to a THINNR identity.';
  end if;

  return new;
end;
$$;

create or replace function private.validate_hq_invitation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.hq_memberships%rowtype;
begin
  new.email := lower(trim(new.email));
  new.token_hash := lower(trim(new.token_hash));
  new.updated_at := now();

  select * into v_member
  from public.hq_memberships
  where id = new.membership_id;

  if not found or v_member.email <> new.email
    or v_member.department_role = 'super_admin' then
    raise exception 'Invitation does not match an inviteable pending HQ membership.';
  end if;

  if tg_op = 'INSERT' then
    if v_member.status <> 'invited' then
      raise exception 'Invitation does not match an inviteable pending HQ membership.';
    end if;
    if not private.hq_user_has_permission(new.created_by, 'team_manage') then
      raise exception 'Only an active THINNR administrator can create HQ invitations.';
    end if;
  else
    if old.status <> 'pending' or new.membership_id <> old.membership_id
      or new.email <> old.email or new.token_hash <> old.token_hash
      or new.created_by <> old.created_by then
      raise exception 'HQ invitation identity is immutable and terminal invitations cannot be changed.';
    end if;
    if (new.status = 'accepted' and v_member.status not in ('invited', 'active'))
      or (new.status = 'revoked' and v_member.status not in ('invited', 'revoked'))
      or (new.status = 'expired' and v_member.status <> 'invited')
      or new.status = 'pending' then
      raise exception 'Invalid HQ invitation lifecycle transition.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.sync_hq_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_protected_owner then
      raise exception 'The protected Super Admin cannot be removed.';
    end if;
    delete from public.staff_role_assignments
    where lower(email) = old.email and role = 'hq_admin'::public.app_role;
    update public.profiles
    set role = 'patient'::public.app_role, provider_account_code = null
    where id = old.auth_user_id;
    return old;
  end if;

  if new.status = 'active' then
    update public.hq_invitations
    set status = 'accepted', accepted_at = coalesce(accepted_at, now())
    where membership_id = new.id and status = 'pending';
  elsif new.status = 'revoked' then
    update public.hq_invitations
    set status = 'revoked', revoked_at = coalesce(revoked_at, now())
    where membership_id = new.id and status = 'pending';
  end if;

  if new.status = 'active' and new.department_role in ('super_admin', 'admin') then
    insert into public.staff_role_assignments (email, role, provider_account_code)
    values (new.email, 'hq_admin'::public.app_role, null)
    on conflict (email) do update
      set role = excluded.role,
          provider_account_code = null,
          updated_at = now();
    update public.profiles
    set role = 'hq_admin'::public.app_role,
        display_name = new.display_name,
        email = new.email,
        provider_account_code = null
    where id = new.auth_user_id;
  else
    delete from public.staff_role_assignments
    where lower(email) = new.email and role = 'hq_admin'::public.app_role;
    if new.auth_user_id is not null then
      update public.profiles
      set role = 'patient'::public.app_role,
          display_name = new.display_name,
          email = new.email,
          provider_account_code = null
      where id = new.auth_user_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.ensure_hq_team_administrator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.hq_memberships) and not exists (
    select 1
    from public.hq_memberships
    where status = 'active' and department_role in ('super_admin', 'admin')
  ) then
    raise exception 'At least one active HQ team administrator is required.';
  end if;
  return null;
end;
$$;

drop trigger if exists validate_hq_membership on public.hq_memberships;
create trigger validate_hq_membership
  before insert or update on public.hq_memberships
  for each row execute function private.validate_hq_membership();

drop trigger if exists sync_hq_membership on public.hq_memberships;
create trigger sync_hq_membership
  after insert or update or delete on public.hq_memberships
  for each row execute function private.sync_hq_membership();

drop trigger if exists ensure_hq_team_administrator on public.hq_memberships;
create constraint trigger ensure_hq_team_administrator
  after insert or update or delete on public.hq_memberships
  deferrable initially deferred
  for each row execute function private.ensure_hq_team_administrator();

drop trigger if exists validate_hq_invitation on public.hq_invitations;
create trigger validate_hq_invitation
  before insert or update on public.hq_invitations
  for each row execute function private.validate_hq_invitation();

revoke all on function private.validate_hq_membership() from public;
revoke all on function private.validate_hq_invitation() from public;
revoke all on function private.sync_hq_membership() from public;
revoke all on function private.ensure_hq_team_administrator() from public;

-- Exact, reviewed QA cleanup. Both immutable identifiers must match before the
-- Auth delete can happen, so this can never become a wildcard test-data purge.
do $$
declare
  v_qa_id constant uuid := '65825658-4ceb-442f-99fa-5ace1c06df83';
  v_qa_email constant text := 'qa-ui-hq-1787681027458@thinnr-staff-check.com';
begin
  if exists (select 1 from auth.users where id = v_qa_id and lower(coalesce(email, '')) <> v_qa_email)
    or exists (select 1 from auth.users where lower(coalesce(email, '')) = v_qa_email and id <> v_qa_id) then
    raise exception 'Refusing QA cleanup: the exact Auth id/email pair no longer matches.';
  end if;

  delete from public.hq_invitations where lower(email) = v_qa_email;
  delete from public.hq_memberships where auth_user_id = v_qa_id or lower(email) = v_qa_email;
  delete from public.training_viewers where auth_user_id = v_qa_id or lower(email) = v_qa_email;
  delete from public.staff_role_assignments where lower(email) = v_qa_email;
  delete from public.role_assignments where lower(coalesce(email, '')) = v_qa_email;
  delete from auth.users where id = v_qa_id and lower(coalesce(email, '')) = v_qa_email;

  if exists (select 1 from auth.users where id = v_qa_id or lower(coalesce(email, '')) = v_qa_email)
    or exists (select 1 from public.profiles where id = v_qa_id or lower(coalesce(email, '')) = v_qa_email)
    or exists (select 1 from public.staff_role_assignments where lower(email) = v_qa_email)
    or exists (select 1 from public.role_assignments where lower(coalesce(email, '')) = v_qa_email) then
    raise exception 'Exact QA UI Admin cleanup did not complete.';
  end if;
end
$$;

-- The superseded non-plus bootstrap address must not remain a dormant admin
-- preapproval. This does not delete an Auth identity.
delete from public.staff_role_assignments
where lower(email) = 'andrew@thinnrweightloss.com'
  and not exists (
    select 1 from auth.users where lower(coalesce(email, '')) = 'andrew@thinnrweightloss.com'
  );

-- Link the existing confirmed owner identity. No auth.users column is written:
-- in particular this never creates an account, changes a password/hash, changes
-- confirmation state, or sends an invitation.
do $$
declare
  v_owner auth.users%rowtype;
begin
  select * into v_owner
  from auth.users
  where lower(coalesce(email, '')) = 'andrew+admin@thinnrweightloss.com';

  if not found then
    raise notice 'Owner Auth identity is absent; bootstrap skipped without creating or changing Auth.';
    return;
  end if;
  if v_owner.email_confirmed_at is null then
    raise exception 'The existing Andrew owner identity must be email-confirmed before HQ bootstrap.';
  end if;

  insert into public.profiles (id, role, display_name, email, phone)
  values (
    v_owner.id, 'hq_admin'::public.app_role, 'Andrew',
    lower(v_owner.email), v_owner.phone
  )
  on conflict (id) do update
    set role = 'hq_admin'::public.app_role,
        display_name = 'Andrew',
        email = lower(v_owner.email),
        phone = coalesce(public.profiles.phone, excluded.phone),
        provider_account_code = null;

  insert into public.hq_memberships (
    auth_user_id, email, display_name, job_title, department_role, status,
    is_protected_owner, activated_at
  )
  values (
    v_owner.id, 'andrew+admin@thinnrweightloss.com', 'Andrew', null,
    'super_admin', 'active', true, coalesce(v_owner.email_confirmed_at, now())
  )
  on conflict ((lower(email))) do update
    set auth_user_id = excluded.auth_user_id,
        display_name = excluded.display_name,
        department_role = excluded.department_role,
        status = excluded.status,
        is_protected_owner = excluded.is_protected_owner,
        activated_at = excluded.activated_at,
        revoked_at = null,
        revoked_by = null;
end
$$;

drop policy if exists "HQ teammates read their own membership" on public.hq_memberships;
create policy "HQ teammates read their own membership"
  on public.hq_memberships for select to authenticated
  using (auth_user_id = (select auth.uid()));

drop policy if exists "HQ administrators read the team roster" on public.hq_memberships;
create policy "HQ administrators read the team roster"
  on public.hq_memberships for select to authenticated
  using ((select private.has_hq_permission('team_manage')));

drop policy if exists "HQ administrators read invitations" on public.hq_invitations;
create policy "HQ administrators read invitations"
  on public.hq_invitations for select to authenticated
  using ((select private.has_hq_permission('team_manage')));

-- Limited-role policies. Full admins continue through the existing
-- private.is_hq_admin() policies, now backed by the durable membership.
do $$
declare
  t text;
begin
  foreach t in array array[
    'patient_logs', 'patient_log_flags', 'patient_measurements',
    'patient_messages', 'chatbot_messages', 'patient_feedback',
    'custom_foods', 'custom_recipes'
  ]
  loop
    execute format('drop policy if exists "HQ clinical teammates read clinical rows" on public.%I', t);
    execute format(
      'create policy "HQ clinical teammates read clinical rows" on public.%I for select to authenticated using ((select private.has_hq_permission(''clinical_read'')))',
      t
    );
  end loop;

  foreach t in array array[
    'provider_measurements', 'provider_referrals', 'users_onboarded_daily',
    'global_onboard_daily', 'user_metrics'
  ]
  loop
    execute format('drop policy if exists "HQ clinical teammates read analytics rows" on public.%I', t);
    execute format(
      'create policy "HQ clinical teammates read analytics rows" on public.%I for select to authenticated using ((select private.has_hq_permission(''analytics_read'')))',
      t
    );
  end loop;

  foreach t in array array[
    'training_courses', 'training_modules', 'training_subgroups',
    'training_videos', 'training_viewers', 'training_invites',
    'training_completions'
  ]
  loop
    execute format('drop policy if exists "HQ content teammates manage training" on public.%I', t);
    execute format(
      'create policy "HQ content teammates manage training" on public.%I for all to authenticated using ((select private.has_hq_permission(''content_manage''))) with check ((select private.has_hq_permission(''content_manage'')))',
      t
    );
  end loop;
end
$$;

drop policy if exists "HQ clinical teammates read providers" on public.providers;
create policy "HQ clinical teammates read providers"
  on public.providers for select to authenticated
  using ((select private.has_hq_permission('provider_read')));

drop policy if exists "HQ support teammates read support conversations" on public.tech_support_messages;
create policy "HQ support teammates read support conversations"
  on public.tech_support_messages for select to authenticated
  using ((select private.has_hq_permission('conversation_support')));

drop policy if exists "HQ content teammates manage knowledge" on public.knowledge_documents;
create policy "HQ content teammates manage knowledge"
  on public.knowledge_documents for all to authenticated
  using ((select private.has_hq_permission('content_manage')))
  with check ((select private.has_hq_permission('content_manage')));

grant select, insert, update, delete on public.knowledge_documents to authenticated;

-- Support must never receive the financial/clinical columns on providers.
-- This narrow RPC is the only database-direct provider surface granted to that
-- role; the base providers policy above remains Clinical/Admin only.
-- DROP first because PostgreSQL cannot use CREATE OR REPLACE to remove an OUT
-- column from a table-returning function. This makes reapplying the migration
-- safely replace the earlier signature that included plan.
drop function if exists public.hq_provider_contact_directory();
create or replace function public.hq_provider_contact_directory()
returns table (
  provider_id text,
  provider_name text,
  office_name text,
  email text,
  phone text,
  city text,
  state text,
  provider_role text,
  access_disabled boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_hq_permission('provider_contact_read') then
    raise exception 'Not authorized to read provider contacts.';
  end if;
  return query
    select p.provider_id, p.provider_name, p.office_name, p.email, p.phone,
           p.city, p.state, p.provider_role, p.access_disabled,
           p.created_at, p.updated_at
    from public.providers p;
end;
$$;

-- Clinical receives clinical/identity fields without charge, subscription,
-- banking, or other financial columns embedded in the legacy patients table.
create or replace function public.hq_clinical_patient_directory()
returns table (
  id uuid,
  provider_id text,
  name text,
  email text,
  phone text,
  activation_status text,
  program_id text,
  program_start_date date,
  date_of_birth date,
  height text,
  starting_weight numeric,
  current_weight numeric,
  goal_weight numeric,
  weight_gain_lost numeric,
  timezone text,
  last_login_at timestamptz,
  last_log_date date,
  notes jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_hq_permission('clinical_read') then
    raise exception 'Not authorized to read clinical patients.';
  end if;
  return query
    select p.id, p.provider_id, p.name, p.email, p.phone, p.activation_status,
           p.program_id, p.program_start_date, p.date_of_birth, p.height,
           p.starting_weight, p.current_weight, p.goal_weight,
           p.weight_gain_lost, p.timezone, p.last_login_at, p.last_log_date,
           p.notes
    from public.patients p;
end;
$$;

revoke all on function public.hq_provider_contact_directory() from public, anon;
revoke all on function public.hq_clinical_patient_directory() from public, anon;
grant execute on function public.hq_provider_contact_directory() to authenticated;
grant execute on function public.hq_clinical_patient_directory() to authenticated;

-- API compatibility surface. The canonical storage remains hq_memberships,
-- while the HQ team route uses these stable presentation column names.
create or replace view public.hq_team_members
with (security_invoker = true)
as
select
  m.id,
  m.auth_user_id,
  m.display_name as name,
  m.email,
  coalesce(m.job_title, '') as title,
  m.department_role as role,
  m.status,
  m.invited_by,
  m.invited_at,
  m.activated_at as joined_at,
  m.revoked_at,
  m.created_at,
  m.updated_at
from public.hq_memberships m;

revoke all on public.hq_team_members from public, anon, authenticated;
grant select on public.hq_team_members to service_role;

create or replace function public.hq_invite_team_member(
  p_actor_id uuid,
  p_name text,
  p_email text,
  p_title text,
  p_role text
)
returns public.hq_team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.hq_memberships%rowtype;
  v_role public.hq_department_role;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_result public.hq_team_members%rowtype;
begin
  if not private.hq_user_has_permission(p_actor_id, 'team_manage') then
    raise exception 'Only an active THINNR administrator can invite HQ teammates.';
  end if;
  if p_role not in ('admin', 'clinical', 'support', 'content') then
    raise exception 'Choose an inviteable HQ role.';
  end if;
  v_role := p_role::public.hq_department_role;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hq-email:' || v_email, 0)
  );

  insert into public.hq_memberships (
    email, display_name, job_title, department_role, status,
    invited_by, invited_at
  )
  values (
    v_email, trim(coalesce(p_name, '')), nullif(trim(coalesce(p_title, '')), ''),
    v_role, 'invited', p_actor_id, now()
  )
  returning * into v_member;

  insert into public.hq_invitations (
    membership_id, email, token_hash, expires_at, created_by
  )
  values (
    v_member.id,
    v_member.email,
    pg_catalog.encode(
      extensions.digest(
        v_member.id::text || ':' || gen_random_uuid()::text || ':' || clock_timestamp()::text,
        'sha256'
      ),
      'hex'
    ),
    now() + interval '24 hours',
    p_actor_id
  );

  select * into v_result from public.hq_team_members where id = v_member.id;
  return v_result;
end;
$$;

create or replace function public.hq_update_team_member(
  p_actor_id uuid,
  p_member_id uuid,
  p_name text,
  p_title text,
  p_role text
)
returns public.hq_team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.hq_memberships%rowtype;
  v_target public.hq_memberships%rowtype;
  v_result public.hq_team_members%rowtype;
begin
  if not private.hq_user_has_permission(p_actor_id, 'team_manage') then
    raise exception 'Only an active THINNR administrator can update HQ teammates.';
  end if;
  select * into v_actor
  from public.hq_memberships
  where auth_user_id = p_actor_id and status = 'active';
  select * into v_target
  from public.hq_memberships
  where id = p_member_id
  for update;
  if not found then
    raise exception 'HQ teammate not found.';
  end if;
  if v_target.is_protected_owner then
    raise exception 'The protected Super Admin cannot be changed through ordinary team operations.';
  end if;
  if p_role is not null and p_role not in ('admin', 'clinical', 'support', 'content') then
    raise exception 'Choose an editable HQ role.';
  end if;
  if v_target.auth_user_id = p_actor_id
    and p_role is not null
    and p_role not in ('admin') then
    raise exception 'You cannot remove your own team-management access.';
  end if;

  update public.hq_memberships
  set display_name = coalesce(nullif(trim(coalesce(p_name, '')), ''), display_name),
      job_title = case when p_title is null then job_title else nullif(trim(p_title), '') end,
      department_role = coalesce(p_role::public.hq_department_role, department_role)
  where id = p_member_id;

  select * into v_result from public.hq_team_members where id = p_member_id;
  return v_result;
end;
$$;

-- V2 is the secure setup-path entry point. The API generates a high-entropy
-- plaintext setup token, hashes it with SHA-256, passes only that hash here,
-- and sends the plaintext token only in the post-commit email. Keeping the
-- original five-argument function above preserves already-deployed callers.
create or replace function public.hq_invite_team_member_v2(
  p_actor_id uuid,
  p_name text,
  p_email text,
  p_title text,
  p_role text,
  p_token_hash text,
  p_expires_at timestamptz default null
)
returns public.hq_team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.hq_memberships%rowtype;
  v_role public.hq_department_role;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_token_hash text := lower(trim(coalesce(p_token_hash, '')));
  v_expires_at timestamptz := coalesce(p_expires_at, now() + interval '24 hours');
  v_result public.hq_team_members%rowtype;
begin
  if not private.hq_user_has_permission(p_actor_id, 'team_manage') then
    raise exception 'Only an active THINNR administrator can invite HQ teammates.';
  end if;
  if p_role not in ('admin', 'clinical', 'support', 'content') then
    raise exception 'Choose an inviteable HQ role.';
  end if;
  if v_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A SHA-256 setup token hash is required.';
  end if;
  if v_expires_at <= now() or v_expires_at > now() + interval '7 days' then
    raise exception 'Choose an invitation expiry within the next seven days.';
  end if;
  v_role := p_role::public.hq_department_role;

  -- Serialize both membership and token claims. The unique indexes are the
  -- final backstop; this lock makes the friendly duplicate failure deterministic.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hq-email:' || v_email, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hq-token:' || v_token_hash, 0)
  );

  insert into public.hq_memberships (
    email, display_name, job_title, department_role, status,
    invited_by, invited_at
  )
  values (
    v_email, trim(coalesce(p_name, '')), nullif(trim(coalesce(p_title, '')), ''),
    v_role, 'invited', p_actor_id, now()
  )
  returning * into v_member;

  insert into public.hq_invitations (
    membership_id, email, token_hash, expires_at, created_by
  )
  values (v_member.id, v_member.email, v_token_hash, v_expires_at, p_actor_id);

  select * into v_result from public.hq_team_members where id = v_member.id;
  return v_result;
end;
$$;

-- Accept after the API has created the Auth account through GoTrue with the
-- recipient's chosen password. This function never accepts a password and
-- never writes auth.users. It is safe to retry after a network timeout: the
-- same accepted token/user pair returns the already-active membership.
create or replace function public.hq_accept_team_invitation(
  p_token_hash text,
  p_auth_user_id uuid
)
returns public.hq_team_members
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text := lower(trim(coalesce(p_token_hash, '')));
  v_invitation public.hq_invitations%rowtype;
  v_member public.hq_memberships%rowtype;
  v_auth auth.users%rowtype;
  v_result public.hq_team_members%rowtype;
  v_profile_role public.app_role;
begin
  if v_hash !~ '^[0-9a-f]{64}$' or p_auth_user_id is null then
    raise exception 'Invalid or expired HQ setup invitation.';
  end if;

  -- The token row is the serialization point for concurrent accepts.
  select * into v_invitation
  from public.hq_invitations
  where token_hash = v_hash
  for update;
  if not found then
    raise exception 'Invalid or expired HQ setup invitation.';
  end if;

  select * into v_member
  from public.hq_memberships
  where id = v_invitation.membership_id
  for update;
  if not found then
    raise exception 'Invalid or expired HQ setup invitation.';
  end if;

  if v_invitation.status = 'accepted' then
    if v_member.auth_user_id = p_auth_user_id and v_member.status = 'active' then
      select * into v_result from public.hq_team_members where id = v_member.id;
      return v_result;
    end if;
    raise exception 'This HQ setup invitation has already been used.';
  end if;
  if v_invitation.status <> 'pending' or v_invitation.expires_at <= now()
    or v_member.status <> 'invited' then
    raise exception 'Invalid or expired HQ setup invitation.';
  end if;

  select * into v_auth from auth.users where id = p_auth_user_id;
  if not found
    or v_auth.email_confirmed_at is null
    or lower(coalesce(v_auth.email, '')) <> v_member.email then
    raise exception 'The confirmed Auth account does not match this HQ invitation.';
  end if;

  v_profile_role := case
    when v_member.department_role in ('super_admin', 'admin')
      then 'hq_admin'::public.app_role
    else 'patient'::public.app_role
  end;

  -- Claim-created users intentionally skip the older demo profile trigger.
  -- Ensure every accepted HQ member still gets the live profile identity.
  insert into public.profiles (
    id, role, display_name, email, phone, provider_account_code
  )
  values (
    v_auth.id, v_profile_role, v_member.display_name, v_member.email,
    v_auth.phone, null
  )
  on conflict (id) do update
    set role = excluded.role,
        display_name = excluded.display_name,
        email = excluded.email,
        phone = coalesce(public.profiles.phone, excluded.phone),
        provider_account_code = null;

  update public.hq_memberships
  set auth_user_id = p_auth_user_id,
      status = 'active',
      activated_at = coalesce(activated_at, now()),
      revoked_at = null,
      revoked_by = null
  where id = v_member.id;

  -- sync_hq_membership accepts the locked pending invitation in the same
  -- transaction. Do not update it again here: its transition trigger rightly
  -- treats accepted invitations as terminal.

  select * into v_result from public.hq_team_members where id = v_member.id;
  return v_result;
end;
$$;

create or replace function public.hq_revoke_team_member(
  p_actor_id uuid,
  p_member_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.hq_memberships%rowtype;
begin
  if not private.hq_user_has_permission(p_actor_id, 'team_manage') then
    raise exception 'Only an active THINNR administrator can revoke HQ teammates.';
  end if;
  select * into v_target
  from public.hq_memberships
  where id = p_member_id
  for update;
  if not found then
    raise exception 'HQ teammate not found.';
  end if;
  if v_target.is_protected_owner then
    raise exception 'The protected Super Admin cannot be revoked.';
  end if;
  if v_target.auth_user_id = p_actor_id then
    raise exception 'You cannot revoke your own account.';
  end if;

  update public.hq_memberships
  set status = 'revoked',
      revoked_at = now(),
      revoked_by = p_actor_id
  where id = p_member_id;

  return jsonb_build_object('revoked', true, 'id', p_member_id);
end;
$$;

revoke all on function public.hq_invite_team_member(uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.hq_invite_team_member_v2(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.hq_accept_team_invitation(text, uuid)
  from public, anon, authenticated;
revoke all on function public.hq_update_team_member(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.hq_revoke_team_member(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.hq_invite_team_member(uuid, text, text, text, text)
  to service_role;
grant execute on function public.hq_invite_team_member_v2(uuid, text, text, text, text, text, timestamptz)
  to service_role;
grant execute on function public.hq_accept_team_invitation(text, uuid)
  to service_role;
grant execute on function public.hq_update_team_member(uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.hq_revoke_team_member(uuid, uuid)
  to service_role;

-- Migration-time SQL regression proof for the complete role matrix and live
-- bootstrap/cleanup invariants. These assertions roll back the migration on a
-- permission regression instead of leaving a partly trusted authorization map.
do $$
declare
  v_owner_present boolean;
begin
  if not private.hq_role_has_permission('super_admin', 'team_manage')
    or not private.hq_role_has_permission('admin', 'settings_manage')
    or not private.hq_role_has_permission('clinical', 'clinical_read')
    or not private.hq_role_has_permission('clinical', 'analytics_read')
    or private.hq_role_has_permission('clinical', 'team_manage')
    or not private.hq_role_has_permission('support', 'provider_contact_read')
    or not private.hq_role_has_permission('support', 'conversation_support')
    or private.hq_role_has_permission('support', 'clinical_read')
    or private.hq_role_has_permission('support', 'financial_read')
    or not private.hq_role_has_permission('content', 'content_manage')
    or private.hq_role_has_permission('content', 'provider_read')
    or private.hq_role_has_permission('admin', 'unknown_permission') then
    raise exception 'HQ permission-matrix regression.';
  end if;

  select exists (
    select 1 from auth.users
    where lower(coalesce(email, '')) = 'andrew+admin@thinnrweightloss.com'
  ) into v_owner_present;

  if v_owner_present and (
    select count(*)
    from public.hq_memberships
    where status = 'active'
  ) <> 1 then
    raise exception 'Initial live HQ roster must contain exactly one active teammate.';
  end if;

  if v_owner_present and not exists (
    select 1
    from public.hq_memberships m
    join auth.users u on u.id = m.auth_user_id
    where lower(u.email) = 'andrew+admin@thinnrweightloss.com'
      and m.display_name = 'Andrew'
      and m.department_role = 'super_admin'
      and m.status = 'active'
      and m.is_protected_owner
  ) then
    raise exception 'Andrew owner bootstrap regression.';
  end if;

  if exists (
    select 1 from auth.users
    where id = '65825658-4ceb-442f-99fa-5ace1c06df83'::uuid
       or lower(coalesce(email, '')) = 'qa-ui-hq-1787681027458@thinnr-staff-check.com'
  ) then
    raise exception 'QA UI Admin cleanup regression.';
  end if;
end
$$;