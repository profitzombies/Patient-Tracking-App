begin;

with reviewed(family_key,release_id,fdc_id,summary,dimensions,common_order) as (
  values
    ('ground-beef','sr-legacy-2018-04',168608::bigint,'Grass-fed · Raw · Leanness not specified','{"production":"grass-fed","state":"raw","leanness":"not specified"}'::jsonb,9),
    ('yogurt','sr-legacy-2018-04',170903::bigint,'Greek · Plain · Low fat','{"style":"Greek","flavor":"plain","fat level":"low fat"}'::jsonb,4)
), facts as (
  select r.*,s.description,s.raw_food,c.id catalog_id,
    jsonb_build_object(
      'version',1,
      'source',jsonb_build_object('provider','USDA FoodData Central','recordId',r.fdc_id::text,
        'release',r.release_id,'revision',r.release_id||':'||r.fdc_id,'canonicalName',s.description),
      'basis',jsonb_build_object('amount',100,'unit','g','label','100 g','grams',100),
      'nutrients',coalesce((select jsonb_agg(jsonb_build_object(
        'id',n->'nutrient'->>'id','name',n->'nutrient'->>'name',
        'unit',n->'nutrient'->>'unitName','amount',(n->>'amount')::numeric) order by ord)
        from jsonb_array_elements(s.raw_food->'foodNutrients') with ordinality x(n,ord)
        where jsonb_typeof(n->'amount')='number' and not exists (
          select 1 from jsonb_array_elements(s.raw_food->'foodNutrients') with ordinality prior(p,pord)
          where pord<ord and p->'nutrient'->>'id'=n->'nutrient'->>'id'
            and jsonb_typeof(p->'amount')='number')),'[]'),
      'portions',jsonb_build_array(
        jsonb_build_object('id','g','label','grams','unit','g','dimension','weight','basisMultiplier',0.01,'grams',1,'evidence','USDA 100 g nutrient basis'),
        jsonb_build_object('id','oz','label','ounces','unit','oz','dimension','weight','basisMultiplier',0.28349523125,'grams',28.349523125,'evidence','Exact international avoirdupois conversion')
      ) || coalesce((select jsonb_agg(jsonb_build_object(
        'id','usda-portion-'||ord,
        'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
        'unit',coalesce(p->'measureUnit'->>'name','serving'),
        'dimension',case when lower(coalesce(p->'measureUnit'->>'name','')) ~ 'cup|tablespoon|teaspoon|fluid'
          then 'volume' when lower(coalesce(p->'measureUnit'->>'name','')) ~ 'serving'
          then 'serving' else 'count' end,
        'basisMultiplier',(p->>'gramWeight')::numeric/100,'grams',(p->>'gramWeight')::numeric,
        'evidence','USDA FoodData Central portion') order by ord)
        from jsonb_array_elements(coalesce(s.raw_food->'foodPortions','[]')) with ordinality x(p,ord)
        where jsonb_typeof(p->'gramWeight')='number'),'[]'),
      'variant',jsonb_build_object('familyKey',r.family_key,'summary',r.summary,'dimensions',r.dimensions),
      'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
      'provenance','generic_source'
    ) snapshot
  from reviewed r
  join usda_source_releases rel on rel.id=r.release_id and rel.status='ready'
  join usda_source_foods s on s.release_id=r.release_id and s.fdc_id=r.fdc_id
  join food_catalog_items c on c.source='usda_fdc' and c.source_id=r.fdc_id::text
), inserted as (
  insert into food_catalog_family_variants(
    family_key,catalog_id,release_id,source_revision,variant_summary,
    dimensions,nutrition_snapshot,common_order
  )
  select family_key,catalog_id,release_id,release_id||':'||fdc_id,
    summary,dimensions,snapshot,common_order from facts
  on conflict(family_key,catalog_id) do update set
    source_revision=excluded.source_revision,variant_summary=excluded.variant_summary,
    dimensions=excluded.dimensions,nutrition_snapshot=excluded.nutrition_snapshot,
    common_order=excluded.common_order
  returning catalog_id,nutrition_snapshot
)
update food_catalog_items c set nutrition_snapshot=i.nutrition_snapshot
from inserted i where i.catalog_id=c.id;

create or replace function public.search_food_catalog_grouped(
  p_patient_id uuid,
  p_query text,
  p_approved_only boolean default false,
  p_limit integer default 6,
  p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path=public
as $$
declare
  normalized text := lower(trim(regexp_replace(p_query,'[^a-zA-Z0-9%/]+',' ','g')));
  result jsonb;
begin
  if normalized like '%beef%'
     and normalized ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})'
     and normalized !~ '(80%|80/20|85%|85/15|90%|90/10|95%|95/5)' then
    return '[]'::jsonb;
  end if;
  result := public.search_food_catalog_grouped_v2_core(
    p_patient_id,p_query,p_approved_only,p_limit,p_offset
  );
  if normalized like '%beef%'
     and normalized ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})' then
    return coalesce((
      select jsonb_agg(row) from jsonb_array_elements(result) row
      where row->>'familyKey'='ground-beef'
    ),'[]'::jsonb);
  end if;
  return result;
end;
$$;

revoke all on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;