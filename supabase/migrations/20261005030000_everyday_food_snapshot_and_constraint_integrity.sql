begin;

create or replace function public.build_food_catalog_source_snapshot(
  p_release_id text,p_fdc_id bigint,p_family_key text,p_summary text,
  p_dimensions jsonb,p_provenance text
) returns jsonb language sql stable security definer set search_path=public as $$
with source as(
  select f.* from usda_source_foods f
  join usda_source_releases r on r.id=f.release_id and r.status='ready'
  where f.release_id=p_release_id and f.fdc_id=p_fdc_id
), source_portions as(
  select ord,p,
    coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name') descriptor,
    case when lower(coalesce(p->'measureUnit'->>'name',''))not in('','undetermined')
      then p->'measureUnit'->>'name'
      else coalesce(p->>'modifier',p->>'portionDescription','serving') end semantic_unit
  from source cross join lateral
    jsonb_array_elements(coalesce(raw_food->'foodPortions','[]'))with ordinality x(p,ord)
  where jsonb_typeof(p->'gramWeight')='number'
), usable_portions as(
  select *,
    case when jsonb_typeof(p->'amount')='number'and descriptor!~'^\s*[0-9]'
      then trim(trailing '.' from trim(trailing '0' from (p->>'amount'))) ||' '||descriptor
      else descriptor end patient_label
  from source_portions
  where lower(coalesce(descriptor,''))not in('quantity not specified','amount not specified','')
)
select jsonb_build_object(
  'version',1,
  'source',jsonb_build_object(
    'provider','USDA FoodData Central','recordId',f.fdc_id::text,
    'release',f.release_id,'revision',f.release_id||':'||f.fdc_id,
    'canonicalName',f.description
  ),
  'basis',jsonb_build_object('amount',100,'unit','g','label','100 g','grams',100),
  'nutrients',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',n->'nutrient'->>'id','name',n->'nutrient'->>'name',
      'unit',n->'nutrient'->>'unitName','amount',(n->>'amount')::numeric
    )order by ord)
    from jsonb_array_elements(f.raw_food->'foodNutrients')with ordinality x(n,ord)
    where jsonb_typeof(n->'amount')='number'and not exists(
      select 1 from jsonb_array_elements(f.raw_food->'foodNutrients')with ordinality prior(p,pord)
      where pord<ord and p->'nutrient'->>'id'=n->'nutrient'->>'id'
        and jsonb_typeof(p->'amount')='number'
    )
  ),'[]'),
  'portions',jsonb_build_array(
    jsonb_build_object('id','g','label','grams','unit','g','dimension','weight',
      'basisMultiplier',0.01,'grams',1,'evidence','USDA 100 g nutrient basis'),
    jsonb_build_object('id','oz','label','ounces','unit','oz','dimension','weight',
      'basisMultiplier',0.28349523125,'grams',28.349523125,
      'evidence','Exact international avoirdupois conversion')
  )||coalesce((
    select jsonb_agg(jsonb_build_object(
      'id','usda-portion-'||ord,'label',patient_label,'unit',semantic_unit,
      'dimension',case
        when lower(semantic_unit||' '||descriptor)~
          '(^|[^a-z])(g|gram|grams|kg|kilogram|oz|ounce|ounces|lb|pound|pounds)([^a-z]|$)'
          then 'weight'
        when lower(semantic_unit||' '||descriptor)~
          'cup|tablespoon|teaspoon|tbsp|tsp|milliliter|\mml\M|fluid|fl oz|liter'
          then 'volume'
        when lower(semantic_unit||' '||descriptor)~'serving' then 'serving'
        else 'serving' end,
      'basisMultiplier',(p->>'gramWeight')::numeric/100,
      'grams',(p->>'gramWeight')::numeric,
      'evidence','USDA FoodData Central portion; source amount and descriptor preserved'
    )order by ord)from usable_portions
  ),'[]'),
  'variant',jsonb_build_object('familyKey',p_family_key,'summary',p_summary,'dimensions',p_dimensions),
  'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
  'provenance','generic_source'
)from source f;
$$;
revoke all on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  to service_role;

with rebuilt as(
  select v.catalog_id,build_food_catalog_source_snapshot(
    v.release_id,split_part(v.source_revision,':',2)::bigint,v.family_key,
    v.variant_summary,v.dimensions,'generic_source'
  )snapshot
  from food_catalog_family_variants v where v.family_key like'everyday-%'
),updated as(
  update food_catalog_family_variants v set nutrition_snapshot=r.snapshot
  from rebuilt r where r.catalog_id=v.catalog_id
  returning v.catalog_id,v.nutrition_snapshot
)
update food_catalog_items c set
  nutrition_snapshot=u.nutrition_snapshot,
  measures=(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'label',p->>'label','grams',p->'grams','unit',p->>'unit',
    'evidence',p->>'evidence'
  ))order by ord)from jsonb_array_elements(u.nutrition_snapshot->'portions')
    with ordinality x(p,ord)),
  provenance=jsonb_set(c.provenance,'{mapping}','"generic_source"',true),
  updated_at=now()
from updated u where c.id=u.catalog_id;

create or replace function public.food_catalog_variant_explicit_constraints_match(
  p_query text,p_dimensions jsonb,p_summary text
)returns boolean language plpgsql immutable strict parallel safe as $$
declare
  ratio_lean text;
  ratio_fat text;
  preparation text:=lower(coalesce(p_dimensions->>'preparation','')||' '||coalesce(p_summary,''));
  requested text;
begin
  ratio_lean:=substring(p_query from '([0-9]{2})%');
  if ratio_lean is null then ratio_lean:=substring(p_query from '([0-9]{2})/[0-9]{1,2}'); end if;
  ratio_fat:=substring(p_query from '[0-9]{2}/([0-9]{1,2})');
  if ratio_lean is not null then
    if p_dimensions->>'leanness'not like ratio_lean||'% lean%' then return false; end if;
    if ratio_fat is not null and p_dimensions->>'leanness'not like'%/ '||ratio_fat||'% fat' then
      return false;
    end if;
  end if;
  foreach requested in array array['raw','cooked','grilled','fried','roasted','baked',
    'broiled','boiled','poached','steamed','canned','frozen','dry']
  loop
    if p_query~(('(^| )'||requested||'( |$)')) then
      if requested='raw'and p_dimensions->>'state'<>'raw' then return false;
      elsif requested='cooked'and p_dimensions->>'state'<>'cooked' then return false;
      elsif requested='canned'and not(p_dimensions->>'state'='prepared'and preparation~'\mcanned\M') then return false;
      elsif requested='frozen'and not(lower(coalesce(p_dimensions->>'form','')||' '||p_summary)~'\mfrozen\M') then return false;
      elsif requested='dry'and not(p_dimensions->>'state'='dry'or preparation~'\mdry\M') then return false;
      elsif requested not in('raw','cooked','canned','frozen','dry')
        and preparation!~(('(^|[^a-z])'||requested||'([^a-z]|$)')) then return false;
      end if;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.food_catalog_variant_explicit_constraints_match(text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_variant_explicit_constraints_match(text,jsonb,text)
  to service_role;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  )into definition;
  changed:=replace(definition,
    'and public.food_catalog_variant_form_matches(q.value,candidate.dimensions)',
    'and public.food_catalog_variant_form_matches(q.value,candidate.dimensions)
      and public.food_catalog_variant_explicit_constraints_match(
        q.value,candidate.dimensions,candidate.variant_summary
      )');
  if changed=definition then raise exception 'explicit constraint predicate changed unexpectedly'; end if;
  execute changed;
end $$;

do $$
begin
  if exists(
    select 1 from food_catalog_family_variants v
    where v.family_key like'everyday-%'
      and v.nutrition_snapshot->>'provenance'<>'generic_source'
  )then raise exception 'unsupported everyday snapshot provenance';end if;
  if not exists(
    select 1 from food_catalog_family_variants v
    cross join lateral jsonb_array_elements(v.nutrition_snapshot->'portions')p
    where v.source_revision='sr-legacy-2018-04:173417'
      and p->>'label'='4 oz'and(p->>'grams')::numeric=113
      and p->>'dimension'='weight'
  )then raise exception 'cottage cheese 4 oz source portion was not preserved';end if;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;