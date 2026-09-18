-- Per-feature app activity events, hourly rollups, and the HQ Insights read.
--
-- Presence only says "this patient used the app on this local day"; nothing
-- records WHEN in the day patients log food, weigh in, or message the coach,
-- so "when do patients use the app" and "how is food logging trending" were
-- unanswerable. This migration adds:
--
--   * patient_app_events          One row per tracked patient action: the
--                                 feature, the instant, the patient's LOCAL
--                                 day / weekday / hour (profile timezone at
--                                 the time of the write, UTC as the documented
--                                 fallback), the reporting platform, and the
--                                 office. Written at each feature's server
--                                 write seam through patient_app_event_record
--                                 (and by the presence touch for app opens).
--                                 Backfilled rows carry a source_key so the
--                                 backfill is idempotent; rows whose hour is
--                                 unknowable (daily-only sources) store
--                                 local_hour = -1 and count in totals but never
--                                 in the heatmap. Raw events are kept forever
--                                 (purge removes a deleted patient's rows).
--   * patient_app_event_days      One row per local day with a dirty flag:
--                                 every event insert / delete marks its day
--                                 dirty (trigger). The rollup job recomputes
--                                 dirty days; a day that is clean AND closed
--                                 in every timezone is finalized.
--   * patient_app_event_rollups   Per (local day, local hour, office, feature):
--                                 event count and distinct patients. The read
--                                 serves clean days from here and dirty days
--                                 (today, plus anything touched since the last
--                                 run) from the raw rows, so figures are exact
--                                 without scanning history.
--   * patient_app_event_record    Service-role insert for the API helper.
--   * patient_app_events_rollup   Recompute dirty days (dry-run neutral).
--   * patient_app_event_insights  Rollups + raw tail for one feature, range,
--                                 and optional office.
--   * patient_app_event_bounds    First day / first hourly day / first live
--                                 instant per feature (the "tracked since"
--                                 line and the backfill boundary).
--   * patient_app_events_backfill One-time, batched, idempotent seed from the
--                                 tables that already carry timestamps.
--
-- The events table carries patient_id, so it joins the identity write-guard
-- protocol (installer re-run at the end) and is swept by patient_purge_rows.
-- Rollups carry no patient reference; the delete trigger marks the purged
-- patient's days dirty so the next run drops their counts too.

-- ── Events ──────────────────────────────────────────────────────────────────

create table if not exists public.patient_app_events (
  id bigint generated always as identity primary key,
  patient_id uuid not null references public.patients(id) on delete cascade,
  provider_id text not null references public.providers(provider_id),
  feature text not null
    check (feature in ('app_open', 'food_log', 'water_log', 'weigh_in', 'progress_photo',
                       'coach_message', 'care_team_message', 'medication_log', 'order')),
  occurred_at timestamptz not null default now(),
  -- The patient's local calendar day / weekday (0 = Sunday .. 6 = Saturday)
  -- / hour at occurred_at. local_hour = -1 when the source only knew the day.
  local_day date not null,
  local_weekday smallint not null check (local_weekday between 0 and 6),
  local_hour smallint not null check (local_hour between -1 and 23),
  platform text not null default 'unknown'
    check (platform in ('ios', 'android', 'web', 'unknown')),
  source text not null default 'live' check (source in ('live', 'backfill')),
  -- Natural key of the backfilled source row; null for live events.
  source_key text check (source_key is null or char_length(source_key) between 1 and 200)
);
comment on table public.patient_app_events is
  'One row per tracked patient app action (feature, instant, patient-local day/weekday/hour, platform, office). Service-role only; written at the API write seams and by the one-time backfill.';
create unique index if not exists patient_app_events_source_key_idx
  on public.patient_app_events (feature, source_key) where source_key is not null;
create index if not exists patient_app_events_day_idx
  on public.patient_app_events (local_day, provider_id, feature);
create index if not exists patient_app_events_feature_idx
  on public.patient_app_events (feature, provider_id, local_day);
create index if not exists patient_app_events_patient_idx
  on public.patient_app_events (patient_id);
alter table public.patient_app_events enable row level security;
revoke all on public.patient_app_events from public, anon, authenticated;
grant all on public.patient_app_events to service_role;
revoke all on sequence public.patient_app_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.patient_app_events_id_seq to service_role;

-- ── Day state (watermark) ───────────────────────────────────────────────────

create table if not exists public.patient_app_event_days (
  local_day date primary key,
  dirty boolean not null default true,
  rolled_at timestamptz,
  finalized_at timestamptz
);
comment on table public.patient_app_event_days is
  'Rollup watermark per patient-local day: dirty = raw events changed since the last rollup; finalized_at = last recompute after the day closed in every timezone.';
alter table public.patient_app_event_days enable row level security;
revoke all on public.patient_app_event_days from public, anon, authenticated;
grant all on public.patient_app_event_days to service_role;

create or replace function private.patient_app_event_mark_dirty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := case when tg_op = 'DELETE' then old.local_day else new.local_day end;
begin
  insert into public.patient_app_event_days as d (local_day, dirty)
  values (v_day, true)
  on conflict (local_day) do update set dirty = true where d.dirty = false;
  if tg_op = 'UPDATE' and old.local_day <> new.local_day then
    insert into public.patient_app_event_days as d (local_day, dirty)
    values (old.local_day, true)
    on conflict (local_day) do update set dirty = true where d.dirty = false;
  end if;
  return null;
end;
$$;
drop trigger if exists patient_app_event_mark_dirty on public.patient_app_events;
create trigger patient_app_event_mark_dirty
  after insert or update or delete on public.patient_app_events
  for each row execute function private.patient_app_event_mark_dirty();

-- ── Rollups ─────────────────────────────────────────────────────────────────

create table if not exists public.patient_app_event_rollups (
  local_day date not null,
  local_hour smallint not null check (local_hour between -1 and 23),
  provider_id text not null references public.providers(provider_id),
  feature text not null,
  events integer not null check (events >= 0),
  patients integer not null check (patients >= 0),
  rolled_at timestamptz not null default now(),
  primary key (local_day, local_hour, provider_id, feature)
);
comment on table public.patient_app_event_rollups is
  'Hourly per-office per-feature counts of patient_app_events for clean (rolled) days: event count and distinct patients. Recomputed per day by the app-events-rollup job.';
create index if not exists patient_app_event_rollups_feature_idx
  on public.patient_app_event_rollups (feature, provider_id, local_day);
alter table public.patient_app_event_rollups enable row level security;
revoke all on public.patient_app_event_rollups from public, anon, authenticated;
grant all on public.patient_app_event_rollups to service_role;

-- ── Record ──────────────────────────────────────────────────────────────────
--
-- Resolves the patient's office and effective timezone server-side; callers
-- pass only the patient, the feature, the platform, and (optionally) the
-- instant and a count (one row per counted action, e.g. a multi-entry meal
-- save). Unknown or archived patients are rejected.

create or replace function public.patient_app_event_record(
  p_patient_id uuid,
  p_feature text,
  p_platform text default 'unknown',
  p_at timestamptz default now(),
  p_count integer default 1
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if v_count = 0 then return 0; end if;
  select p.provider_id, public.patient_effective_timezone(p.timezone) into v_provider, v_zone
  from patients p
  where p.id = p_patient_id and p.archived_at is null;
  if not found then raise exception 'unknown patient'; end if;
  v_local := v_at at time zone v_zone;
  insert into patient_app_events (patient_id, provider_id, feature, occurred_at, local_day, local_weekday, local_hour, platform, source)
  select p_patient_id, v_provider, p_feature, v_at, v_local::date,
         extract(dow from v_local)::smallint, extract(hour from v_local)::smallint, v_platform, 'live'
  from generate_series(1, v_count);
  return v_count;
end;
$$;
revoke all on function public.patient_app_event_record(uuid, text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.patient_app_event_record(uuid, text, text, timestamptz, integer) to service_role;

-- App opens ride the presence touch: every (throttled) heartbeat that lands
-- is one app_open event, in the same transaction as the presence row.
create or replace function public.patient_app_presence_touch(
  p_patient_id uuid,
  p_platform text default 'unknown',
  p_at timestamptz default now()
) returns table (local_day date, first_touch_today boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_zone text;
  v_day date;
  v_platform text := case when p_platform in ('ios', 'android', 'web') then p_platform else 'unknown' end;
  v_at timestamptz := coalesce(p_at, now());
  v_inserted boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select public.patient_effective_timezone(p.timezone) into v_zone
  from patients p
  where p.id = p_patient_id and p.archived_at is null;
  if not found then raise exception 'unknown patient'; end if;
  v_day := (v_at at time zone v_zone)::date;
  insert into patient_app_presence as a (patient_id, day, first_seen_at, last_seen_at, platform)
  values (p_patient_id, v_day, v_at, v_at, v_platform)
  on conflict (patient_id, day) do update
    set first_seen_at = least(a.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(a.last_seen_at, excluded.last_seen_at),
        platform = excluded.platform,
        touches = a.touches + 1
  returning (xmax = 0) into v_inserted;
  perform public.patient_app_event_record(p_patient_id, 'app_open', v_platform, v_at, 1);
  return query select v_day, v_inserted;
end;
$$;

-- ── Rollup ──────────────────────────────────────────────────────────────────
--
-- Recomputes every dirty day: the day is marked clean FIRST (a concurrent
-- insert then blocks on the row until this transaction commits and re-dirties
-- it), its rollups are replaced from the raw rows, and — once the day has
-- closed in every timezone (two UTC days back covers UTC-12 plus a day of
-- slack) — it is stamped finalized. Dry runs report the same figures and
-- write nothing.

create or replace function public.patient_app_events_rollup(
  p_now timestamptz default now(),
  p_dry_run boolean default false,
  p_max_days integer default 400
) returns table (days_rolled integer, events_rolled bigint, days_finalized integer, dirty_remaining integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_closed_before date := (v_now at time zone 'UTC')::date - 1;
  v_day record;
  v_events bigint;
  v_days integer := 0;
  v_total bigint := 0;
  v_finalized integer := 0;
  v_remaining integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  for v_day in
    select d.local_day from patient_app_event_days d
    where d.dirty
    order by d.local_day
    limit greatest(coalesce(p_max_days, 400), 1)
  loop
    if p_dry_run then
      select count(*) into v_events from patient_app_events e where e.local_day = v_day.local_day;
    else
      update patient_app_event_days d set dirty = false, rolled_at = v_now,
        finalized_at = case when v_day.local_day < v_closed_before then v_now else d.finalized_at end
      where d.local_day = v_day.local_day;
      delete from patient_app_event_rollups r where r.local_day = v_day.local_day;
      insert into patient_app_event_rollups (local_day, local_hour, provider_id, feature, events, patients, rolled_at)
      select e.local_day, e.local_hour, e.provider_id, e.feature, count(*)::integer, count(distinct e.patient_id)::integer, v_now
      from patient_app_events e
      where e.local_day = v_day.local_day
      group by e.local_day, e.local_hour, e.provider_id, e.feature;
      select coalesce(sum(r.events), 0) into v_events from patient_app_event_rollups r where r.local_day = v_day.local_day;
    end if;
    v_days := v_days + 1;
    v_total := v_total + v_events;
    if v_day.local_day < v_closed_before then v_finalized := v_finalized + 1; end if;
  end loop;
  select count(*)::integer into v_remaining from patient_app_event_days d where d.dirty;
  return query select v_days, v_total, v_finalized, v_remaining;
end;
$$;
revoke all on function public.patient_app_events_rollup(timestamptz, boolean, integer) from public, anon, authenticated;
grant execute on function public.patient_app_events_rollup(timestamptz, boolean, integer) to service_role;

-- ── Insights read ───────────────────────────────────────────────────────────
--
-- Clean days come from the rollups, dirty days from the raw rows, so the
-- result always equals a fresh aggregate over patient_app_events. Enabled
-- offices only (matching the app-usage aggregates); p_provider_id narrows to
-- one office. local_hour -1 rows are day-only backfill: they count toward the
-- daily series, never the heatmap.

create or replace function public.patient_app_event_insights(
  p_feature text,
  p_start date,
  p_end date,
  p_provider_id text default null
) returns table (local_day date, local_hour smallint, events bigint, patients bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_start is null or p_end is null or p_start > p_end or p_end - p_start > 800 then raise exception 'invalid range'; end if;
  return query
  with offices as (
    select pr.provider_id
    from providers pr
    where coalesce(pr.access_disabled, false) = false
      and (p_provider_id is null or pr.provider_id = p_provider_id)
  ), clean_days as (
    select d.local_day from patient_app_event_days d
    where d.local_day between p_start and p_end and d.dirty = false
  ), rolled as (
    select r.local_day, r.local_hour, sum(r.events)::bigint as events, sum(r.patients)::bigint as patients
    from patient_app_event_rollups r
    join offices o on o.provider_id = r.provider_id
    join clean_days c on c.local_day = r.local_day
    where r.feature = p_feature
    group by r.local_day, r.local_hour
  ), raw as (
    select e.local_day, e.local_hour, count(*)::bigint as events, count(distinct e.patient_id)::bigint as patients
    from patient_app_events e
    join offices o on o.provider_id = e.provider_id
    where e.feature = p_feature
      and e.local_day between p_start and p_end
      and not exists (select 1 from clean_days c where c.local_day = e.local_day)
    group by e.local_day, e.local_hour
  )
  select u.local_day, u.local_hour, u.events, u.patients
  from (select * from rolled union all select * from raw) u
  order by u.local_day, u.local_hour;
end;
$$;
revoke all on function public.patient_app_event_insights(text, date, date, text) from public, anon, authenticated;
grant execute on function public.patient_app_event_insights(text, date, date, text) to service_role;

create or replace function public.patient_app_event_bounds(
  p_feature text,
  p_provider_id text default null
) returns table (first_day date, first_hourly_day date, first_live_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  return query
  select min(e.local_day),
         min(e.local_day) filter (where e.local_hour >= 0),
         min(e.occurred_at) filter (where e.source = 'live')
  from patient_app_events e
  join providers pr on pr.provider_id = e.provider_id
  where e.feature = p_feature
    and coalesce(pr.access_disabled, false) = false
    and (p_provider_id is null or e.provider_id = p_provider_id);
end;
$$;
revoke all on function public.patient_app_event_bounds(text, text) from public, anon, authenticated;
grant execute on function public.patient_app_event_bounds(text, text) to service_role;

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Seeds events for one feature from the table that already records it, for
-- source rows before p_before (the first live event, so a live row and its
-- backfilled twin never both count). Idempotent: every row carries a natural
-- source_key and rows already present are skipped, so re-runs and partial
-- batches are safe. Real-account, non-archived patients only. Sources with a
-- true timestamp get their local hour; day-only sources (water days, presence
-- days) store local_hour = -1.

create or replace function public.patient_app_events_backfill(
  p_feature text,
  p_before timestamptz,
  p_limit integer default 2000,
  p_dry_run boolean default false
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 20000);
  v_before timestamptz := coalesce(p_before, now());
  v_before_day date := (v_before at time zone 'UTC')::date - 1;
  v_sql text;
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  create temp table if not exists app_event_backfill_candidates (
    patient_id uuid, provider_id text, occurred_at timestamptz, local_day date, local_hour smallint, platform text, source_key text
  ) on commit drop;
  truncate app_event_backfill_candidates;
  v_sql := case p_feature
    when 'app_open' then $q$
      select a.patient_id, p.provider_id, a.first_seen_at, a.day, -1::smallint, a.platform, a.patient_id::text || ':' || a.day::text
      from patient_app_presence a join patients p on p.id = a.patient_id
      where a.day <= $2 $q$
    when 'food_log' then $q$
      select d.patient_id, p.provider_id, d.created_at, (d.created_at at time zone z.zone)::date,
             extract(hour from d.created_at at time zone z.zone)::smallint, 'unknown', d.patient_id::text || ':' || d.entry_id
      from patient_diary_entries d join patients p on p.id = d.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where d.created_at < $1 $q$
    when 'water_log' then $q$
      select w.patient_id, p.provider_id, (w.date_key::timestamp + interval '12 hours') at time zone z.zone, w.date_key, -1::smallint, 'unknown',
             w.patient_id::text || ':' || w.date_key::text
      from patient_water_days w join patients p on p.id = w.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where w.date_key <= $2 and w.oz > 0 $q$
    when 'weigh_in' then $q$
      select c.patient_id, p.provider_id, c.created_at, (c.created_at at time zone z.zone)::date,
             extract(hour from c.created_at at time zone z.zone)::smallint, 'unknown', c.patient_id::text || ':' || c.check_in_id
      from patient_check_ins c join patients p on p.id = c.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where c.weight is not null and c.created_at < $1 $q$
    when 'progress_photo' then $q$
      select x.patient_id, p.provider_id, x.created_at, (x.created_at at time zone z.zone)::date,
             extract(hour from x.created_at at time zone z.zone)::smallint, 'unknown', x.patient_id::text || ':' || x.photo_id
      from patient_progress_photos x join patients p on p.id = x.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where x.created_at < $1 $q$
    when 'coach_message' then $q$
      select cv.patient_id, p.provider_id, m.created_at, (m.created_at at time zone z.zone)::date,
             extract(hour from m.created_at at time zone z.zone)::smallint, 'unknown', m.conversation_id::text || ':' || m.client_id
      from patient_chat_messages m join patient_chat_conversations cv on cv.id = m.conversation_id
      join patients p on p.id = cv.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where cv.thread = 'coach' and m.role = 'user' and m.created_at < $1 $q$
    when 'care_team_message' then $q$
      select cv.patient_id, p.provider_id, m.created_at, (m.created_at at time zone z.zone)::date,
             extract(hour from m.created_at at time zone z.zone)::smallint, 'unknown', m.conversation_id::text || ':' || m.client_id
      from patient_chat_messages m join patient_chat_conversations cv on cv.id = m.conversation_id
      join patients p on p.id = cv.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where cv.thread = 'care_team' and m.role = 'user' and m.created_at < $1 $q$
    when 'medication_log' then $q$
      select l.patient_id, p.provider_id, l.logged_at, (l.logged_at at time zone z.zone)::date,
             extract(hour from l.logged_at at time zone z.zone)::smallint, 'unknown', l.id::text
      from patient_medication_dose_logs l join patients p on p.id = l.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where l.logged_at < $1 $q$
    when 'order' then $q$
      select o.patient_id, p.provider_id, o.paid_at, (o.paid_at at time zone z.zone)::date,
             extract(hour from o.paid_at at time zone z.zone)::smallint, 'unknown', o.id::text
      from billing_orders o join patients p on p.id = o.patient_id
      cross join lateral (select public.patient_effective_timezone(p.timezone) as zone) z
      where o.patient_id is not null and o.paid_at is not null
        and o.status in ('paid', 'refunded', 'partially_refunded', 'disputed') and o.paid_at < $1 $q$
    else null
  end;
  if v_sql is null then raise exception 'unknown feature %', p_feature; end if;
  execute format(
    'insert into app_event_backfill_candidates (patient_id, provider_id, occurred_at, local_day, local_hour, platform, source_key)
     select s.* from (%s) as s(patient_id, provider_id, occurred_at, local_day, local_hour, platform, source_key)
     join patients p on p.id = s.patient_id
     where p.auth_user_id is not null and p.archived_at is null
       and not exists (select 1 from patient_app_events e where e.feature = %L and e.source_key = s.source_key)
     order by s.occurred_at
     limit %s', v_sql, p_feature, v_limit)
  using v_before, v_before_day;
  get diagnostics v_count = row_count;
  if p_dry_run then return v_count; end if;
  insert into patient_app_events (patient_id, provider_id, feature, occurred_at, local_day, local_weekday, local_hour, platform, source, source_key)
  select c.patient_id, c.provider_id, p_feature, c.occurred_at, c.local_day, extract(dow from c.local_day)::smallint, c.local_hour,
         case when c.platform in ('ios', 'android', 'web') then c.platform else 'unknown' end, 'backfill', c.source_key
  from app_event_backfill_candidates c
  on conflict (feature, source_key) where source_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.patient_app_events_backfill(text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.patient_app_events_backfill(text, timestamptz, integer, boolean) to service_role;

-- ── Identity write guard ────────────────────────────────────────────────────

select private.install_patient_identity_write_guards();

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.patient_app_events'::regclass
      and t.tgname = 'patient_identity_write_guard'
      and not t.tgisinternal
  ) then
    raise exception 'patient identity write guard missing from patient_app_events';
  end if;
end;
$$;
