-- patient_diary_apply reports which upserted entries were NEW.
--
-- The HQ Insights food_log event is meant to count diary entries a patient
-- logged, but the API could only see "a batch of entries was saved" and so
-- recorded one event per row in every save, edits included. The apply RPC is
-- the only place that knows whether a row was inserted or merged, so it now
-- returns the entry ids it created (in this call) and the route records one
-- food_log event per NEW entry. Behaviour of the write itself is unchanged.
--
-- The return type changes (void -> text[]), which requires a drop.

drop function if exists public.patient_diary_apply(uuid, jsonb, text[], jsonb);

create function public.patient_diary_apply(
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
       created_at, updated_at)
    select
      p_patient_id,
      r.entry_id, r.date_key, r.meal, r.kind, r.ref_id, r.name,
      coalesce(r.detail, ''), r.quantity, r.calories, r.protein, r.carbs, r.fat,
      r.adjustments, r.nutrition_snapshot, clock_timestamp(), clock_timestamp()
    from jsonb_to_recordset(coalesce(p_upsert, '[]'::jsonb)) as r(
      entry_id text, date_key date, meal text, kind text, ref_id text,
      name text, detail text, quantity numeric, calories numeric,
      protein numeric, carbs numeric, fat numeric, adjustments jsonb,
      nutrition_snapshot jsonb
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
  'Atomic diary mutation (upserts, deletes, recents). Returns the entry ids that were newly created by this call so callers can count logs without counting edits.';
revoke all on function public.patient_diary_apply(uuid, jsonb, text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.patient_diary_apply(uuid, jsonb, text[], jsonb)
  to service_role;
