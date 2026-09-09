begin;

create temporary table search_plan_semantic_baseline(
  ordinal integer primary key,
  query text not null,
  approved boolean not null,
  page_limit integer not null,
  page_offset integer not null,
  result jsonb not null
) on commit drop;

insert into search_plan_semantic_baseline
select ordinal,query,approved,page_limit,page_offset,
  public.search_food_catalog_grouped(
    null,query,approved,page_limit,page_offset
  )
from (values
  (1,'chicken',false,6,0),
  (2,'chicken',false,6,6),
  (3,'chicken breast',false,7,0),
  (4,'raw skinless chicken wings',false,7,0),
  (5,'77/23 ground turkey',false,7,0),
  (6,'meatless meatballs',false,7,0),
  (7,'puffed wheat',false,7,0),
  (8,'salmon',true,7,0),
  (9,'zzzz nonexistent token',false,7,0)
) cases(ordinal,query,approved,page_limit,page_offset);

do $repair$
declare
  definition text;
  changed text;
  old_family text:=$old$
), family_candidates as (
  select 'family:'||f.family_key result_key,f.family_key,f.name,
    v.catalog_id,v.variant_summary,v.dimensions,v.nutrition_snapshot,
    null::jsonb catalog_metadata,fh.relevance rank
  from family_hits fh join food_catalog_families f using(family_key) cross join q
  join lateral(
$old$;
  new_family text:=$new$
), matched_families as materialized (
  select f.*,fh.relevance
  from family_hits fh join food_catalog_families f using(family_key)
), family_candidates as (
  select 'family:'||f.family_key result_key,f.family_key,f.name,
    v.catalog_id,v.variant_summary,v.dimensions,v.nutrition_snapshot,
    null::jsonb catalog_metadata,f.relevance rank
  from matched_families f cross join q
  join lateral(
$new$;
  old_singletons text:=$old$
), singleton_blobs as (
  select e.*,
    lower(e.name||' '||coalesce(string_agg(a.alias,' '),'')) search_blob
  from eligible e
  left join food_catalog_aliases a on a.catalog_id=e.id
  where not exists(select 1 from food_catalog_family_variants v where v.catalog_id=e.id)
  group by e.id,e.kind,e.name,e.brand,e.serving_label,e.serving_grams,e.calories,
    e.protein,e.carbs,e.fat,e.measures,e.source,e.source_id,e.barcode,e.quality_status,
    e.provenance,e.popularity,e.search_text,e.created_at,e.updated_at,e.nutrition_snapshot,
    e.friendly_name,e.eligibility
$old$;
  new_singletons text:=$new$
), alias_blobs as materialized (
  select catalog_id,string_agg(alias,' ' order by alias) search_blob
  from food_catalog_aliases
  group by catalog_id
), singleton_blobs as (
  select e.*,lower(e.name||' '||coalesce(a.search_blob,'')) search_blob
  from eligible e
  left join alias_blobs a on a.catalog_id=e.id
  where not exists(select 1 from food_catalog_family_variants v where v.catalog_id=e.id)
$new$;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  if position('regexp_split_to_table' in pg_get_functiondef(
      'public.food_catalog_regex_literal(text)'::regprocedure
    ))>0 then
    raise exception 'fast literal-token helper is not installed';
  end if;
  if position('matched_families as materialized' in definition)>0
    or position('alias_blobs as materialized' in definition)>0 then
    raise exception 'search plan materialization repair is already installed';
  end if;

  changed:=replace(definition,old_family,new_family);
  if changed=definition then
    raise exception 'family candidate plan template no longer matches live core';
  end if;
  definition:=changed;
  changed:=replace(definition,old_singletons,new_singletons);
  if changed=definition then
    raise exception 'singleton alias plan template no longer matches live core';
  end if;
  execute changed;
end
$repair$;

revoke all on function public.search_food_catalog_grouped_v2_core(
  uuid,text,boolean,integer,integer
) from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(
  uuid,text,boolean,integer,integer
) to service_role;

do $$
declare baseline record;
begin
  for baseline in select * from search_plan_semantic_baseline order by ordinal loop
    if public.search_food_catalog_grouped(
      null,baseline.query,baseline.approved,baseline.page_limit,baseline.page_offset
    ) is distinct from baseline.result then
      raise exception 'materialized search plan changed focused case %: %',
        baseline.ordinal,baseline.query;
    end if;
  end loop;
end $$;

notify pgrst,'reload schema';
commit;