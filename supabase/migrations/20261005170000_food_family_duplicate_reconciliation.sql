begin;

create table if not exists public.food_catalog_family_redirects(
  historical_family_key text primary key,
  canonical_family_key text not null references public.food_catalog_families(family_key),
  reason text not null,
  migration_version text not null,
  created_at timestamptz not null default now(),
  check(historical_family_key<>canonical_family_key)
);
revoke all on public.food_catalog_family_redirects from public,anon,authenticated;
grant select on public.food_catalog_family_redirects to service_role;

create or replace function public.food_catalog_query_is_only_constraints(p_text text)
returns boolean
language sql immutable strict parallel safe
set search_path=pg_catalog
as $$
  select not exists(
    select 1
    from unnest(string_to_array(trim(p_text),' ')) token
    where token<>''
      and token!~'^(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled|boiled|poached|steamed|canned|frozen|dry|skinless|chunky|chunk|style|smooth|low|fat|lowfat|nonfat|free|curd|[0-9]{2}%|[0-9]{2}/[0-9]{1,2})$'
  )
$$;
revoke all on function public.food_catalog_query_is_only_constraints(text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_query_is_only_constraints(text)
  to service_role;

create or replace function public.food_catalog_alias_is_bounded_identity(
  p_query text,p_alias text
) returns boolean
language sql immutable strict parallel safe
set search_path=pg_catalog
as $$
  select strpos(' '||p_query||' ',' '||p_alias||' ')>0
    and public.food_catalog_query_is_only_constraints(trim(replace(
      ' '||p_query||' ',' '||p_alias||' ',' '
    )))
$$;
revoke all on function public.food_catalog_alias_is_bounded_identity(text,text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_alias_is_bounded_identity(text,text)
  to service_role;

do $repair$
declare definition text; changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  if position('constraint_query' in definition)=0 then
    raise exception 'literal identity boundary repair is not installed';
  end if;
  if position('food_catalog_alias_is_bounded_identity' in definition)>0 then
    raise exception 'remainder-token boundary repair is already installed';
  end if;

  changed:=replace(definition,
    'strpos('' ''||q.value||'' '',
      '' ''||public.food_catalog_normalize_search_text(a)||'' '')>0',
    'public.food_catalog_alias_is_bounded_identity(
      q.value,public.food_catalog_normalize_search_text(a)
    )');
  changed:=replace(changed,
    'strpos('' ''||q.value||'' '',
        '' ''||public.food_catalog_normalize_search_text(a)||'' '')>0',
    'public.food_catalog_alias_is_bounded_identity(
        q.value,public.food_catalog_normalize_search_text(a)
      )');
  changed:=replace(changed,
    'strpos(
      '' ''||q.value||'' '',
      '' ''||public.food_catalog_normalize_search_text(a)||'' ''
    )>0',
    'public.food_catalog_alias_is_bounded_identity(
      q.value,public.food_catalog_normalize_search_text(a)
    )');
  if changed=definition then
    raise exception 'bounded identity templates no longer match live core';
  end if;
  if (length(changed)-length(replace(changed,
      'food_catalog_alias_is_bounded_identity','')))
      /length('food_catalog_alias_is_bounded_identity')<>3 then
    raise exception 'expected exactly three bounded identity predicates';
  end if;
  definition:=changed;
  changed:=replace(definition,
    'case when c.search_text=q.value then 2200',
    'case when c.search_text=q.value or exists(
        select 1 from public.food_catalog_aliases exact_alias
        where exact_alias.catalog_id=c.id
          and public.food_catalog_normalize_search_text(exact_alias.alias)=q.value
      ) then 2200');
  if changed=definition then
    raise exception 'singleton exact-alias ranking template no longer matches live core';
  end if;
  execute changed;
end
$repair$;

do $$
declare target uuid;
begin
  select c.id into target
  from public.food_catalog_items c
  join public.food_catalog_curation cur on cur.catalog_id=c.id
  where c.source='usda_fdc' and c.source_id='173913'
    and c.name='Cereals Ready-To-Eat, Wheat, Puffed, Fortified'
    and cur.eligibility='safe_singleton';
  if target is null then
    raise exception 'source-verified puffed wheat singleton contract changed';
  end if;
  update public.food_catalog_curation
  set friendly_name='Puffed Wheat Cereal'
  where catalog_id=target;
  insert into public.food_catalog_aliases(catalog_id,alias)
  values(target,'puffed wheat'),(target,'puffed wheat cereal')
  on conflict do nothing;
end $$;

create temporary table duplicate_variant_audit on commit drop as
select v.family_key historical_family_key,v.catalog_id,v.common_order,
  md5(jsonb_build_object(
    'catalog',to_jsonb(c),
    'nutrition_snapshot',v.nutrition_snapshot,
    'variant_summary',v.variant_summary,
    'dimensions',v.dimensions
  )::text) immutable_md5
from public.food_catalog_family_variants v
join public.food_catalog_items c on c.id=v.catalog_id
where v.family_key in('bulk-whole-wheat-bread','bulk-cooked-pasta');

do $$
begin
  if (select count(*) from duplicate_variant_audit)<>3 then
    raise exception 'duplicate-family moved variant cardinality changed';
  end if;
  if (select default_catalog_id::text from public.food_catalog_families
      where family_key='everyday-whole-wheat-bread')
      is distinct from '25027cc4-3323-48ac-a509-13bf480d1468'
    or (select default_catalog_id::text from public.food_catalog_families
      where family_key='everyday-pasta')
      is distinct from '3d454b9a-e5fb-4fd9-8d9a-6b2f0804923d' then
    raise exception 'original duplicate-family default contract changed';
  end if;
end $$;

insert into public.food_catalog_family_redirects(
  historical_family_key,canonical_family_key,reason,migration_version
) values
  ('bulk-whole-wheat-bread','everyday-whole-wheat-bread',
    'normalized duplicate identity; original family/default retained',
    '20261005170000'),
  ('bulk-cooked-pasta','everyday-pasta',
    'state-named duplicate identity; original family/default retained',
    '20261005170000');

update public.food_catalog_families canonical
set aliases=(
  select array_agg(alias order by alias)
  from (
    select distinct alias
    from unnest(canonical.aliases||historical.aliases) alias
  ) merged
)
from public.food_catalog_family_redirects redirect
join public.food_catalog_families historical
  on historical.family_key=redirect.historical_family_key
where canonical.family_key=redirect.canonical_family_key
  and redirect.migration_version='20261005170000';

with moved as (
  select v.family_key historical_family_key,v.catalog_id,
    redirect.canonical_family_key,
    coalesce((
      select max(existing.common_order)
      from public.food_catalog_family_variants existing
      where existing.family_key=redirect.canonical_family_key
    ),0)+row_number()over(
      partition by redirect.canonical_family_key
      order by v.common_order,v.catalog_id
    ) new_common_order
  from public.food_catalog_family_variants v
  join public.food_catalog_family_redirects redirect
    on redirect.historical_family_key=v.family_key
  where redirect.migration_version='20261005170000'
)
update public.food_catalog_family_variants v
set family_key=moved.canonical_family_key,
  common_order=moved.new_common_order
from moved
where v.family_key=moved.historical_family_key
  and v.catalog_id=moved.catalog_id;

delete from public.food_catalog_families f
using public.food_catalog_family_redirects redirect
where f.family_key=redirect.historical_family_key
  and redirect.migration_version='20261005170000';

create or replace function public.get_food_catalog_family(
  p_family_key text,p_approved_only boolean default false
) returns jsonb language sql stable security definer set search_path=public as $$
with requested as (
  select coalesce((
    select redirect.canonical_family_key
    from public.food_catalog_family_redirects redirect
    where redirect.historical_family_key=p_family_key
  ),p_family_key) family_key
)
select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id::text,'kind',c.kind,'name',f.name,'brand',c.brand,
  'serving',c.serving_label,'serving_grams',c.serving_grams,
  'calories',c.calories,'protein',c.protein,'carbs',c.carbs,'fat',c.fat,
  'measures',c.measures,'source',c.source,'source_id',c.source_id,
  'barcode',c.barcode,'quality_status',c.quality_status,
  'approvals',coalesce((select jsonb_agg(jsonb_build_object(
    'id',l.approved_food_id,'name',l.official_name,'portion',l.official_portion,
    'phaseGuidance',l.phase_guidance,'constraints',l.constraints
  ))from public.food_catalog_approved_links l where l.catalog_id=c.id),'[]'),
  'resultKey','family:'||f.family_key||':'||c.id,'familyKey',f.family_key,
  'variantSummary',v.variant_summary,'dimensions',v.dimensions,
  'choiceRequired',false,'nutritionSnapshot',v.nutrition_snapshot
)order by v.common_order,c.id),'[]')
from requested
join public.food_catalog_families f using(family_key)
join public.food_catalog_family_variants v using(family_key)
join public.food_catalog_items c on c.id=v.catalog_id
join public.food_catalog_curation cur on cur.catalog_id=c.id
  and cur.eligibility='reviewed_family'
where(not p_approved_only or exists(
  select 1 from public.food_catalog_approved_links l where l.catalog_id=c.id
));
$$;
revoke all on function public.get_food_catalog_family(text,boolean)
  from public,anon,authenticated;
grant execute on function public.get_food_catalog_family(text,boolean)
  to service_role;

do $$
declare audit record; rows jsonb;
begin
  for audit in select * from duplicate_variant_audit loop
    if not exists(
      select 1
      from public.food_catalog_family_redirects redirect
      join public.food_catalog_family_variants v
        on v.family_key=redirect.canonical_family_key
        and v.catalog_id=audit.catalog_id
      join public.food_catalog_items c on c.id=v.catalog_id
      where redirect.historical_family_key=audit.historical_family_key
        and md5(jsonb_build_object(
          'catalog',to_jsonb(c),
          'nutrition_snapshot',v.nutrition_snapshot,
          'variant_summary',v.variant_summary,
          'dimensions',v.dimensions
        )::text)=audit.immutable_md5
    ) then
      raise exception 'moved variant immutable payload changed: %',audit.catalog_id;
    end if;
  end loop;

  if (select default_catalog_id::text from public.food_catalog_families
      where family_key='everyday-whole-wheat-bread')
      is distinct from '25027cc4-3323-48ac-a509-13bf480d1468'
    or (select default_catalog_id::text from public.food_catalog_families
      where family_key='everyday-pasta')
      is distinct from '3d454b9a-e5fb-4fd9-8d9a-6b2f0804923d'
    or (select count(*) from public.food_catalog_families)<>713
    or (select count(*) from public.food_catalog_curation
      where eligibility='reviewed_family')<>1320
    or (select count(*) from public.food_catalog_curation
      where eligibility<>'excluded')<>5278 then
    raise exception 'family/default/population reconciliation invariant failed';
  end if;

  if not exists(
    select 1 from jsonb_array_elements(public.get_food_catalog_family(
      'bulk-whole-wheat-bread',false))r where r->>'source_id'='172689'
  ) or not exists(
    select 1 from jsonb_array_elements(public.get_food_catalog_family(
      'bulk-cooked-pasta',false))r where r->>'source_id'='169751'
  ) or not exists(
    select 1 from jsonb_array_elements(public.get_food_catalog_family(
      'bulk-cooked-pasta',false))r where r->>'source_id'='169737'
  ) then
    raise exception 'historical family redirect does not expose every moved source';
  end if;

  -- All prior failures except the two redirected historical expectations.
  if exists(
    select 1 from jsonb_array_elements(public.search_food_catalog_grouped(
      null,'raw sweet potatoes',false,7,0))r
    where r->>'familyKey' is distinct from 'everyday-sweet-potatoes'
      or r->'dimensions'->>'state' is distinct from 'raw'
  ) or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw sweet potatoes',false,7,0))=0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw orange juice',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw apple juice',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw grape juice',false,7,0))<>0
    or exists(
      select 1 from jsonb_array_elements(public.search_food_catalog_grouped(
        null,'raw grapefruit juice',false,7,0))r
      where r->>'familyKey' is distinct from 'everyday-grapefruit-juice'
        or r->'dimensions'->>'state' is distinct from 'raw'
    )
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw grapefruit juice',false,7,0))=0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'cooked sweet potatoes',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'cooked corn tortillas',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'cooked peanut butter',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'cooked pumpkin seeds',false,7,0))<>0 then
    raise exception 'remainder-token state boundary regression';
  end if;

  rows:=public.search_food_catalog_grouped(null,'apple pie',false,7,0);
  if rows->0->>'familyKey' is distinct from 'everyday-apple-pie'
    or exists(select 1 from jsonb_array_elements(rows)r
      where r->>'familyKey'='apples')
    or public.search_food_catalog_grouped(null,'puffed rice',false,1,0)
      ->0->>'familyKey' is distinct from 'bulk-puffed-rice-cereal'
    or public.search_food_catalog_grouped(null,'puffed wheat',false,1,0)
      ->0->>'source_id' is distinct from '173913' then
    raise exception 'dish/cereal identity boundary regression: apple %, rice %, wheat %',
      rows,
      public.search_food_catalog_grouped(null,'puffed rice',false,1,0),
      public.search_food_catalog_grouped(null,'puffed wheat',false,1,0);
  end if;

  if public.search_food_catalog_grouped(null,'whole wheat bread',false,1,0)
      ->0->>'familyKey' is distinct from 'everyday-whole-wheat-bread'
    or public.search_food_catalog_grouped(null,'whole wheat bread',false,1,0)
      ->0->>'source_id' is distinct from '172688'
    or public.search_food_catalog_grouped(null,'cooked pasta',false,1,0)
      ->0->>'familyKey' is distinct from 'everyday-pasta'
    or public.search_food_catalog_grouped(null,'cooked pasta',false,1,0)
      ->0->>'source_id' is distinct from '168928'
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw grilled chicken wings',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'77/23 ground beef',false,7,0))<>0 then
    raise exception 'original default/constraint contract regressed';
  end if;
end $$;

notify pgrst,'reload schema';
commit;