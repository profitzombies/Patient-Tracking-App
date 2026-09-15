-- Remove patient-identifying staff alert snapshots during patient erasure and
-- apply the notification-history retention window to staff alert history.

create or replace function public.staff_attention_scrub_patient(p_patient_id uuid)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_digest_rows integer := 0;
  v_notification_rows integer := 0;
begin
  if p_patient_id is null then raise exception 'patient id is required'; end if;

  with scrubbed as (
    select d.id,
      coalesce(jsonb_agg(item) filter (where item->>'patientId' is distinct from p_patient_id::text), '[]'::jsonb) as items
    from public.office_attention_digests d
    cross join lateral jsonb_array_elements(d.items) item
    where d.items @> jsonb_build_array(jsonb_build_object('patientId', p_patient_id::text))
    group by d.id
  )
  update public.office_attention_digests d
     set items = s.items,
         flagged_count = jsonb_array_length(s.items)
    from scrubbed s
   where d.id = s.id;
  get diagnostics v_digest_rows = row_count;

  with scrubbed as (
    select n.id,
      coalesce(jsonb_agg(item) filter (where item->>'patientId' is distinct from p_patient_id::text), '[]'::jsonb) as patients
    from public.staff_notifications n
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(n.data->'patients') = 'array' then n.data->'patients' else '[]'::jsonb end
    ) item
    where n.data->'patients' @> jsonb_build_array(jsonb_build_object('patientId', p_patient_id::text))
    group by n.id
  )
  update public.staff_notifications n
     set data = jsonb_set(n.data, '{patients}', s.patients, true),
         updated_at = now()
    from scrubbed s
   where n.id = s.id;
  get diagnostics v_notification_rows = row_count;

  return jsonb_build_object(
    'digestRowsUpdated', v_digest_rows,
    'notificationRowsUpdated', v_notification_rows
  );
end;
$$;
revoke all on function public.staff_attention_scrub_patient(uuid) from public, anon, authenticated;
grant execute on function public.staff_attention_scrub_patient(uuid) to service_role;

create or replace function public.staff_attention_scrub_deleted_patient()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.staff_attention_scrub_patient(old.id);
  return old;
end;
$$;
revoke all on function public.staff_attention_scrub_deleted_patient() from public, anon, authenticated;
grant execute on function public.staff_attention_scrub_deleted_patient() to service_role;

drop trigger if exists patients_staff_attention_scrub on public.patients;
create trigger patients_staff_attention_scrub
after delete on public.patients
for each row execute function public.staff_attention_scrub_deleted_patient();

create or replace function public.retention_trim_staff_alerts(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_notification_ids uuid[];
  v_digest_ids uuid[];
  v_count integer := 0;
begin
  if p_cutoff is null then raise exception 'cutoff is required'; end if;

  with due as (
    select kind, id from (
      select 'notification'::text as kind, n.id, coalesce(n.finalized_at, n.scheduled_at) as due_at
      from public.staff_notifications n
      where n.status not in ('queued', 'sending')
        and coalesce(n.finalized_at, n.scheduled_at) < p_cutoff
      union all
      select 'digest'::text, d.id, d.generated_at
      from public.office_attention_digests d
      where d.generated_at < p_cutoff
    ) candidates
    order by due_at, id
    limit greatest(coalesce(p_limit, 1000), 1)
  )
  select
    coalesce(array_agg(id) filter (where kind = 'notification'), array[]::uuid[]),
    coalesce(array_agg(id) filter (where kind = 'digest'), array[]::uuid[])
  into v_notification_ids, v_digest_ids
  from due;

  v_count := cardinality(v_notification_ids) + cardinality(v_digest_ids);
  if p_dry_run or v_count = 0 then return v_count; end if;

  delete from public.staff_notifications where id = any(v_notification_ids);
  delete from public.office_attention_digests where id = any(v_digest_ids);
  return v_count;
end;
$$;
revoke all on function public.retention_trim_staff_alerts(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_staff_alerts(timestamptz, integer, boolean) to service_role;

notify pgrst, 'reload schema';