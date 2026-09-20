-- capture_patient_analytics_event() is shared by five tables but referenced
-- table-specific columns (new.kind, new.measured_at, new.entry_id, …) inside
-- expressions that run for EVERY table. PL/pgSQL resolves record fields when
-- it plans the expression, so on patient_check_ins, patient_diary_entries,
-- patient_progress_photos and patient_health_measurements the trigger raised
-- `record "new" has no field "kind"` and the patient's write was rejected.
-- Read the per-table fields through a jsonb copy of the row instead, which
-- yields null for absent columns rather than a planning error.
create or replace function public.capture_patient_analytics_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_provider text; v_event text; v_date date; v_key text; v_row jsonb;
begin
  if tg_table_name = 'patients' then
    if not (new.activation_status = 'activated' and old.activation_status is distinct from 'activated') then return new; end if;
    insert into analytics_events(event_name, occurred_at, provider_id, patient_id, actor_user_id, source, properties, dedupe_key)
    values ('patient_activated', now(), new.provider_id, new.id, new.auth_user_id, 'database_trigger',
      jsonb_build_object('activation_status', 'activated'), 'patient_activated:' || new.id)
    on conflict (dedupe_key) do nothing;
    return new;
  end if;
  v_row := to_jsonb(new);
  select provider_id into v_provider from patients where id = (v_row->>'patient_id')::uuid;
  if v_provider is null then return new; end if;
  v_event := case tg_table_name when 'patient_diary_entries' then 'meal_logged'
    when 'patient_check_ins' then 'check_in_completed' when 'patient_progress_photos' then 'progress_photo_added'
    when 'patient_health_measurements' then 'weight_recorded' end;
  if v_event is null then return new; end if;
  if tg_table_name = 'patient_health_measurements' and (v_row->>'kind') is distinct from 'weight_lb' then return new; end if;
  v_date := case when tg_table_name = 'patient_health_measurements' then (v_row->>'measured_at')::timestamptz::date else (v_row->>'date_key')::date end;
  v_key := v_event || ':' || (v_row->>'patient_id') || ':' ||
    case when tg_table_name = 'patient_diary_entries' then v_row->>'entry_id'
      when tg_table_name = 'patient_check_ins' then v_row->>'check_in_id'
      when tg_table_name = 'patient_progress_photos' then v_row->>'photo_id'
      else (v_row->>'source') || ':' || (v_row->>'source_id') end;
  insert into analytics_events(event_name, occurred_at, provider_id, patient_id, source, properties, dedupe_key)
  values (v_event, now(), v_provider, (v_row->>'patient_id')::uuid, 'database_trigger',
    jsonb_build_object('date', v_date, 'source', case when tg_table_name = 'patient_health_measurements' then v_row->>'source' else tg_table_name end), v_key)
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;
revoke all on function public.capture_patient_analytics_event() from public, anon, authenticated;
