-- Lossless reference imports only. Deliberately separate from food_catalog_*,
-- barcode facts, patient foods and diary records. No app search changes.
begin;

create table public.usda_source_releases (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{2,79}$'),
  manifest jsonb not null,
  status text not null default 'loading' check (status in ('loading', 'ready')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (
    jsonb_typeof(manifest) = 'object'
    and manifest ?& array['id','dataset','version','rootKey','dataType','sourceUrl','filename','sha256','bytes','foods','nutrients','portions']
    and manifest->>'id' = id
    and manifest->>'dataset' in ('sr_legacy','fndds','foundation')
    and manifest->>'sha256' ~ '^[a-f0-9]{64}$'
    and manifest->>'sourceUrl' like 'https://fdc.nal.usda.gov/%'
    and jsonb_typeof(manifest->'foods') = 'number'
    and (manifest->>'foods')::bigint > 0
    and (manifest->>'bytes')::bigint > 0
    and (manifest->>'nutrients')::bigint >= 0
    and (manifest->>'portions')::bigint >= 0
    and (manifest->>'dataset', manifest->>'rootKey', manifest->>'dataType') in (
      ('sr_legacy','SRLegacyFoods','SR Legacy'),
      ('fndds','SurveyFoods','Survey (FNDDS)'),
      ('foundation','FoundationFoods','Foundation')
    )
  ),
  check ((status = 'ready') = (completed_at is not null))
);
create unique index usda_source_release_version_idx
  on public.usda_source_releases ((manifest->>'dataset'), (manifest->>'version'));

create table public.usda_source_foods (
  release_id text not null references public.usda_source_releases(id),
  fdc_id bigint not null check (fdc_id > 0),
  description text not null check (length(trim(description)) > 0),
  raw_food jsonb not null,
  nutrient_count integer generated always as (jsonb_array_length(raw_food->'foodNutrients')) stored,
  portion_count integer generated always as (jsonb_array_length(coalesce(raw_food->'foodPortions', '[]'::jsonb))) stored,
  primary key (release_id, fdc_id),
  check (
    jsonb_typeof(raw_food) = 'object'
    and raw_food ?& array['fdcId','description','dataType','foodNutrients']
    and jsonb_typeof(raw_food->'fdcId') = 'number'
    and (raw_food->>'fdcId')::bigint = fdc_id
    and raw_food->>'description' = description
    and jsonb_typeof(raw_food->'foodNutrients') = 'array'
    and (not raw_food ? 'foodPortions' or jsonb_typeof(raw_food->'foodPortions') = 'array')
  )
);
create index usda_source_food_description_idx
  on public.usda_source_foods using gin (to_tsvector('english', description));

alter table public.usda_source_releases enable row level security;
alter table public.usda_source_foods enable row level security;
revoke all on public.usda_source_releases, public.usda_source_foods from public, anon, authenticated, service_role;
grant select on public.usda_source_releases, public.usda_source_foods to service_role;

-- A release identity is pinned to a complete file manifest. Retrying the same
-- file is safe; changed source bytes/metadata require a new version, never an overwrite.
create function public.begin_usda_source_release(p_manifest jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  existing public.usda_source_releases%rowtype;
begin
  insert into public.usda_source_releases(id, manifest)
  values (p_manifest->>'id', p_manifest)
  on conflict (id) do nothing;
  select * into strict existing from public.usda_source_releases
    where id = p_manifest->>'id' for update;
  if existing.manifest <> p_manifest then
    raise exception 'USDA release manifest differs; use a new immutable release identity';
  end if;
  return existing.status;
end;
$$;

-- Only the same raw JSON can be replayed. Each batch is atomic and compared
-- against what actually landed (including every nested nutrient/portion field).
create function public.import_usda_source_food_batch(p_release_id text, p_foods jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  release public.usda_source_releases%rowtype;
  supplied integer;
  inserted integer;
  total bigint;
begin
  select * into strict release from public.usda_source_releases
    where id = p_release_id for update;
  if jsonb_typeof(p_foods) is distinct from 'array' then
    raise exception 'USDA batch must be an array';
  end if;
  supplied := jsonb_array_length(p_foods);
  if supplied < 1 or supplied > 1000 or octet_length(p_foods::text) > 2000000 then
    raise exception 'USDA batch must contain 1-1000 records and be below 2 MB';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_foods) food
    where food->>'dataType' is distinct from release.manifest->>'dataType'
       or jsonb_typeof(food->'fdcId') is distinct from 'number'
       or (food->>'fdcId')::numeric <> trunc((food->>'fdcId')::numeric)
  ) then
    raise exception 'USDA record dataset or identifier is invalid';
  end if;
  if (select count(distinct food->>'fdcId') from jsonb_array_elements(p_foods) food) <> supplied then
    raise exception 'Duplicate USDA identifiers in batch';
  end if;
  if release.status = 'ready' and exists (
    select 1 from jsonb_array_elements(p_foods) food
    where not exists (
      select 1 from public.usda_source_foods stored
      where stored.release_id = p_release_id and stored.fdc_id = (food->>'fdcId')::bigint
    )
  ) then
    raise exception 'Cannot append records to a completed USDA release';
  end if;

  insert into public.usda_source_foods(release_id, fdc_id, description, raw_food)
    select p_release_id, (food->>'fdcId')::bigint, food->>'description', food
    from jsonb_array_elements(p_foods) food
    on conflict (release_id, fdc_id) do nothing;
  get diagnostics inserted = row_count;
  if exists (
    select 1 from jsonb_array_elements(p_foods) food
    join public.usda_source_foods stored
      on stored.release_id = p_release_id and stored.fdc_id = (food->>'fdcId')::bigint
    where stored.raw_food <> food
  ) then
    raise exception 'USDA source record differs from stored snapshot; nothing in this batch was changed';
  end if;
  select count(*) into total from public.usda_source_foods where release_id = p_release_id;
  if total > (release.manifest->>'foods')::bigint then
    raise exception 'USDA release exceeds its declared record count';
  end if;
  return jsonb_build_object('verified', supplied, 'inserted', inserted, 'stored', total);
end;
$$;

create function public.complete_usda_source_release(p_release_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  release public.usda_source_releases%rowtype;
  totals jsonb;
begin
  select * into strict release from public.usda_source_releases
    where id = p_release_id for update;
  select jsonb_build_object(
    'foods', count(*), 'nutrients', coalesce(sum(nutrient_count), 0),
    'portions', coalesce(sum(portion_count), 0)
  ) into totals from public.usda_source_foods where release_id = p_release_id;
  if totals->'foods' <> release.manifest->'foods'
     or totals->'nutrients' <> release.manifest->'nutrients'
     or totals->'portions' <> release.manifest->'portions' then
    raise exception 'USDA release is incomplete or count checks differ: %', totals;
  end if;
  if release.status <> 'ready' then
    update public.usda_source_releases set status = 'ready', completed_at = now()
      where id = p_release_id;
  end if;
  return totals || jsonb_build_object('id', p_release_id, 'status', 'ready');
end;
$$;

revoke all on function public.begin_usda_source_release(jsonb) from public, anon, authenticated;
revoke all on function public.import_usda_source_food_batch(text,jsonb) from public, anon, authenticated;
revoke all on function public.complete_usda_source_release(text) from public, anon, authenticated;
grant execute on function public.begin_usda_source_release(jsonb),
  public.import_usda_source_food_batch(text,jsonb),
  public.complete_usda_source_release(text) to service_role;

-- Queryable, lossless source rows; incomplete releases never appear in views.
-- No inferred densities, household conversions, macro sums or missing-as-zero values.
create view public.usda_source_nutrients with (security_invoker = true) as
select f.release_id, f.fdc_id, n.ordinality as position,
  n.value->'nutrient'->>'id' as nutrient_id,
  n.value->'nutrient'->>'name' as nutrient_name,
  n.value->'nutrient'->>'unitName' as unit_name,
  case when jsonb_typeof(n.value->'amount') = 'number'
    then (n.value->>'amount')::numeric else null end as amount,
  n.value as raw_nutrient
from public.usda_source_foods f
join public.usda_source_releases r on r.id = f.release_id and r.status = 'ready'
cross join lateral jsonb_array_elements(f.raw_food->'foodNutrients') with ordinality as n(value, ordinality);

create view public.usda_source_portions with (security_invoker = true) as
select f.release_id, f.fdc_id, p.ordinality as position,
  p.value->>'portionDescription' as portion_description,
  p.value->>'modifier' as modifier,
  p.value->'measureUnit'->>'name' as measure_unit,
  case when jsonb_typeof(p.value->'amount') = 'number'
    then (p.value->>'amount')::numeric else null end as amount,
  case when jsonb_typeof(p.value->'gramWeight') = 'number'
    then (p.value->>'gramWeight')::numeric else null end as gram_weight,
  p.value as raw_portion
from public.usda_source_foods f
join public.usda_source_releases r on r.id = f.release_id and r.status = 'ready'
cross join lateral jsonb_array_elements(coalesce(f.raw_food->'foodPortions', '[]'::jsonb))
  with ordinality as p(value, ordinality);

revoke all on public.usda_source_nutrients, public.usda_source_portions from public, anon, authenticated, service_role;
grant select on public.usda_source_nutrients, public.usda_source_portions to service_role;
comment on table public.usda_source_foods is
  'Full original USDA food JSON, including all nutrient and portion metadata. Internal source library, NOT the patient-facing catalog.';
comment on table public.usda_source_releases is
  'Checksummed immutable import manifests. Only ready releases are eligible for later reviewed catalog mapping.';
notify pgrst, 'reload schema';
commit;