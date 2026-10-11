-- Diet facts fixes for the staff surfaces.
--
-- 1. patient_diary_apply persists the per-entry fit verdict. The column was
--    added with the roster facts, and the API already passes `fit_verdict`
--    in every upsert row, but the RPC's recordset did not read it, so every
--    verdict was dropped and the roster's "% fits diet" could never leave
--    Unknown. Same signature and return type: replaced in place, grants
--    restated.
-- 2. hq_diet_restrictions_facts counts patients of ENABLED practices only,
--    also when p_provider_id is null (whole network), matching the office
--    route's enabled-office rule.

create or replace function public.patient_diary_apply(
  p_patient_id uuid,
  p_upsert jsonb default '[]'::jsonb,
  p_delete_ids text[] default array[]::text[],
  p_recents jsonb default null
) returns text[]
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_new text[] := array[]::text[];
begin
  with upserted as (
    insert into public.patient_diary_entries
      (patient_id, entry_id, date_key, meal, kind, ref_id, name, detail,
       quantity, calories, protein, carbs, fat, adjustments, nutrition_snapshot,
       fit_verdict, created_at, updated_at)
    select
      p_patient_id,
      r.entry_id, r.date_key, r.meal, r.kind, r.ref_id, r.name,
      coalesce(r.detail, ''), r.quantity, r.calories, r.protein, r.carbs, r.fat,
      r.adjustments, r.nutrition_snapshot, r.fit_verdict, clock_timestamp(), clock_timestamp()
    from jsonb_to_recordset(coalesce(p_upsert, '[]'::jsonb)) as r(
      entry_id text, date_key date, meal text, kind text, ref_id text,
      name text, detail text, quantity numeric, calories numeric,
      protein numeric, carbs numeric, fat numeric, adjustments jsonb,
      nutrition_snapshot jsonb, fit_verdict text
    )
    on conflict (patient_id, entry_id) do update set
      date_key = excluded.date_key,
      meal = excluded.meal,
      kind = excluded.kind,
      ref_id = excluded.ref_id,
      name = excluded.name,
      detail = excluded.detail,
      quantity = excluded.quantity,
      calories = excluded.calories,
      protein = excluded.protein,
      carbs = excluded.carbs,
      fat = excluded.fat,
      adjustments = excluded.adjustments,
      nutrition_snapshot = excluded.nutrition_snapshot,
      -- An edit re-sends the row with its verdict; a row saved without one
      -- (older app) clears it rather than keeping a verdict for a food that
      -- may have changed.
      fit_verdict = excluded.fit_verdict,
      updated_at = clock_timestamp()
    -- xmax is 0 on a freshly inserted row and the updating transaction's id
    -- when ON CONFLICT took the update path.
    returning patient_diary_entries.entry_id, (patient_diary_entries.xmax = 0) as inserted
  )
  select coalesce(array_agg(u.entry_id order by u.entry_id), array[]::text[])
    into v_new
  from upserted u
  where u.inserted;

  if p_delete_ids is not null and array_length(p_delete_ids, 1) > 0 then
    delete from public.patient_diary_entries
      where patient_id = p_patient_id and entry_id = any(p_delete_ids);
  end if;

  if p_recents is not null then
    insert into public.patient_food_prefs (patient_id, recents)
    values (p_patient_id, p_recents)
    on conflict (patient_id) do update set
      recents = excluded.recents,
      updated_at = clock_timestamp();
  end if;

  return v_new;
end;
$$;
comment on function public.patient_diary_apply(uuid, jsonb, text[], jsonb) is
  'Atomic diary mutation (upserts incl. the diet fit verdict, deletes, recents). Returns the entry ids that were newly created by this call so callers can count logs without counting edits.';
revoke all on function public.patient_diary_apply(uuid, jsonb, text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.patient_diary_apply(uuid, jsonb, text[], jsonb)
  to service_role;

-- ── HQ diets & restrictions rollup: enabled practices only ─────────────────
drop function if exists public.hq_diet_restrictions_facts(date, date, text);
create function public.hq_diet_restrictions_facts(p_from date, p_to date, p_provider_id text default null)
returns jsonb
language sql stable set search_path = public, pg_temp
as $$
  with live as (
    select p.id, p.provider_id, p.program_id, p.program_start_date, p.created_at, p.activation_status
    from public.patients p
    -- Enabled practices only, network-wide too: the office route already
    -- refuses a disabled office, so the whole-network figures must not count
    -- patients the per-office view can never show.
    join public.providers pr on pr.provider_id = p.provider_id
    where p.archived_at is null
      and p.activation_status = 'activated'
      and p.closed_at is null
      and coalesce(pr.access_disabled, false) = false
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
