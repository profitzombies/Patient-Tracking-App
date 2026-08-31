-- Atomic apply for compound diary mutations.
--
-- POST /patient-data/entries can carry entry upserts, entry deletes, and a
-- recents bump in one logical mutation. Running those as separate PostgREST
-- requests could partially commit (e.g. the entry lands but the recents write
-- fails, the app rolls back its optimistic state, and the "phantom" entry
-- reappears on the next hydration). This function runs the whole mutation in
-- ONE transaction: all of it lands or none of it does.
--
-- Notes:
--  - p_upsert rows are the snake_case entry fields; extra keys (patient_id,
--    created_at, ...) are ignored — patient identity comes ONLY from
--    p_patient_id, and created_at is server-assigned.
--  - created_at uses clock_timestamp() so rows inserted in one batch keep
--    their array order under the state fetch's created_at ordering; on
--    conflict created_at is preserved (an edit never reorders history).
--  - Table check constraints still validate every value inside the
--    transaction; the API server validates field-by-field before calling.
--  - Service-role only, like the tables: EXECUTE revoked from anon and
--    authenticated. SECURITY INVOKER on purpose — the service role bypasses
--    RLS itself; no definer escalation to hand out.
--
-- Safe to re-run: create or replace + idempotent grants.

create or replace function public.patient_diary_apply(
  p_patient_id uuid,
  p_upsert jsonb default '[]'::jsonb,
  p_delete_ids text[] default array[]::text[],
  p_recents jsonb default null
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.patient_diary_entries
    (patient_id, entry_id, date_key, meal, kind, ref_id, name, detail,
     quantity, calories, protein, carbs, fat, adjustments, created_at, updated_at)
  select
    p_patient_id,
    r.entry_id, r.date_key, r.meal, r.kind, r.ref_id, r.name,
    coalesce(r.detail, ''), r.quantity, r.calories, r.protein, r.carbs, r.fat,
    r.adjustments, clock_timestamp(), clock_timestamp()
  from jsonb_to_recordset(coalesce(p_upsert, '[]'::jsonb)) as r(
    entry_id text, date_key date, meal text, kind text, ref_id text,
    name text, detail text, quantity numeric, calories numeric,
    protein numeric, carbs numeric, fat numeric, adjustments jsonb
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
    updated_at = clock_timestamp();

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
end;
$$;

revoke all on function public.patient_diary_apply(uuid, jsonb, text[], jsonb)
  from public, anon, authenticated;
grant execute on function public.patient_diary_apply(uuid, jsonb, text[], jsonb)
  to service_role;
