-- Idempotent live app events: key message events by their message id.
--
-- coach_message and care_team_message events were recorded once per
-- persisted chat turn, so a client replaying a finalized transcript (the
-- app re-sends the on-screen batch after a stopped reply, a reconnect, or an
-- offline flush) counted the same patient message again. The events table
-- already has a unique (feature, source_key) index used by the backfill;
-- live writes can now carry the same natural keys and ON CONFLICT DO NOTHING,
-- so a replay inserts nothing and the RPC reports how many rows it really
-- added. Key formats match the backfill exactly:
--
--   food_log            <patient_id>:<entry_id>
--   coach_message       <conversation_id>:<client_id>
--   care_team_message   <conversation_id>:<client_id>
--
-- so a backfilled row and a live row for the same source can never coexist.
--
-- Also added:
--   * patient_app_events_dedupe   One-off, dry-run-capable repair for rows
--                                 recorded before keys existed: pairs unkeyed
--                                 live events with their source rows (same
--                                 patient, same UTC hour, oldest first),
--                                 stamps the source key on the paired event so
--                                 a later replay of that message inserts
--                                 nothing, and deletes the unpaired surplus —
--                                 the duplicates. Deleting marks the day dirty,
--                                 so the next rollup re-rolls it. Only rows at
--                                 or after the patient's oldest surviving
--                                 source row are considered, so retention
--                                 trims can never make old history look like
--                                 surplus.
--
-- patient_app_event_record gains a parameter, so the old signature is dropped
-- first (PostgREST must see exactly one overload). SECURITY DEFINER and the
-- service-role grant are restated on the new definition.

drop function if exists public.patient_app_event_record(uuid, text, text, timestamptz, integer);

create function public.patient_app_event_record(
  p_patient_id uuid,
  p_feature text,
  p_platform text default 'unknown',
  p_at timestamptz default now(),
  p_count integer default 1,
  p_source_keys text[] default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
  v_zone text;
  v_at timestamptz := coalesce(p_at, now());
  v_local timestamp;
  v_platform text := case when p_platform in ('ios', 'android', 'web') then p_platform else 'unknown' end;
  v_count integer := least(greatest(coalesce(p_count, 1), 0), 50);
  v_keys text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_source_keys is not null then
    -- Keyed mode: one row per distinct usable key, at most 50 per call.
    select coalesce(array_agg(k), array[]::text[]) into v_keys
    from (
      select distinct k from unnest(p_source_keys) as k
      where k is not null and char_length(k) between 1 and 200
      order by k
      limit 50
    ) keys;
    if coalesce(array_length(v_keys, 1), 0) = 0 then return 0; end if;
  elsif v_count = 0 then
    return 0;
  end if;
  select p.provider_id, public.patient_effective_timezone(p.timezone) into v_provider, v_zone
  from patients p
  where p.id = p_patient_id and p.archived_at is null;
  if not found then raise exception 'unknown patient'; end if;
  v_local := v_at at time zone v_zone;
  if p_source_keys is not null then
    insert into patient_app_events (patient_id, provider_id, feature, occurred_at, local_day, local_weekday, local_hour, platform, source, source_key)
    select p_patient_id, v_provider, p_feature, v_at, v_local::date,
           extract(dow from v_local)::smallint, extract(hour from v_local)::smallint, v_platform, 'live', k
    from unnest(v_keys) as k
    on conflict (feature, source_key) where source_key is not null do nothing;
    get diagnostics v_count = row_count;
    return v_count;
  end if;
  insert into patient_app_events (patient_id, provider_id, feature, occurred_at, local_day, local_weekday, local_hour, platform, source)
  select p_patient_id, v_provider, p_feature, v_at, v_local::date,
         extract(dow from v_local)::smallint, extract(hour from v_local)::smallint, v_platform, 'live'
  from generate_series(1, v_count);
  return v_count;
end;
$$;
comment on function public.patient_app_event_record(uuid, text, text, timestamptz, integer, text[]) is
  'Service-role insert for the API event helper. With p_source_keys, one row per key keyed on (feature, source_key) — replays insert nothing; returns rows actually inserted.';
revoke all on function public.patient_app_event_record(uuid, text, text, timestamptz, integer, text[]) from public, anon, authenticated;
grant execute on function public.patient_app_event_record(uuid, text, text, timestamptz, integer, text[]) to service_role;

-- ── One-off repair of rows recorded before keys existed ─────────────────────

create or replace function public.patient_app_events_dedupe(
  p_feature text,
  p_dry_run boolean default true
) returns table (keyed integer, removed integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sql text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  -- Source rows: (patient_id, occurred_at, source_key) in the live key format.
  v_sql := case p_feature
    when 'food_log' then $q$
      select d.patient_id, d.created_at, d.patient_id::text || ':' || d.entry_id
      from patient_diary_entries d $q$
    when 'coach_message' then $q$
      select cv.patient_id, m.created_at, m.conversation_id::text || ':' || m.client_id
      from patient_chat_messages m join patient_chat_conversations cv on cv.id = m.conversation_id
      where cv.thread = 'coach' and m.role = 'user' $q$
    when 'care_team_message' then $q$
      select cv.patient_id, m.created_at, m.conversation_id::text || ':' || m.client_id
      from patient_chat_messages m join patient_chat_conversations cv on cv.id = m.conversation_id
      where cv.thread = 'care_team' and m.role = 'user' $q$
    else null
  end;
  if v_sql is null then raise exception 'unsupported feature %', p_feature; end if;
  return query execute format($f$
    with src as (
      select s.patient_id, s.occurred_at, s.source_key
      from (%s) as s(patient_id, occurred_at, source_key)
    ),
    -- Per patient, nothing older than the oldest surviving source row is
    -- judged (retention may have trimmed the rows that explain older events).
    floor_at as (
      select patient_id, min(occurred_at) as since from src group by patient_id
    ),
    src_ranked as (
      select s.patient_id, date_trunc('hour', s.occurred_at) as bucket, s.source_key,
             row_number() over (partition by s.patient_id, date_trunc('hour', s.occurred_at)
                                order by s.occurred_at, s.source_key) as rn
      from src s
      where not exists (select 1 from patient_app_events e where e.feature = %L and e.source_key = s.source_key)
    ),
    ev_ranked as (
      select e.id, e.patient_id, date_trunc('hour', e.occurred_at) as bucket,
             row_number() over (partition by e.patient_id, date_trunc('hour', e.occurred_at)
                                order by e.occurred_at, e.id) as rn
      from patient_app_events e
      join floor_at f on f.patient_id = e.patient_id
      where e.feature = %L and e.source = 'live' and e.source_key is null
        and e.occurred_at >= f.since
    ),
    pairs as (
      select ev.id, s.source_key
      from ev_ranked ev
      join src_ranked s on s.patient_id = ev.patient_id and s.bucket = ev.bucket and s.rn = ev.rn
    ),
    surplus as (
      select ev.id from ev_ranked ev where not exists (select 1 from pairs p where p.id = ev.id)
    ),
    stamped as (
      update patient_app_events e set source_key = p.source_key
      from pairs p where e.id = p.id and not %L::boolean
      returning e.id
    ),
    deleted as (
      delete from patient_app_events e
      using surplus s where e.id = s.id and not %L::boolean
      returning e.id
    )
    select (select count(*) from pairs)::integer, (select count(*) from surplus)::integer
  $f$, v_sql, p_feature, p_feature, p_dry_run, p_dry_run);
end;
$$;
revoke all on function public.patient_app_events_dedupe(text, boolean) from public, anon, authenticated;
grant execute on function public.patient_app_events_dedupe(text, boolean) to service_role;
