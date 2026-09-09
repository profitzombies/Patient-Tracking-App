-- Lossless, versioned nutrition baselines for diary history and private foods.
-- Optional columns preserve every legacy row. JSON shape is validated at the
-- API boundary; these checks provide a final version/size/type guard.

alter table public.patient_diary_entries
  add column if not exists nutrition_snapshot jsonb
  check (
    nutrition_snapshot is null or (
      jsonb_typeof(nutrition_snapshot) = 'object'
      and nutrition_snapshot ->> 'version' = '1'
      and octet_length(nutrition_snapshot::text) <= 64000
    )
  );

alter table public.patient_custom_foods
  add column if not exists nutrition_snapshot jsonb
  check (
    nutrition_snapshot is null or (
      jsonb_typeof(nutrition_snapshot) = 'object'
      and nutrition_snapshot ->> 'version' = '1'
      and octet_length(nutrition_snapshot::text) <= 64000
    )
  );

alter table public.patient_custom_foods
  add column if not exists catalog_shared boolean not null default false,
  add column if not exists catalog_metadata jsonb
    check (
      catalog_metadata is null or (
        jsonb_typeof(catalog_metadata) = 'object'
        and octet_length(catalog_metadata::text) <= 4000
      )
    );

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

create or replace function public.patient_library_apply(
  p_patient_id uuid,
  p_food_upsert jsonb default '[]'::jsonb,
  p_food_delete_ids text[] default array[]::text[],
  p_recipe_upsert jsonb default '[]'::jsonb,
  p_recipe_delete_ids text[] default array[]::text[],
  p_favorites jsonb default null,
  p_recents jsonb default null
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  delete from public.patient_media m
  using public.patient_custom_foods f,
        jsonb_to_recordset(coalesce(p_food_upsert, '[]'::jsonb))
          as r(food_id text, photo_path text)
  where f.patient_id = p_patient_id
    and f.food_id = r.food_id
    and f.photo_path is not null
    and f.photo_path is distinct from r.photo_path
    and m.object_path = f.photo_path;

  insert into public.patient_custom_foods
    (patient_id, food_id, name, brand, serving, calories, protein, carbs, fat,
     photo_path, nutrition_snapshot, catalog_shared, catalog_metadata,
     created_at, updated_at)
  select
    p_patient_id, r.food_id, r.name, r.brand, r.serving,
    r.calories, r.protein, r.carbs, r.fat, r.photo_path, r.nutrition_snapshot,
    coalesce(r.catalog_shared, false), r.catalog_metadata,
    clock_timestamp(), clock_timestamp()
  from jsonb_to_recordset(coalesce(p_food_upsert, '[]'::jsonb)) as r(
    food_id text, name text, brand text, serving text,
    calories numeric, protein numeric, carbs numeric, fat numeric,
    photo_path text, nutrition_snapshot jsonb, catalog_shared boolean,
    catalog_metadata jsonb
  )
  on conflict (patient_id, food_id) do update set
    name = excluded.name,
    brand = excluded.brand,
    serving = excluded.serving,
    calories = excluded.calories,
    protein = excluded.protein,
    carbs = excluded.carbs,
    fat = excluded.fat,
    photo_path = excluded.photo_path,
    nutrition_snapshot = excluded.nutrition_snapshot,
    catalog_shared = excluded.catalog_shared,
    catalog_metadata = excluded.catalog_metadata,
    updated_at = clock_timestamp();

  insert into public.patient_media (object_path, patient_id, kind)
  select r.photo_path, p_patient_id, 'food'
  from jsonb_to_recordset(coalesce(p_food_upsert, '[]'::jsonb))
    as r(food_id text, photo_path text)
  where r.photo_path is not null
  on conflict (object_path) do nothing;

  if p_food_delete_ids is not null and array_length(p_food_delete_ids, 1) > 0 then
    delete from public.patient_media m
    using public.patient_custom_foods f
    where f.patient_id = p_patient_id
      and f.food_id = any(p_food_delete_ids)
      and f.photo_path is not null
      and m.object_path = f.photo_path;
    delete from public.patient_custom_foods
      where patient_id = p_patient_id and food_id = any(p_food_delete_ids);
  end if;

  -- Saved recipes are unchanged, but remain in this same atomic mutation.
  delete from public.patient_media m
  using public.patient_saved_recipes s,
        jsonb_to_recordset(coalesce(p_recipe_upsert, '[]'::jsonb))
          as r(recipe_id text, photo_path text)
  where s.patient_id = p_patient_id
    and s.recipe_id = r.recipe_id
    and s.photo_path is not null
    and s.photo_path is distinct from r.photo_path
    and m.object_path = s.photo_path;

  insert into public.patient_saved_recipes
    (patient_id, recipe_id, name, meal, mode, tags, minutes, servings,
     calories, protein, carbs, fat, description, ingredients, steps,
     grocery_list, saved_at, photo_path, created_at, updated_at)
  select
    p_patient_id, r.recipe_id, r.name, r.meal, r.mode,
    coalesce(r.tags, '[]'::jsonb), r.minutes, r.servings,
    r.calories, r.protein, r.carbs, r.fat, coalesce(r.description, ''),
    coalesce(r.ingredients, '[]'::jsonb), coalesce(r.steps, '[]'::jsonb),
    r.grocery_list, r.saved_at, r.photo_path,
    clock_timestamp(), clock_timestamp()
  from jsonb_to_recordset(coalesce(p_recipe_upsert, '[]'::jsonb)) as r(
    recipe_id text, name text, meal text, mode text, tags jsonb,
    minutes numeric, servings numeric, calories numeric, protein numeric,
    carbs numeric, fat numeric, description text, ingredients jsonb,
    steps jsonb, grocery_list jsonb, saved_at text, photo_path text
  )
  on conflict (patient_id, recipe_id) do update set
    name = excluded.name, meal = excluded.meal, mode = excluded.mode,
    tags = excluded.tags, minutes = excluded.minutes, servings = excluded.servings,
    calories = excluded.calories, protein = excluded.protein,
    carbs = excluded.carbs, fat = excluded.fat,
    description = excluded.description, ingredients = excluded.ingredients,
    steps = excluded.steps, grocery_list = excluded.grocery_list,
    saved_at = excluded.saved_at, photo_path = excluded.photo_path,
    updated_at = clock_timestamp();

  insert into public.patient_media (object_path, patient_id, kind)
  select r.photo_path, p_patient_id, 'recipe'
  from jsonb_to_recordset(coalesce(p_recipe_upsert, '[]'::jsonb))
    as r(recipe_id text, photo_path text)
  where r.photo_path is not null
  on conflict (object_path) do nothing;

  if p_recipe_delete_ids is not null and array_length(p_recipe_delete_ids, 1) > 0 then
    delete from public.patient_media m
    using public.patient_saved_recipes s
    where s.patient_id = p_patient_id
      and s.recipe_id = any(p_recipe_delete_ids)
      and s.photo_path is not null
      and m.object_path = s.photo_path;
    delete from public.patient_saved_recipes
      where patient_id = p_patient_id and recipe_id = any(p_recipe_delete_ids);
  end if;

  if p_favorites is not null or p_recents is not null then
    insert into public.patient_food_prefs (patient_id, favorites, recents)
    values (p_patient_id, coalesce(p_favorites, '[]'::jsonb), coalesce(p_recents, '[]'::jsonb))
    on conflict (patient_id) do update set
      favorites = coalesce(p_favorites, patient_food_prefs.favorites),
      recents = coalesce(p_recents, patient_food_prefs.recents),
      updated_at = clock_timestamp();
  end if;
end;
$$;

revoke all on function public.patient_library_apply(uuid, jsonb, text[], jsonb, text[], jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.patient_library_apply(uuid, jsonb, text[], jsonb, text[], jsonb, jsonb)
  to service_role;