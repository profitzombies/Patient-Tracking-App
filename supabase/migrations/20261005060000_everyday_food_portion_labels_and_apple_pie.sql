begin;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)'::regprocedure
  )into definition;
  changed:=replace(definition,
    'trim(trailing ''.'' from trim(trailing ''0'' from (p->>''amount''))) ||'' ''||descriptor',
    '(p->>''amount'')::numeric::text||'' ''||descriptor');
  if changed=definition then raise exception 'source amount label formatter changed unexpectedly';end if;
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

insert into public.food_catalog_families(
  family_key,name,aliases,review_version
)values(
  'everyday-apple-pie','Apple Pie',
  array['apple pie','apple pies','dutch apple pie'],
  'everyday-foods-v3'
)
on conflict(family_key)do update set
  name=excluded.name,aliases=excluded.aliases,review_version=excluded.review_version;

with requested(fdc_id,summary,dimensions,common_order)as(values
  (173239::bigint,'Commercially prepared · Unenriched flour',
    '{"state":"prepared","dish":"whole pie","style":"classic"}'::jsonb,1),
  (167522::bigint,'Commercially prepared · Dutch apple',
    '{"state":"prepared","dish":"whole pie","style":"dutch"}'::jsonb,2)
),source as(
  select r.*,f.release_id,c.id catalog_id
  from requested r
  join public.usda_source_foods f on f.release_id='sr-legacy-2018-04'and f.fdc_id=r.fdc_id
  join public.food_catalog_items c on c.source='usda_fdc'and c.source_id=r.fdc_id::text
),snapshots as(
  select s.*,public.build_food_catalog_source_snapshot(
    release_id,fdc_id,'everyday-apple-pie',summary,dimensions,'generic_source'
  )snapshot from source s
),items as(
  update public.food_catalog_items c set
    name='Apple Pie',nutrition_snapshot=s.snapshot,
    measures=(select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'label',p->>'label','grams',p->'grams','unit',p->>'unit','evidence',p->>'evidence'
    ))order by ord)from jsonb_array_elements(s.snapshot->'portions')with ordinality x(p,ord)),
    provenance=c.provenance||jsonb_build_object(
      'mapping','generic_source','reviewVersion','everyday-foods-v3',
      'canonicalName',s.snapshot->'source'->>'canonicalName'
    ),updated_at=now()
  from snapshots s where c.id=s.catalog_id returning c.id
)
insert into public.food_catalog_family_variants(
  family_key,catalog_id,release_id,source_revision,variant_summary,
  dimensions,nutrition_snapshot,common_order
)
select 'everyday-apple-pie',catalog_id,release_id,release_id||':'||fdc_id,
  summary,dimensions,snapshot,common_order from snapshots
on conflict(family_key,catalog_id)do update set
  release_id=excluded.release_id,source_revision=excluded.source_revision,
  variant_summary=excluded.variant_summary,dimensions=excluded.dimensions,
  nutrition_snapshot=excluded.nutrition_snapshot,common_order=excluded.common_order;

update public.food_catalog_families f set default_catalog_id=v.catalog_id
from public.food_catalog_family_variants v
where f.family_key='everyday-apple-pie'and v.family_key=f.family_key and v.common_order=1;

insert into public.food_catalog_aliases(catalog_id,alias)
select v.catalog_id,a from public.food_catalog_family_variants v
join public.food_catalog_families f using(family_key)
cross join unnest(f.aliases)a where f.family_key='everyday-apple-pie'
on conflict(catalog_id,alias)do nothing;

insert into public.food_catalog_curation(
  catalog_id,eligibility,friendly_name,category,reason,review_version,source_revision
)
select v.catalog_id,'reviewed_family','Apple Pie','prepared foods',
  'reviewed source-backed whole-dish family variant','everyday-foods-v3',v.source_revision
from public.food_catalog_family_variants v where v.family_key='everyday-apple-pie'
on conflict(catalog_id)do update set
  eligibility=excluded.eligibility,friendly_name=excluded.friendly_name,
  category=excluded.category,reason=excluded.reason,
  review_version=excluded.review_version,source_revision=excluded.source_revision,
  reviewed_at=now();

do $$
begin
  if(select count(*)from public.food_catalog_family_variants where family_key='everyday-apple-pie')<>2
    then raise exception 'apple pie requires two exact whole-dish variants';end if;
end $$;

revoke all on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  to service_role;
notify pgrst,'reload schema';
commit;