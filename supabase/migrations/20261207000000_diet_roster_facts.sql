-- Diet facts for staff surfaces: the office roster, HQ reporting and the
-- per-entry "fits the diet" verdict the patient app records at log time.
--
-- The roster and the HQ rollup need per-patient diet facts across tables that
-- carry no provider_id (selections, blocks, preference items join through
-- patients). Two service-role RPCs do that join once per request instead of
-- one PostgREST round trip per table per patient.

-- ── Per-entry fit verdict ───────────────────────────────────────────────────
-- Written by the patient app alongside the entry (the shared classifier runs
-- on the device against the patient's lists and the diet's fit rules). Null =
-- the app did not say; "unknown" = it looked and could not tell. The roster
-- percentage counts only fits / does_not_fit, so a patient with no verdicts
-- reads as unknown, never as 0 %.
alter table public.patient_diary_entries
  add column if not exists fit_verdict text
  check (fit_verdict is null or fit_verdict in ('fits', 'does_not_fit', 'unknown'));
comment on column public.patient_diary_entries.fit_verdict is
  'Whether the logged food fit the diet in force when it was logged (fits / does_not_fit / unknown); null when the app recorded no verdict.';

-- ── Office roster facts ─────────────────────────────────────────────────────
-- One row per live patient of the office that has ANY diet fact (an active
-- or pending selection, a severe allergy, or a verdict-bearing entry in the
-- window). Patients without a row are "no diet / no facts" for the roster.
drop function if exists public.provider_patient_diet_facts(text, timestamptz);
create function public.provider_patient_diet_facts(p_provider_id text, p_at timestamptz)
returns table (
  patient_id uuid,
  diet_slug text,
  diet_name text,
  diet_started_at timestamptz,
  pending_block_id uuid,
  pending_block_created_at timestamptz,
  severe_allergy boolean,
  fit_count bigint,
  fit_total bigint,
  fit_window_days integer
)
language sql stable set search_path = public, pg_temp
as $$
  with window_start as (select ((p_at at time zone 'UTC')::date - 13) as day)
  select
    p.id as patient_id,
    s.diet_slug,
    l.name as diet_name,
    s.started_at as diet_started_at,
    b.id as pending_block_id,
    b.created_at as pending_block_created_at,
    exists (
      select 1 from public.patient_preference_items i
      where i.patient_id = p.id and i.removed_at is null and i.list = 'allergy' and i.severity = 'severe'
    ) as severe_allergy,
    coalesce(f.fit_count, 0)::bigint as fit_count,
    coalesce(f.fit_total, 0)::bigint as fit_total,
    14 as fit_window_days
  from public.patients p
  left join public.patient_diet_selections s on s.patient_id = p.id and s.status = 'active'
  left join public.diet_library_entries l on l.slug = s.diet_slug
  left join lateral (
    select x.id, x.created_at from public.patient_diet_blocks x
    where x.patient_id = p.id and x.status = 'pending'
    order by x.created_at desc limit 1
  ) b on true
  left join lateral (
    select
      count(*) filter (where e.fit_verdict = 'fits')::bigint as fit_count,
      count(*) filter (where e.fit_verdict in ('fits', 'does_not_fit'))::bigint as fit_total
    from public.patient_diary_entries e, window_start w
    where e.patient_id = p.id and e.date_key >= w.day and e.date_key <= ((p_at at time zone 'UTC')::date)
  ) f on true
  where p.provider_id = p_provider_id
    and p.archived_at is null
    and (s.id is not null or b.id is not null or coalesce(f.fit_total, 0) > 0
         or exists (select 1 from public.patient_preference_items i
                     where i.patient_id = p.id and i.removed_at is null and i.list = 'allergy' and i.severity = 'severe'));
$$;
revoke all on function public.provider_patient_diet_facts(text, timestamptz) from public, anon, authenticated;
grant execute on function public.provider_patient_diet_facts(text, timestamptz) to service_role;

-- ── HQ diets & restrictions rollup ──────────────────────────────────────────
-- Flat facts for the reporting page. Phase is derived in the API (one shared
-- rule in lib/diet-programs), so the RPC returns the inputs, not the verdict.
-- p_provider_id null = whole network. Range filters apply to the event
-- series (changes, blocks, overrides, screening answers); the standing
-- counts (active diets, lists, pregnancy conflicts) are "as of now".
drop function if exists public.hq_diet_restrictions_facts(date, date, text);
create function public.hq_diet_restrictions_facts(p_from date, p_to date, p_provider_id text default null)
returns jsonb
language sql stable set search_path = public, pg_temp
as $$
  with live as (
    select p.id, p.provider_id, p.program_id, p.program_start_date, p.created_at, p.activation_status
    from public.patients p
    where p.archived_at is null
      and p.activation_status = 'activated'
      and p.closed_at is null
      and (p_provider_id is null or p.provider_id = p_provider_id)
  ),
  patient_rows as (
    select
      lp.id as patient_id, lp.provider_id, lp.program_id,
      coalesce(ep.started_on, lp.program_start_date, lp.created_at::date) as episode_started_on,
      s.diet_slug, l.name as diet_name, l.pregnancy_blocked,
      exists (select 1 from public.patient_diet_blocks x where x.patient_id = lp.id and x.status = 'pending') as pending_block,
      exists (select 1 from public.patient_preference_items i where i.patient_id = lp.id and i.removed_at is null and i.list = 'allergy' and i.severity = 'severe') as severe_allergy,
      (select a.answer from public.patient_screening_answers a where a.patient_id = lp.id and a.question = 'pregnancy' order by a.created_at desc limit 1) as pregnancy_answer
    from live lp
    left join public.patient_protocol_episodes ep on ep.patient_id = lp.id and ep.ended_on is null
    left join public.patient_diet_selections s on s.patient_id = lp.id and s.status = 'active'
    left join public.diet_library_entries l on l.slug = s.diet_slug
  ),
  items as (
    select i.list, i.item_key, i.label, i.severity, count(distinct i.patient_id)::bigint as patients
    from public.patient_preference_items i
    join live lp on lp.id = i.patient_id
    where i.removed_at is null
    group by i.list, i.item_key, i.label, i.severity
  ),
  changes as (
    select s.selected_by_role, count(*)::bigint as n
    from public.patient_diet_selections s
    join live lp on lp.id = s.patient_id
    where s.status in ('active', 'superseded')
      and s.started_at >= p_from::timestamptz
      and s.started_at < (p_to + 1)::timestamptz
    group by s.selected_by_role
  ),
  blocks as (
    select
      count(*) filter (where x.created_at >= p_from::timestamptz and x.created_at < (p_to + 1)::timestamptz)::bigint as created,
      count(*) filter (where x.status = 'pending')::bigint as pending,
      count(*) filter (where x.status = 'overridden' and x.reviewed_at >= p_from::timestamptz and x.reviewed_at < (p_to + 1)::timestamptz)::bigint as overridden,
      count(*) filter (where x.status = 'rejected' and x.reviewed_at >= p_from::timestamptz and x.reviewed_at < (p_to + 1)::timestamptz)::bigint as rejected
    from public.patient_diet_blocks x
    join live lp on lp.id = x.patient_id
  ),
  screening as (
    select a.question, a.answer, count(*)::bigint as n
    from public.patient_screening_answers a
    join live lp on lp.id = a.patient_id
    where a.created_at >= p_from::timestamptz and a.created_at < (p_to + 1)::timestamptz
    group by a.question, a.answer
  ),
  offices as (
    select pr.provider_id, coalesce(nullif(pr.office_name, ''), pr.provider_name) as provider_name
    from public.providers pr
    where (p_provider_id is null or pr.provider_id = p_provider_id)
      and exists (select 1 from live lp where lp.provider_id = pr.provider_id)
  )
  select jsonb_build_object(
    'patients', coalesce((select jsonb_agg(jsonb_build_object(
        'patientId', r.patient_id, 'providerId', r.provider_id, 'programId', r.program_id,
        'episodeStartedOn', r.episode_started_on, 'dietSlug', r.diet_slug, 'dietName', r.diet_name,
        'pendingBlock', r.pending_block, 'severeAllergy', r.severe_allergy,
        'pregnancyConflict', (r.pregnancy_answer = 'yes' and coalesce(r.pregnancy_blocked, false))
      )) from patient_rows r), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'list', i.list, 'key', i.item_key, 'label', i.label, 'severity', i.severity, 'patients', i.patients
      ) order by i.patients desc, i.label) from items i), '[]'::jsonb),
    'changes', coalesce((select jsonb_object_agg(c.selected_by_role, c.n) from changes c), '{}'::jsonb),
    'blocks', (select to_jsonb(b) from blocks b),
    'screening', coalesce((select jsonb_agg(jsonb_build_object('question', s.question, 'answer', s.answer, 'count', s.n)) from screening s), '[]'::jsonb),
    'offices', coalesce((select jsonb_agg(jsonb_build_object('providerId', o.provider_id, 'name', o.provider_name) order by o.provider_name) from offices o), '[]'::jsonb)
  );
$$;
revoke all on function public.hq_diet_restrictions_facts(date, date, text) from public, anon, authenticated;
grant execute on function public.hq_diet_restrictions_facts(date, date, text) to service_role;
