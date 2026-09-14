-- Retain accounting records while removing patient PII, and permit processed
-- Stripe webhook payloads to be pruned after their operational lifetime.
alter table public.billing_webhook_events
  alter column payload drop not null,
  add column if not exists payload_pruned_at timestamptz;

create or replace function public.patient_purge_rows(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req patient_deletion_requests%rowtype;
  v_patient patients%rowtype;
  v_pending text[];
  v_blocked text[];
  v_name text;
  v_pass integer;
  v_count bigint;
  v_tables jsonb := '{}'::jsonb;
  v_detached bigint := 0;
  v_patient_existed boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_req from patient_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'unknown deletion request'; end if;
  if v_req.status not in ('purging') then raise exception 'deletion request is not being purged'; end if;

  -- Serialise against identity reconciliation and every guarded writer.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_req.patient_id::text, 40421001));

  select * into v_patient from patients where id = v_req.patient_id for update;
  v_patient_existed := found;

  -- Tombstone first: the identity write guard would reject it once the patient
  -- row is gone, and a re-run must find it already present.
  if v_patient_existed and not exists (select 1 from patient_tombstones t where t.id = v_req.patient_id) then
    insert into patient_tombstones (id, provider_id, requested_at, purged_at, was_activated, program_id, enrolled_on)
    values (
      v_patient.id,
      v_patient.provider_id,
      v_req.requested_at,
      now(),
      v_patient.activation_status = 'activated',
      v_patient.program_id,
      coalesce(v_patient.program_start_date::date, v_patient.created_at::date)
    );
  end if;

  update billing_payment_links
     set active = false, patient_id = null
   where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_payment_links_anonymized', v_count);

  update billing_payers
     set patient_id = null,
         name = 'Deleted patient',
         email = 'deleted+' || id::text || '@invalid.thinnr',
         phone = null
   where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_payers_anonymized', v_count);

  update billing_orders
     set patient_id = null,
         shipping_address = jsonb_build_object(
           'city', shipping_address->>'city',
           'state', shipping_address->>'state',
           'postal_code', shipping_address->>'postal_code',
           'country', shipping_address->>'country'
         ),
         metadata = metadata - 'payer'
   where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_orders_anonymized', v_count);

  update billing_subscriptions
     set patient_id = null,
         shipping_address = jsonb_build_object(
           'city', shipping_address->>'city',
           'state', shipping_address->>'state',
           'postal_code', shipping_address->>'postal_code',
           'country', shipping_address->>'country'
         )
   where patient_id = v_req.patient_id;
  get diagnostics v_count = row_count;
  v_tables := v_tables || jsonb_build_object('billing_subscriptions_anonymized', v_count);

  -- Referencing tables first (a NO ACTION foreign key between two
  -- patient-owned tables would otherwise reject the parent's delete); any
  -- table still blocked by a foreign key is retried after the rest.
  v_pending := array(
    select c.table_name::text
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    left join lateral (
      select count(*) as referenced_by
      from pg_catalog.pg_constraint k
      where k.contype = 'f' and k.confrelid = format('public.%I', c.table_name)::regclass
    ) refs on true
    where c.table_schema = 'public'
      and c.column_name = 'patient_id'
      and c.table_name not in ('patient_deletion_requests', 'analytics_events')
      and c.table_name not like 'billing\_%' escape '\'
    order by refs.referenced_by asc, c.table_name asc
  );
  for v_pass in 1..3 loop
    v_blocked := '{}'::text[];
    foreach v_name in array v_pending loop
      begin
        execute format('delete from public.%I where patient_id = $1', v_name) using v_req.patient_id;
        get diagnostics v_count = row_count;
        v_tables := v_tables || jsonb_build_object(v_name, v_count);
      exception when foreign_key_violation then
        v_blocked := v_blocked || v_name;
      end;
    end loop;
    exit when cardinality(v_blocked) = 0;
    if v_pass = 3 then
      raise exception 'purge blocked by foreign keys on %', array_to_string(v_blocked, ', ');
    end if;
    v_pending := v_blocked;
  end loop;

  update analytics_events set patient_id = null where patient_id = v_req.patient_id;
  get diagnostics v_detached = row_count;

  if v_patient_existed then
    update patients set archived_into_patient_id = null where archived_into_patient_id = v_req.patient_id;
    delete from patients where id = v_req.patient_id;
  end if;

  return jsonb_build_object(
    'patientRowDeleted', v_patient_existed,
    'tombstone', exists (select 1 from patient_tombstones t where t.id = v_req.patient_id),
    'analyticsDetached', v_detached,
    'tables', v_tables,
    'authUserId', v_req.auth_user_id
  );
end;
$$;
revoke all on function public.patient_purge_rows(uuid) from public, anon, authenticated;
grant execute on function public.patient_purge_rows(uuid) to service_role;