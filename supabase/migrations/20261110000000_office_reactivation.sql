-- Office reactivation: an offboarded office that renews before its sealed
-- charts reach their retain-until date can come back. HQ clears the
-- offboarding status, re-enables staff sign-in and reopens every chart the
-- offboarding sealed. Reopening is refused as a whole once any chart of that
-- offboarding was destroyed (a tombstone exists) or has lapsed past its
-- retention date: a partial office is not an office. Reopened charts keep
-- their clinical record but their login was retired at closure, so patients
-- re-enroll through the office's invite flow.

alter table public.patients
  add column if not exists reopened_at timestamptz;
comment on column public.patients.reopened_at is
  'Set when an office reactivation reopened this sealed chart. The login retired at closure is not restored; the patient re-enrolls through the office.';

alter table public.provider_offboardings
  add column if not exists reactivated_at timestamptz,
  add column if not exists reactivated_by uuid,
  add column if not exists reactivated_charts integer;
comment on column public.provider_offboardings.reactivated_at is
  'Set when HQ reactivated the office after this offboarding completed. The next offboarding start resets the row.';

-- What a reactivation would find for the charts sealed since p_since (the
-- seal start of the offboarding): how many are still sealed and reopenable,
-- how many have lapsed (retention passed or a purge is under way), how many
-- were destroyed (tombstones whose request dates from the seal), and the
-- earliest retain-until among the sealed charts.
create or replace function public.office_reactivation_preview(p_provider_id text, p_since timestamptz)
returns table (reopenable bigint, lapsed bigint, destroyed bigint, earliest_retain_until timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  with charts as (
    select p.id, p.record_retain_until,
      (select r.status from patient_deletion_requests r
        where r.patient_id = p.id
        order by r.requested_at desc limit 1) as request_status
    from patients p
    where p.provider_id = p_provider_id
      and p.closed_at is not null
      and p.closed_at >= coalesce(p_since, '-infinity'::timestamptz)
  ),
  judged as (
    select c.id, c.record_retain_until,
      (c.request_status in ('purging', 'purged')
        or (c.record_retain_until is not null and c.record_retain_until <= now())) as has_lapsed
    from charts c
  )
  select
    (select count(*) from judged j where not j.has_lapsed)::bigint as reopenable,
    (select count(*) from judged j where j.has_lapsed)::bigint as lapsed,
    (select count(*) from patient_tombstones t
      where t.provider_id = p_provider_id
        and t.requested_at >= coalesce(p_since, '-infinity'::timestamptz))::bigint as destroyed,
    (select min(j.record_retain_until) from judged j) as earliest_retain_until;
$$;
revoke all on function public.office_reactivation_preview(text, timestamptz) from public, anon, authenticated;
grant execute on function public.office_reactivation_preview(text, timestamptz) to service_role;

-- Reopen every chart sealed since p_since, all or nothing. Refuses (returns
-- reopened = 0 with the counts) when any chart was destroyed or lapsed. Each
-- chart is reopened under the same advisory lock the purge takes, and its
-- closure request is re-checked under a row lock so a purge that claimed the
-- chart in the meantime aborts the whole reactivation instead of racing it.
-- The closure request stays as a cancelled row (cancelled + closed_at) so the
-- patient identity gate can tell "reopened by the office" from "closed".
create or replace function public.office_reactivate_charts(p_provider_id text, p_since timestamptz)
returns table (reopened bigint, lapsed bigint, destroyed bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview record;
  v_chart record;
  v_request record;
  v_reopened bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  perform 1 from providers where provider_id = p_provider_id for update;
  if not found then raise exception 'unknown office'; end if;
  select * into v_preview from public.office_reactivation_preview(p_provider_id, p_since);
  if v_preview.destroyed > 0 or v_preview.lapsed > 0 then
    return query select 0::bigint, v_preview.lapsed, v_preview.destroyed;
    return;
  end if;
  for v_chart in
    select p.id
    from patients p
    where p.provider_id = p_provider_id
      and p.closed_at is not null
      and p.closed_at >= coalesce(p_since, '-infinity'::timestamptz)
    order by p.created_at asc, p.id asc
    for update of p
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_chart.id::text, 40421001));
    for v_request in
      select r.id, r.status
      from patient_deletion_requests r
      where r.patient_id = v_chart.id
        and r.status in ('pending', 'held', 'closing', 'closed', 'purging', 'failed')
      for update
    loop
      if v_request.status = 'purging' then
        raise exception 'chart % is being destroyed', v_chart.id;
      end if;
      update patient_deletion_requests
      set status = 'cancelled', cancelled_at = now(), held_at = null,
          lease_owner = null, lease_until = null, next_attempt_at = null
      where id = v_request.id;
    end loop;
    update patients
    set closed_at = null,
        archived_at = null,
        record_retain_until = null,
        deletion_requested_at = null,
        reopened_at = now()
    where id = v_chart.id;
    v_reopened := v_reopened + 1;
  end loop;
  return query select v_reopened, 0::bigint, 0::bigint;
end;
$$;
revoke all on function public.office_reactivate_charts(text, timestamptz) from public, anon, authenticated;
grant execute on function public.office_reactivate_charts(text, timestamptz) to service_role;
