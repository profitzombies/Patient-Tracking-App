begin;

with facts as(
  select f.release_id,f.fdc_id,f.description,f.raw_food,c.id catalog_id
  from usda_source_foods f
  join usda_source_releases r on r.id=f.release_id and r.status='ready'
  join food_catalog_items c on c.source='usda_fdc' and c.source_id=f.fdc_id::text
  where f.release_id='sr-legacy-2018-04' and f.fdc_id=171534
),snapshot as(
  select facts.*,jsonb_build_object(
    'version',1,
    'source',jsonb_build_object('provider','USDA FoodData Central','recordId',fdc_id::text,
      'release',release_id,'revision',release_id||':'||fdc_id,'canonicalName',description),
    'basis',jsonb_build_object('amount',100,'unit','g','label','100 g','grams',100),
    'nutrients',(select jsonb_agg(jsonb_build_object(
      'id',n->'nutrient'->>'id','name',n->'nutrient'->>'name',
      'unit',n->'nutrient'->>'unitName','amount',(n->>'amount')::numeric)order by ord)
      from jsonb_array_elements(raw_food->'foodNutrients')with ordinality x(n,ord)
      where jsonb_typeof(n->'amount')='number'and not exists(
        select 1 from jsonb_array_elements(raw_food->'foodNutrients')with ordinality p(prior,pord)
        where pord<ord and prior->'nutrient'->>'id'=n->'nutrient'->>'id'
          and jsonb_typeof(prior->'amount')='number')),
    'portions',jsonb_build_array(
      jsonb_build_object('id','g','label','grams','unit','g','dimension','weight',
        'basisMultiplier',0.01,'grams',1,'evidence','USDA 100 g nutrient basis'),
      jsonb_build_object('id','oz','label','ounces','unit','oz','dimension','weight',
        'basisMultiplier',0.28349523125,'grams',28.349523125,'evidence','Exact international avoirdupois conversion')),
    'variant',jsonb_build_object('familyKey','chicken-breast','summary','Grilled · Skinless, boneless',
      'dimensions',jsonb_build_object('state','cooked','skin','not eaten','preparation','grilled')),
    'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
    'provenance','generic_source'
  )value
  from facts
),inserted as(
  insert into food_catalog_family_variants(
    family_key,catalog_id,release_id,source_revision,variant_summary,
    dimensions,nutrition_snapshot,common_order
  )
  select 'chicken-breast',catalog_id,release_id,release_id||':'||fdc_id,
    'Grilled · Skinless, boneless','{"state":"cooked","skin":"not eaten","preparation":"grilled"}',
    value,5 from snapshot
  on conflict(family_key,catalog_id)do update set
    source_revision=excluded.source_revision,variant_summary=excluded.variant_summary,
    dimensions=excluded.dimensions,nutrition_snapshot=excluded.nutrition_snapshot,
    common_order=excluded.common_order
  returning catalog_id,nutrition_snapshot
)
update food_catalog_items c set nutrition_snapshot=i.nutrition_snapshot
from inserted i where c.id=i.catalog_id;

do $$
declare
  definition text;
  changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  changed := replace(
    definition,
    'and(c.search_text%q.value or c.search_text like''%''||q.value||''%'')',
    'and(c.search_text%q.value or c.search_text like''%''||q.value||''%'')
  and not(q.value~''(^| )(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled)( |$)''
    and q.value~''(^| )chicken( |$)'')'
  );
  if changed=definition then
    raise exception 'chicken singleton constraint clause changed unexpectedly';
  end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;