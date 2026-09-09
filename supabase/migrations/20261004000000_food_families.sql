begin;

alter table public.barcode_nutrition_facts
  add column if not exists nutrition_snapshot jsonb
  check (nutrition_snapshot is null or (
    jsonb_typeof(nutrition_snapshot)='object' and nutrition_snapshot->>'version'='1'
  ));
alter table public.food_catalog_items
  add column if not exists nutrition_snapshot jsonb
  check (nutrition_snapshot is null or (
    jsonb_typeof(nutrition_snapshot)='object' and nutrition_snapshot->>'version'='1'
  ));

create table public.food_catalog_families (
  family_key text primary key check (family_key ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text not null,
  aliases text[] not null,
  default_catalog_id uuid references public.food_catalog_items(id),
  review_version text not null,
  created_at timestamptz not null default now()
);

create table public.food_catalog_family_variants (
  family_key text not null references public.food_catalog_families(family_key) on delete cascade,
  catalog_id uuid not null references public.food_catalog_items(id) on delete cascade,
  release_id text not null,
  source_revision text not null,
  variant_summary text not null,
  dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
  nutrition_snapshot jsonb not null check (
    jsonb_typeof(nutrition_snapshot) = 'object'
    and nutrition_snapshot->>'version' = '1'
  ),
  common_order integer not null check (common_order > 0),
  primary key (family_key, catalog_id),
  unique (catalog_id)
);

alter table public.food_catalog_families enable row level security;
alter table public.food_catalog_family_variants enable row level security;
revoke all on public.food_catalog_families, public.food_catalog_family_variants
  from public, anon, authenticated;
grant select on public.food_catalog_families, public.food_catalog_family_variants to service_role;

insert into public.food_catalog_families(family_key, name, aliases, review_version)
values
  ('ground-beef','Ground Beef',array['ground beef','beef ground','90% ground beef','90/10 beef'],'food-families-v1'),
  ('chicken-breast','Chicken Breast',array['chicken breast','chicken breasts'],'food-families-v1'),
  ('chicken-thighs','Chicken Thighs',array['chicken thigh','chicken thighs'],'food-families-v1'),
  ('chicken-wings','Chicken Wings',array['chicken wing','chicken wings'],'food-families-v1'),
  ('eggs','Eggs',array['egg','eggs'],'food-families-v1'),
  ('rice','Rice',array['rice','cooked rice','white rice'],'food-families-v1'),
  ('apples','Apples',array['apple','apples'],'food-families-v1'),
  ('bananas','Bananas',array['banana','bananas'],'food-families-v1'),
  ('yogurt','Yogurt',array['yogurt','plain yogurt'],'food-families-v1'),
  ('meatballs','Meatballs',array['meatball','meatballs'],'food-families-v1'),
  ('ketchup','Ketchup',array['ketchup','catsup'],'food-families-v1');

-- Every row below was reviewed against an immutable ready USDA release. The
-- source row remains authoritative; no raw source row is updated.
with reviewed(family_key, release_id, fdc_id, display_name, summary, dimensions, provenance) as (
  values
    ('ground-beef','sr-legacy-2018-04',174030,'Ground Beef','90% lean / 10% fat · Raw','{"leanness":"90% lean / 10% fat","state":"raw"}'::jsonb,'generic_source'),
    ('chicken-breast','fndds-2021-2023',2705956,'Chicken Breast','Roasted · Skin not eaten','{"preparation":"baked, broiled, or roasted","skin":"not eaten","state":"cooked"}','generic_source'),
    ('chicken-thighs','fndds-2021-2023',2706029,'Chicken Thighs','Roasted · Skin eaten','{"preparation":"baked, broiled, or roasted","skin":"eaten","state":"cooked"}','generic_source'),
    ('chicken-wings','fndds-2021-2023',2706057,'Chicken Wings','Roasted · From raw','{"preparation":"baked, broiled, or roasted","state":"cooked"}','generic_source'),
    ('eggs','fndds-2021-2023',2707153,'Eggs','Whole · Cooked','{"form":"whole","state":"cooked"}','generic_source'),
    ('rice','fndds-2021-2023',2708422,'Rice','White glutinous · Cooked','{"type":"white glutinous","state":"cooked"}','generic_source'),
    ('apples','fndds-2021-2023',2709215,'Apples','Raw','{"form":"whole","state":"raw"}','generic_source'),
    ('bananas','fndds-2021-2023',2709224,'Bananas','Raw · Edible portion','{"form":"edible portion","state":"raw"}','generic_source'),
    ('yogurt','sr-legacy-2018-04',171284,'Yogurt','Plain · Whole milk','{"flavor":"plain","fat level":"whole milk"}','generic_source'),
    ('meatballs','fndds-2021-2023',2706467,'Meatballs','Meat, type not specified · With sauce','{"composition":"meat, type not specified","preparation":"with sauce"}','generic_dish_estimate'),
    ('ketchup','fndds-2021-2023',2709733,'Ketchup','Generic','{"type":"generic"}','generic_source')
),
facts as (
  select r.*, s.description, s.raw_food,
    (select (n->>'amount')::numeric from jsonb_array_elements(s.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id' = '1008' and jsonb_typeof(n->'amount')='number' limit 1) calories,
    (select (n->>'amount')::numeric from jsonb_array_elements(s.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id' = '1003' and jsonb_typeof(n->'amount')='number' limit 1) protein,
    (select (n->>'amount')::numeric from jsonb_array_elements(s.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id' = '1005' and jsonb_typeof(n->'amount')='number' limit 1) carbs,
    (select (n->>'amount')::numeric from jsonb_array_elements(s.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id' = '1004' and jsonb_typeof(n->'amount')='number' limit 1) fat
  from reviewed r join public.usda_source_foods s
    on s.release_id=r.release_id and s.fdc_id=r.fdc_id
  join public.usda_source_releases rel on rel.id=s.release_id and rel.status='ready'
),
inserted as (
  insert into public.food_catalog_items(
    kind,name,brand,serving_label,serving_grams,calories,protein,carbs,fat,
    measures,source,source_id,quality_status,provenance
  )
  select 'generic', display_name, null, '100 g', 100, calories, protein, carbs, fat,
    coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'label', coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
        'grams', case when jsonb_typeof(p->'gramWeight')='number' then p->'gramWeight' end,
        'amount', case when jsonb_typeof(p->'amount')='number' then p->'amount' end,
        'unit', p->'measureUnit'->>'name',
        'evidence', 'USDA FoodData Central portion'
      )))
      from jsonb_array_elements(coalesce(raw_food->'foodPortions','[]'::jsonb)) p
      where jsonb_typeof(p->'gramWeight')='number'
    ),'[]'::jsonb),
    'usda_fdc', fdc_id::text, 'reviewed',
    jsonb_build_object('provider','USDA FoodData Central','release',release_id,
      'recordId',fdc_id::text,'canonicalName',description,'familyReview','food-families-v1')
  from facts
  where calories is not null and protein is not null and carbs is not null and fat is not null
  on conflict (source,source_id) do update set
    name=excluded.name, serving_label=excluded.serving_label, serving_grams=excluded.serving_grams,
    calories=excluded.calories, protein=excluded.protein, carbs=excluded.carbs, fat=excluded.fat,
    measures=excluded.measures, provenance=excluded.provenance, updated_at=now()
  returning id, source_id
)
insert into public.food_catalog_family_variants(
  family_key,catalog_id,release_id,source_revision,variant_summary,dimensions,nutrition_snapshot,common_order
)
select f.family_key, i.id, f.release_id, f.release_id || ':' || f.fdc_id,
  f.summary, f.dimensions,
  jsonb_build_object(
    'version',1,
    'source',jsonb_build_object('provider','USDA FoodData Central','recordId',f.fdc_id::text,
      'release',f.release_id,'revision',f.release_id || ':' || f.fdc_id,'canonicalName',f.description),
    'basis',jsonb_build_object('amount',100,'unit','g','label','100 g','grams',100),
    'nutrients',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',n->'nutrient'->>'id','name',n->'nutrient'->>'name',
        'unit',n->'nutrient'->>'unitName','amount',(n->>'amount')::numeric
      ) order by ord)
      from jsonb_array_elements(f.raw_food->'foodNutrients') with ordinality x(n,ord)
      where jsonb_typeof(n->'amount')='number'
        and not exists (
          select 1 from jsonb_array_elements(f.raw_food->'foodNutrients') with ordinality prior(p,pord)
          where pord < ord and p->'nutrient'->>'id'=n->'nutrient'->>'id'
            and jsonb_typeof(p->'amount')='number'
        )
    ),'[]'::jsonb),
    'portions',jsonb_build_array(
      jsonb_build_object('id','g','label','grams','unit','g','dimension','weight','basisMultiplier',0.01,'grams',1,'evidence','USDA 100 g nutrient basis'),
      jsonb_build_object('id','oz','label','ounces','unit','oz','dimension','weight','basisMultiplier',0.28349523125,'grams',28.349523125,'evidence','Exact international avoirdupois conversion')
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'id','usda-portion-' || ord,'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
        'unit',coalesce(p->'measureUnit'->>'name','serving'),
        'dimension',case when lower(coalesce(p->'measureUnit'->>'name','')) ~ 'cup|tablespoon|teaspoon|fluid'
          then 'volume' when lower(coalesce(p->'measureUnit'->>'name','')) ~ 'serving'
          then 'serving' else 'count' end,
        'basisMultiplier',(p->>'gramWeight')::numeric/100,
        'grams',(p->>'gramWeight')::numeric,'evidence','USDA FoodData Central portion'
      ) order by ord)
      from jsonb_array_elements(coalesce(f.raw_food->'foodPortions','[]'::jsonb)) with ordinality x(p,ord)
      where jsonb_typeof(p->'gramWeight')='number'
    ),'[]'::jsonb),
    'variant',jsonb_build_object('familyKey',f.family_key,'summary',f.summary,'dimensions',f.dimensions),
    'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
    'provenance',f.provenance
  ),1
from facts f join inserted i on i.source_id=f.fdc_id::text;

update public.food_catalog_items item
set nutrition_snapshot=variant.nutrition_snapshot
from public.food_catalog_family_variants variant
where variant.catalog_id=item.id;

update public.food_catalog_families family
set default_catalog_id=variant.catalog_id
from public.food_catalog_family_variants variant
where variant.family_key=family.family_key and variant.common_order=1;

insert into public.food_catalog_aliases(catalog_id,alias)
select v.catalog_id, alias
from public.food_catalog_families f
join public.food_catalog_family_variants v on v.family_key=f.family_key
cross join unnest(f.aliases) alias
on conflict (catalog_id,alias) do nothing;

create or replace function public.search_food_catalog_grouped(
  p_patient_id uuid, p_query text, p_approved_only boolean default false,
  p_limit integer default 6, p_offset integer default 0
) returns jsonb language sql stable security definer set search_path=public
as $$
  with q as (
    select lower(trim(regexp_replace(p_query,'[^a-zA-Z0-9%/]+',' ','g'))) value
  ), family_hits as (
    select f.family_key, max(case when lower(a)=q.value then 2000
      when lower(a) like q.value || '%' then 1400
      else similarity(lower(a),q.value)*1000 end) relevance
    from food_catalog_families f cross join unnest(f.aliases) a cross join q
    where (lower(a) % q.value or lower(a) like '%'||q.value||'%' or q.value like '%'||lower(a)||'%')
      and not (f.family_key='meatballs' and q.value like '%meatless%')
      and not (
        f.family_key='ground-beef'
        and q.value ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})'
        and q.value !~ '(90%|90/10)'
      )
    group by f.family_key
  ), family_candidates as (
    select ('family:'||f.family_key) result_key, f.family_key, f.name,
      v.catalog_id, v.variant_summary, v.dimensions, v.nutrition_snapshot,
      fh.relevance + least(coalesce(u.selection_count,0),100) rank
    from family_hits fh join food_catalog_families f using(family_key)
    join lateral (
      select candidate.*
      from food_catalog_family_variants candidate
      where candidate.family_key=f.family_key
        and (not p_approved_only or exists (
          select 1 from food_catalog_approved_links eligible
          where eligible.catalog_id=candidate.catalog_id
        ))
      order by (candidate.catalog_id=f.default_catalog_id) desc,
        candidate.common_order,candidate.catalog_id
      limit 1
    ) v on true
    left join food_catalog_usage u on u.catalog_id=v.catalog_id and u.patient_id=p_patient_id
  ), singleton_candidates as (
    select 'food:'||c.id result_key, null::text family_key, c.name,
      c.id catalog_id, null::text variant_summary, null::jsonb dimensions,
      c.nutrition_snapshot, (case when c.search_text=q.value then 1500
        when c.search_text like q.value||'%' then 1000 else 500 end)
        + similarity(c.search_text,q.value)*100
        + least(coalesce(u.selection_count,0),100) rank
    from food_catalog_items c cross join q
    left join food_catalog_usage u on u.catalog_id=c.id and u.patient_id=p_patient_id
    where c.kind='generic'
      and not exists(select 1 from food_catalog_family_variants v where v.catalog_id=c.id)
      and not (
        q.value like '%beef%'
        and q.value ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})'
      )
      and (c.search_text % q.value or c.search_text like '%'||q.value||'%')
      and (not p_approved_only or exists(
        select 1 from food_catalog_approved_links l where l.catalog_id=c.id
      ))
    union all
    select 'private:'||p.food_id, null::text, p.name, null::uuid, null::text,
      null::jsonb, null::jsonb,
      (case when lower(p.name)=q.value then 1600
        when lower(p.name) like q.value||'%' then 900 else 450 end)
        + similarity(lower(p.name||' '||coalesce(p.brand,'')),q.value)*100
    from patient_custom_foods p cross join q
    where p.patient_id=p_patient_id and not p_approved_only
      and lower(p.name||' '||coalesce(p.brand,'')) like '%'||q.value||'%'
  ), candidates as (
    select * from family_candidates
    union all select * from singleton_candidates
  ), rows as (
    select coalesce(c.id::text, replace(x.result_key,'private:','')) id,
      coalesce(c.kind,'personal') kind,x.name,coalesce(c.brand,p.brand) brand,
      coalesce(c.serving_label,p.serving) serving,c.serving_grams,
      coalesce(c.calories,p.calories) calories,coalesce(c.protein,p.protein) protein,
      coalesce(c.carbs,p.carbs) carbs,coalesce(c.fat,p.fat) fat,
      coalesce(c.measures,'[]'::jsonb) measures,coalesce(c.source,'patient') source,
      coalesce(c.source_id,p.food_id) source_id,c.barcode,coalesce(c.quality_status,'private') quality_status,
      coalesce((select jsonb_agg(jsonb_build_object('id',l.approved_food_id,'name',l.official_name,
        'portion',l.official_portion,'phaseGuidance',l.phase_guidance,'constraints',l.constraints))
        from food_catalog_approved_links l where l.catalog_id=c.id),'[]'::jsonb) approvals,
      x.result_key "resultKey",x.family_key "familyKey",x.variant_summary "variantSummary",
      x.dimensions,false "choiceRequired",x.nutrition_snapshot "nutritionSnapshot",x.rank
    from candidates x
    left join food_catalog_items c on c.id=x.catalog_id
    left join patient_custom_foods p on x.result_key='private:'||p.food_id and p.patient_id=p_patient_id
    order by x.rank desc,x.result_key
    offset greatest(p_offset,0) limit least(greatest(p_limit,1),7)
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(rows)-'rank')),'[]'::jsonb) from rows;
$$;

create or replace function public.get_food_catalog_family(
  p_family_key text, p_approved_only boolean default false
) returns jsonb language sql stable security definer set search_path=public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id::text,'kind',c.kind,'name',f.name,'brand',c.brand,'serving',c.serving_label,
    'serving_grams',c.serving_grams,'calories',c.calories,'protein',c.protein,'carbs',c.carbs,
    'fat',c.fat,'measures',c.measures,'source',c.source,'source_id',c.source_id,'barcode',c.barcode,
    'quality_status',c.quality_status,'approvals',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.approved_food_id,'name',l.official_name,'portion',l.official_portion,
      'phaseGuidance',l.phase_guidance,'constraints',l.constraints))
      from food_catalog_approved_links l where l.catalog_id=c.id),'[]'::jsonb),
    'resultKey','family:'||f.family_key||':'||c.id,'familyKey',f.family_key,
    'variantSummary',v.variant_summary,'dimensions',v.dimensions,'choiceRequired',false,
    'nutritionSnapshot',v.nutrition_snapshot
  ) order by v.common_order,c.id),'[]'::jsonb)
  from food_catalog_families f join food_catalog_family_variants v using(family_key)
  join food_catalog_items c on c.id=v.catalog_id
  where f.family_key=p_family_key
    and (not p_approved_only or exists(select 1 from food_catalog_approved_links l where l.catalog_id=c.id));
$$;

revoke all on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer),
  public.get_food_catalog_family(text,boolean) from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer),
  public.get_food_catalog_family(text,boolean) to service_role;
notify pgrst,'reload schema';
commit;