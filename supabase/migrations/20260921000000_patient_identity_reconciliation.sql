-- Patient identity collision inventory + guarded reconciliation.
--
-- This migration deliberately separates three things:
--   * read-only, redacted reports (patient/auth ids + state, never contact text);
--   * a narrow reconciliation function for an unlinked invitation duplicated
--     by an already-activated patient in the SAME office;
--   * stronger normalized unique indexes for all future writes.
--
-- Nothing runs reconciliation automatically. Ambiguous/shared-contact cases
-- stay untouched. The function archives a full before-image in the private
-- schema, moves patient-owned rows transactionally, and soft-archives the
-- losing invitation. Existing auth users are never moved, merged, or deleted.

alter table public.patients
  add column if not exists archived_at timestamptz,
  add column if not exists archived_into_patient_id uuid
    references public.patients(id),
  add column if not exists identity_reconciliation_id uuid;

comment on column public.patients.archived_at is
  'Soft-archive timestamp. Identity reconciliation never hard-deletes a patient.';
comment on column public.patients.archived_into_patient_id is
  'Canonical patient retained after an explicitly reviewed identity reconciliation.';
comment on column public.patients.identity_reconciliation_id is
  'Private audit record for the reviewed reconciliation that archived this row.';

create table if not exists private.patient_identity_reconciliation_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default clock_timestamp(),
  canonical_patient_id uuid not null,
  archived_patient_id uuid not null unique,
  classification text not null
    check (classification = 'unambiguous_invitation_duplicate'),
  reason text not null check (length(btrim(reason)) >= 8),
  reviewed_by uuid references auth.users(id) on delete set null,
  canonical_before jsonb not null,
  archived_before jsonb not null,
  dependency_counts_before jsonb not null,
  moved_rows jsonb not null default '{}'::jsonb,
  check (canonical_patient_id <> archived_patient_id)
);

revoke all on private.patient_identity_reconciliation_audit from public, anon, authenticated;

create or replace function private.patient_dependency_counts(p_patient_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  dependency record;
  row_count bigint;
  result jsonb := '{}'::jsonb;
begin
  for dependency in
    select c.table_schema, c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
    order by c.table_name
  loop
    execute format(
      'select count(*) from %I.%I where patient_id = $1',
      dependency.table_schema,
      dependency.table_name
    )
    into row_count
    using p_patient_id;
    result := result || jsonb_build_object(dependency.table_name, row_count);
  end loop;
  return result;
end;
$$;

revoke all on function private.patient_dependency_counts(uuid)
  from public, anon, authenticated;

create or replace function private.patient_identity_collision_report()
returns table (
  collision_kind text,
  collision_number bigint,
  classification text,
  member_count integer,
  patients jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with patient_keys as (
    select
      p.id,
      p.provider_id,
      p.activation_status,
      p.auth_user_id,
      p.claimed_at,
      p.created_at,
      p.invited_at,
      nullif(lower(btrim(p.email)), '') as email_key,
      case
        when length(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g')) >= 10
          then right(regexp_replace(p.phone, '\D', '', 'g'), 10)
      end as phone_key
    from public.patients p
    where p.archived_at is null
  ),
  members as (
    select 'email'::text as kind, p.email_key as identity_key, p.*
    from patient_keys p
    where p.email_key is not null
      and p.email_key in (
        select email_key
        from patient_keys
        where email_key is not null
        group by email_key
        having count(*) > 1
      )
    union all
    select 'phone'::text, p.phone_key, p.*
    from patient_keys p
    where p.phone_key is not null
      and p.phone_key in (
        select phone_key
        from patient_keys
        where phone_key is not null
        group by phone_key
        having count(*) > 1
      )
  ),
  collision_groups as (
    select
      m.kind,
      m.identity_key,
      count(*)::integer as members,
      count(*) filter (where m.auth_user_id is not null) as linked_members,
      count(*) filter (
        where m.activation_status = 'invited' and m.auth_user_id is null
      ) as unlinked_invitations,
      count(distinct m.provider_id) filter (where m.provider_id is not null) as offices,
      count(distinct m.email_key) filter (where m.email_key is not null) as email_keys,
      count(*) filter (where m.email_key is null) as missing_emails,
      count(distinct m.phone_key) filter (where m.phone_key is not null) as phone_keys,
      count(*) filter (where m.phone_key is null) as missing_phones,
      jsonb_agg(
        jsonb_build_object(
          'patientId', m.id,
          'providerId', m.provider_id,
          'activationStatus', m.activation_status,
          'authUserId', m.auth_user_id,
          'claimedAt', m.claimed_at,
          'invitedAt', m.invited_at,
          'createdAt', m.created_at,
          'dependencyCounts', private.patient_dependency_counts(m.id)
        )
        order by m.created_at, m.id
      ) as patient_rows
    from members m
    group by m.kind, m.identity_key
  )
  select
    g.kind,
    row_number() over (partition by g.kind order by g.patient_rows::text),
    case
      when g.members = 2
        and g.linked_members = 1
        and g.unlinked_invitations = 1
        and g.offices = 1
        and g.email_keys = 1
        and g.missing_emails = 0
        and g.phone_keys = 1
        and g.missing_phones = 0
        then 'candidate_unambiguous_invitation_duplicate'
      when g.linked_members > 1 or g.offices > 1
        then 'potential_shared_contact_review'
      else 'ambiguous_identity_review'
    end,
    g.members,
    g.patient_rows
  from collision_groups g
  order by g.kind, 2;
$$;

revoke all on function private.patient_identity_collision_report()
  from public, anon, authenticated;

create or replace function private.patient_auth_realm_overlap_report()
returns table (
  overlap_number bigint,
  classification text,
  patient_id uuid,
  provider_id text,
  activation_status text,
  patient_auth_user_id uuid,
  other_auth_user_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with patient_keys as (
    select
      p.id,
      p.provider_id,
      p.activation_status,
      p.auth_user_id,
      right(regexp_replace(p.phone, '\D', '', 'g'), 10) as phone_key
    from public.patients p
    where p.archived_at is null
      and p.phone is not null
      and length(regexp_replace(p.phone, '\D', '', 'g')) >= 10
  ),
  overlap_rows as (
    select
      p.id as patient_id,
      p.provider_id,
      p.activation_status,
      p.auth_user_id as patient_auth_user_id,
      u.id as other_auth_user_id,
      coalesce(u.raw_app_meta_data ->> 'thinnr_claim', '') as other_claim,
      coalesce(profile.role::text, '') as other_profile_role
    from patient_keys p
    join auth.users u
      on u.phone is not null
     and right(regexp_replace(u.phone, '\D', '', 'g'), 10) = p.phone_key
     and u.id is distinct from p.auth_user_id
    left join public.profiles profile on profile.id = u.id
  )
  select
    row_number() over (order by o.patient_id, o.other_auth_user_id),
    case
      when o.other_claim in ('provider', 'team_member', 'hq_member')
        or o.other_profile_role in ('provider_staff', 'hq_admin')
        then 'expected_staff_patient_shared_phone'
      else 'ambiguous_auth_realm_overlap'
    end,
    o.patient_id,
    o.provider_id,
    o.activation_status,
    o.patient_auth_user_id,
    o.other_auth_user_id
  from overlap_rows o
  order by 1;
$$;

revoke all on function private.patient_auth_realm_overlap_report()
  from public, anon, authenticated;

create or replace function private.reconcile_invited_patient_duplicate(
  p_canonical_patient_id uuid,
  p_duplicate_patient_id uuid,
  p_reason text,
  p_reviewed_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  canonical public.patients%rowtype;
  duplicate public.patients%rowtype;
  audit_id uuid;
  dependency record;
  moved_count bigint;
  moved jsonb := '{}'::jsonb;
  dependency_counts jsonb;
  canonical_email_key text;
  duplicate_email_key text;
  canonical_phone_key text;
  duplicate_phone_key text;
  path_bound_count bigint;
begin
  if p_canonical_patient_id = p_duplicate_patient_id then
    raise exception 'canonical and duplicate patient must differ';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'an explicit review reason is required';
  end if;

  -- Serialize both rows in a stable order, then re-read their locked state.
  perform 1
  from public.patients
  where id in (p_canonical_patient_id, p_duplicate_patient_id)
  order by id
  for update;

  select * into canonical
  from public.patients
  where id = p_canonical_patient_id;
  select * into duplicate
  from public.patients
  where id = p_duplicate_patient_id;

  if canonical.id is null or duplicate.id is null then
    raise exception 'both patient rows must exist';
  end if;
  if canonical.archived_at is not null or duplicate.archived_at is not null then
    raise exception 'an archived patient cannot be reconciled again';
  end if;
  if canonical.auth_user_id is null or canonical.activation_status <> 'activated' then
    raise exception 'canonical patient must be activated and auth-linked';
  end if;
  if duplicate.auth_user_id is not null or duplicate.activation_status <> 'invited' then
    raise exception 'duplicate patient must be an unlinked invitation';
  end if;
  if canonical.provider_id is distinct from duplicate.provider_id then
    raise exception 'cross-office identities require manual review';
  end if;

  canonical_email_key := nullif(lower(btrim(canonical.email)), '');
  duplicate_email_key := nullif(lower(btrim(duplicate.email)), '');
  canonical_phone_key := case
    when length(regexp_replace(coalesce(canonical.phone, ''), '\D', '', 'g')) >= 10
      then right(regexp_replace(canonical.phone, '\D', '', 'g'), 10)
  end;
  duplicate_phone_key := case
    when length(regexp_replace(coalesce(duplicate.phone, ''), '\D', '', 'g')) >= 10
      then right(regexp_replace(duplicate.phone, '\D', '', 'g'), 10)
  end;

  if canonical_email_key is null
    or canonical_email_key is distinct from duplicate_email_key
    or canonical_phone_key is null
    or canonical_phone_key is distinct from duplicate_phone_key
  then
    raise exception 'safe reconciliation requires matching normalized email and phone';
  end if;

  -- Object paths are patient-id-bound. Moving only their database rows would
  -- make authorization reject the files, so any such data requires a separate
  -- reviewed media migration rather than this safe invitation path.
  select
    (select count(*) from public.patient_media where patient_id = duplicate.id)
    + (select count(*) from public.patient_progress_photos where patient_id = duplicate.id)
    + (select count(*) from public.patient_custom_foods where patient_id = duplicate.id and photo_path is not null)
    + (select count(*) from public.patient_saved_recipes where patient_id = duplicate.id and photo_path is not null)
  into path_bound_count;
  if path_bound_count > 0 then
    raise exception 'duplicate has patient-id-bound media and requires manual review';
  end if;

  dependency_counts := private.patient_dependency_counts(duplicate.id);
  insert into private.patient_identity_reconciliation_audit (
    canonical_patient_id,
    archived_patient_id,
    classification,
    reason,
    reviewed_by,
    canonical_before,
    archived_before,
    dependency_counts_before
  )
  values (
    canonical.id,
    duplicate.id,
    'unambiguous_invitation_duplicate',
    btrim(p_reason),
    p_reviewed_by,
    to_jsonb(canonical),
    to_jsonb(duplicate),
    dependency_counts
  )
  returning id into audit_id;

  -- Update every current public patient-owned table. Unique-key conflicts or
  -- future schema surprises abort the transaction; nothing is partially moved.
  for dependency in
    select c.table_schema, c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
    order by c.table_name
  loop
    execute format(
      'update %I.%I set patient_id = $1 where patient_id = $2',
      dependency.table_schema,
      dependency.table_name
    )
    using canonical.id, duplicate.id;
    get diagnostics moved_count = row_count;
    moved := moved || jsonb_build_object(dependency.table_name, moved_count);
  end loop;

  update public.patients
  set
    activation_status = 'disabled',
    auth_user_id = null,
    email = null,
    phone = null,
    archived_at = clock_timestamp(),
    archived_into_patient_id = canonical.id,
    identity_reconciliation_id = audit_id
  where id = duplicate.id
    and auth_user_id is null
    and activation_status = 'invited'
    and archived_at is null;
  if not found then
    raise exception 'duplicate changed during reconciliation';
  end if;

  update private.patient_identity_reconciliation_audit
  set moved_rows = moved
  where id = audit_id;

  return audit_id;
end;
$$;

revoke all on function private.reconcile_invited_patient_duplicate(uuid, uuid, text, uuid)
  from public, anon, authenticated;

-- Refuse to install the normalized backstops over unresolved active rows.
do $$
begin
  if exists (
    select 1
    from public.patients
    where archived_at is null
      and nullif(btrim(email), '') is not null
    group by lower(btrim(email))
    having count(*) > 1
  ) then
    raise exception 'unresolved normalized patient email collisions';
  end if;
  if exists (
    select 1
    from public.patients
    where archived_at is null
      and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
    group by right(regexp_replace(phone, '\D', '', 'g'), 10)
    having count(*) > 1
  ) then
    raise exception 'unresolved normalized patient phone collisions';
  end if;
  if exists (
    select auth_user_id
    from public.patients
    where archived_at is null and auth_user_id is not null
    group by auth_user_id
    having count(*) > 1
  ) then
    raise exception 'unresolved patient auth-link collisions';
  end if;
end;
$$;

create unique index if not exists patients_email_normalized_unique_idx
  on public.patients (lower(btrim(email)))
  where archived_at is null and nullif(btrim(email), '') is not null;

create unique index if not exists patients_phone_normalized_unique_idx
  on public.patients (right(regexp_replace(phone, '\D', '', 'g'), 10))
  where archived_at is null
    and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10;

create unique index if not exists patients_active_auth_user_id_unique_idx
  on public.patients (auth_user_id)
  where archived_at is null and auth_user_id is not null;

create or replace function private.patient_identity_postcondition_audit()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'emailCollisions', (
      select count(*)
      from (
        select lower(btrim(email))
        from public.patients
        where archived_at is null and nullif(btrim(email), '') is not null
        group by lower(btrim(email))
        having count(*) > 1
      ) collisions
    ),
    'phoneCollisions', (
      select count(*)
      from (
        select right(regexp_replace(phone, '\D', '', 'g'), 10)
        from public.patients
        where archived_at is null
          and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
        group by right(regexp_replace(phone, '\D', '', 'g'), 10)
        having count(*) > 1
      ) collisions
    ),
    'authLinkCollisions', (
      select count(*)
      from (
        select auth_user_id
        from public.patients
        where archived_at is null and auth_user_id is not null
        group by auth_user_id
        having count(*) > 1
      ) collisions
    ),
    'requiredIndexes', (
      select coalesce(
        jsonb_object_agg(required.name, to_regclass('public.' || required.name) is not null),
        '{}'::jsonb
      )
      from (
        values
          ('patients_email_normalized_unique_idx'),
          ('patients_phone_normalized_unique_idx'),
          ('patients_active_auth_user_id_unique_idx')
      ) required(name)
    )
  );
$$;

revoke all on function private.patient_identity_postcondition_audit()
  from public, anon, authenticated;