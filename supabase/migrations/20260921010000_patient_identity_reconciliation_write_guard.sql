-- Close the dependent-write race around patient identity reconciliation.
--
-- Every current public table with patient_id receives the same BEFORE
-- INSERT/UPDATE trigger. Writers and the reconciliation wrapper take a
-- transaction-level advisory lock derived from the patient id:
--   * a writer that owns the lock first commits before reconciliation moves it;
--   * reconciliation that owns the lock first moves everything, archives the
--     duplicate, then a waiting writer wakes and rejects the archived target.
--
-- The original reviewed reconciliation implementation remains the inner
-- operation. The wrapper adds lock ordering and a final zero-dependent check.

create or replace function private.guard_patient_dependency_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_id uuid;
  second_id uuid;
  target_archived_at timestamptz;
begin
  if tg_op = 'UPDATE' and old.patient_id is distinct from new.patient_id then
    if old.patient_id::text < new.patient_id::text then
      first_id := old.patient_id;
      second_id := new.patient_id;
    else
      first_id := new.patient_id;
      second_id := old.patient_id;
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(first_id::text, 40421001)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(second_id::text, 40421001)
    );
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.patient_id::text, 40421001)
    );
  end if;

  -- A plain SELECT could retain the statement snapshot from before an
  -- advisory-lock wait. FOR KEY SHARE follows the current row version after
  -- a concurrent archive commits, closing that stale-snapshot window.
  select p.archived_at
  into target_archived_at
  from public.patients p
  where p.id = new.patient_id
  for key share;
  if not found then
    raise exception 'cannot attach data to an unknown patient';
  end if;
  if target_archived_at is not null then
    raise exception 'cannot attach data to an archived patient';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_patient_dependency_write()
  from public, anon, authenticated;

create or replace function private.install_patient_identity_write_guards()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dependency record;
  installed integer := 0;
begin
  for dependency in
    select c.table_schema, c.table_name
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
    order by c.table_name
  loop
    execute format(
      'drop trigger if exists patient_identity_write_guard on %I.%I',
      dependency.table_schema,
      dependency.table_name
    );
    execute format(
      'create trigger patient_identity_write_guard
         before insert or update of patient_id on %I.%I
         for each row execute function private.guard_patient_dependency_write()',
      dependency.table_schema,
      dependency.table_name
    );
    installed := installed + 1;
  end loop;
  return installed;
end;
$$;

revoke all on function private.install_patient_identity_write_guards()
  from public, anon, authenticated;

select private.install_patient_identity_write_guards();

do $$
begin
  if to_regprocedure(
    'private.reconcile_invited_patient_duplicate_locked_impl(uuid,uuid,text,uuid)'
  ) is null then
    alter function private.reconcile_invited_patient_duplicate(uuid, uuid, text, uuid)
      rename to reconcile_invited_patient_duplicate_locked_impl;
  end if;
end;
$$;

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
  first_id uuid;
  second_id uuid;
  audit_id uuid;
  remaining jsonb;
begin
  if p_canonical_patient_id::text < p_duplicate_patient_id::text then
    first_id := p_canonical_patient_id;
    second_id := p_duplicate_patient_id;
  else
    first_id := p_duplicate_patient_id;
    second_id := p_canonical_patient_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(first_id::text, 40421001)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(second_id::text, 40421001)
  );

  audit_id := private.reconcile_invited_patient_duplicate_locked_impl(
    p_canonical_patient_id,
    p_duplicate_patient_id,
    p_reason,
    p_reviewed_by
  );

  remaining := private.patient_dependency_counts(p_duplicate_patient_id);
  if exists (
    select 1
    from jsonb_each_text(remaining) dependency
    where dependency.value::bigint <> 0
  ) then
    raise exception 'dependent rows remained on archived patient; reconciliation rolled back';
  end if;

  return audit_id;
end;
$$;

revoke all on function private.reconcile_invited_patient_duplicate(uuid, uuid, text, uuid)
  from public, anon, authenticated;

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
    'unguardedDependencyTables', (
      select count(*)
      from information_schema.columns c
      join pg_catalog.pg_class table_class
        on table_class.relname = c.table_name
      join pg_catalog.pg_namespace table_namespace
        on table_namespace.oid = table_class.relnamespace
       and table_namespace.nspname = c.table_schema
      where c.table_schema = 'public'
        and c.column_name = 'patient_id'
        and not exists (
          select 1
          from pg_catalog.pg_trigger trigger_row
          where trigger_row.tgrelid = table_class.oid
            and trigger_row.tgname = 'patient_identity_write_guard'
            and not trigger_row.tgisinternal
        )
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

-- Migration-time proof: every current public patient_id column has the guard.
do $$
begin
  if exists (
    select 1
    from information_schema.columns c
    join pg_catalog.pg_class table_class
      on table_class.relname = c.table_name
    join pg_catalog.pg_namespace table_namespace
      on table_namespace.oid = table_class.relnamespace
     and table_namespace.nspname = c.table_schema
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
      and not exists (
        select 1
        from pg_catalog.pg_trigger trigger_row
        where trigger_row.tgrelid = table_class.oid
          and trigger_row.tgname = 'patient_identity_write_guard'
          and not trigger_row.tgisinternal
      )
  ) then
    raise exception 'patient identity write guard missing from a dependent table';
  end if;
end;
$$;