begin;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)'::regprocedure
  )into definition;
  changed:=replace(definition,
    '''evidence'',''USDA FoodData Central portion; source amount and descriptor preserved''',
    '''evidence'',''USDA FoodData Central sourcePortion id=''||coalesce(p->>''id'',''missing'')
        ||''; amount=''||coalesce(p->>''amount'',''missing'')
        ||''; modifier=''||coalesce(p->>''modifier'',p->>''portionDescription'',''missing'')
        ||''; gramWeight=''||coalesce(p->>''gramWeight'',''missing'')||'' g''');
  if changed=definition then raise exception 'source portion evidence template changed unexpectedly';end if;
  execute changed;
end $$;

with rebuilt as(
  select v.catalog_id,public.build_food_catalog_source_snapshot(
    v.release_id,split_part(v.source_revision,':',2)::bigint,v.family_key,
    v.variant_summary,v.dimensions,'generic_source'
  )snapshot
  from public.food_catalog_family_variants v where v.family_key like'everyday-%'
),updated as(
  update public.food_catalog_family_variants v set nutrition_snapshot=r.snapshot
  from rebuilt r where r.catalog_id=v.catalog_id
  returning v.catalog_id,v.nutrition_snapshot
)
update public.food_catalog_items c set
  nutrition_snapshot=u.nutrition_snapshot,
  measures=(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'label',p->>'label','grams',p->'grams','unit',p->>'unit',
    'evidence',p->>'evidence'
  ))order by ord)from jsonb_array_elements(u.nutrition_snapshot->'portions')
    with ordinality x(p,ord)),
  updated_at=now()
from updated u where c.id=u.catalog_id;

do $$
begin
  if not exists(
    select 1 from public.food_catalog_family_variants v
    cross join lateral jsonb_array_elements(v.nutrition_snapshot->'portions')p
    where v.source_revision='sr-legacy-2018-04:170567'
      and p->>'evidence'like'%amount=1;%'
      and p->>'evidence'like'%modifier=almond;%'
      and p->>'evidence'like'%gramWeight=1.2 g%'
  )then raise exception 'almond source portion evidence is incomplete';end if;
end $$;

revoke all on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  to service_role;
notify pgrst,'reload schema';
commit;