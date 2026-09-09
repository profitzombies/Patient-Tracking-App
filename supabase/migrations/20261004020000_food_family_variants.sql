begin;

create temporary table reviewed_food_variants (
  family_key text not null,
  release_id text not null,
  fdc_id bigint not null,
  display_name text not null,
  variant_summary text not null,
  dimensions jsonb not null,
  common_order integer not null,
  provenance_kind text not null
) on commit drop;

insert into reviewed_food_variants values
  ('ground-beef','sr-legacy-2018-04',174030,'Ground Beef','90% lean / 10% fat · Raw','{"leanness":"90% lean / 10% fat","state":"raw"}',1,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',171794,'Ground Beef','90% lean / 10% fat · Cooked, pan-browned crumbles','{"leanness":"90% lean / 10% fat","state":"cooked","preparation":"pan-browned crumbles"}',2,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',171796,'Ground Beef','85% lean / 15% fat · Raw','{"leanness":"85% lean / 15% fat","state":"raw"}',3,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',174034,'Ground Beef','85% lean / 15% fat · Cooked, pan-browned crumbles','{"leanness":"85% lean / 15% fat","state":"cooked","preparation":"pan-browned crumbles"}',4,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',174036,'Ground Beef','80% lean / 20% fat · Raw','{"leanness":"80% lean / 20% fat","state":"raw"}',5,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',171799,'Ground Beef','80% lean / 20% fat · Cooked, pan-browned crumbles','{"leanness":"80% lean / 20% fat","state":"cooked","preparation":"pan-browned crumbles"}',6,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',171790,'Ground Beef','95% lean / 5% fat · Raw','{"leanness":"95% lean / 5% fat","state":"raw"}',7,'generic_source'),
  ('ground-beef','sr-legacy-2018-04',174028,'Ground Beef','95% lean / 5% fat · Cooked, pan-browned crumbles','{"leanness":"95% lean / 5% fat","state":"cooked","preparation":"pan-browned crumbles"}',8,'generic_source'),
  ('chicken-breast','fndds-2021-2023',2705956,'Chicken Breast','Roasted · Skin not eaten','{"preparation":"baked, broiled, or roasted","skin":"not eaten","state":"cooked"}',1,'generic_source'),
  ('chicken-breast','fndds-2021-2023',2705955,'Chicken Breast','Roasted · Skin eaten','{"preparation":"baked, broiled, or roasted","skin":"eaten","state":"cooked"}',2,'generic_source'),
  ('chicken-thighs','fndds-2021-2023',2706029,'Chicken Thighs','Roasted · Skin eaten','{"preparation":"baked, broiled, or roasted","skin":"eaten","state":"cooked"}',1,'generic_source'),
  ('chicken-thighs','fndds-2021-2023',2706030,'Chicken Thighs','Roasted · Skin not eaten','{"preparation":"baked, broiled, or roasted","skin":"not eaten","state":"cooked"}',2,'generic_source'),
  ('chicken-wings','fndds-2021-2023',2706057,'Chicken Wings','Roasted','{"preparation":"baked, broiled, or roasted","state":"cooked"}',1,'generic_source'),
  ('chicken-wings','fndds-2021-2023',2706065,'Chicken Wings','Fried · Coated','{"preparation":"fried","coating":"coated","state":"cooked"}',2,'generic_source'),
  ('eggs','fndds-2021-2023',2707153,'Eggs','Whole · Cooked','{"form":"whole","preparation":"cooked"}',1,'generic_source'),
  ('eggs','fndds-2021-2023',2707154,'Eggs','Whole · Boiled or poached','{"form":"whole","preparation":"boiled or poached"}',2,'generic_source'),
  ('eggs','fndds-2021-2023',2707158,'Eggs','Whole · Fried with oil','{"form":"whole","preparation":"fried with oil"}',3,'generic_source'),
  ('eggs','fndds-2021-2023',2707152,'Eggs','Whole · Raw','{"form":"whole","preparation":"raw"}',4,'generic_source'),
  ('eggs','fndds-2021-2023',2707170,'Eggs','White · Cooked, no added fat','{"form":"white","preparation":"cooked","added fat":"none"}',5,'generic_source'),
  ('eggs','fndds-2021-2023',2707168,'Eggs','White · Raw','{"form":"white","preparation":"raw"}',6,'generic_source'),
  ('rice','fndds-2021-2023',2708408,'Rice','White · Cooked · No added fat','{"type":"white","state":"cooked","added fat":"none"}',1,'generic_source'),
  ('rice','fndds-2021-2023',2708414,'Rice','Brown · Cooked · No added fat','{"type":"brown","state":"cooked","added fat":"none"}',2,'generic_source'),
  ('rice','sr-legacy-2018-04',168877,'Rice','White long-grain · Dry','{"type":"white long-grain","state":"dry"}',3,'generic_source'),
  ('rice','fndds-2021-2023',2708422,'Rice','White glutinous · Cooked','{"type":"white glutinous","state":"cooked"}',4,'generic_source'),
  ('yogurt','sr-legacy-2018-04',171284,'Yogurt','Plain · Whole milk','{"flavor":"plain","fat level":"whole milk"}',1,'generic_source'),
  ('yogurt','sr-legacy-2018-04',170886,'Yogurt','Plain · Low fat','{"flavor":"plain","fat level":"low fat"}',2,'generic_source'),
  ('yogurt','sr-legacy-2018-04',170887,'Yogurt','Plain · Skim milk','{"flavor":"plain","fat level":"skim milk"}',3,'generic_source');

-- Refuse partial review/promotion: every exact record must be in a ready
-- immutable release and must contain the four source macros.
do $$
begin
  if (select count(*) from reviewed_food_variants) <> 27 then
    raise exception 'expected 27 reviewed family variants';
  end if;
  if exists (
    select 1 from reviewed_food_variants v
    left join usda_source_releases r on r.id=v.release_id and r.status='ready'
    left join usda_source_foods f on f.release_id=v.release_id and f.fdc_id=v.fdc_id
    where r.id is null or f.fdc_id is null
      or exists (
        select 1 from (values ('1008'),('1003'),('1005'),('1004')) required(id)
        where not exists (
          select 1 from jsonb_array_elements(f.raw_food->'foodNutrients') n
          where n->'nutrient'->>'id'=required.id and jsonb_typeof(n->'amount')='number'
        )
      )
  ) then raise exception 'a reviewed variant is missing ready source evidence or macros';
  end if;
end $$;

with facts as (
  select v.*,f.description,f.raw_food,
    (select (n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n where n->'nutrient'->>'id'='1008' and jsonb_typeof(n->'amount')='number' limit 1) calories,
    (select (n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n where n->'nutrient'->>'id'='1003' and jsonb_typeof(n->'amount')='number' limit 1) protein,
    (select (n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n where n->'nutrient'->>'id'='1005' and jsonb_typeof(n->'amount')='number' limit 1) carbs,
    (select (n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n where n->'nutrient'->>'id'='1004' and jsonb_typeof(n->'amount')='number' limit 1) fat
  from reviewed_food_variants v join usda_source_foods f using(release_id,fdc_id)
)
insert into food_catalog_items(kind,name,brand,serving_label,serving_grams,calories,protein,carbs,fat,measures,source,source_id,quality_status,provenance)
select 'generic',display_name,null,'100 g',100,calories,protein,carbs,fat,
  coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
    'grams',p->'gramWeight','amount',p->'amount','unit',p->'measureUnit'->>'name',
    'evidence','USDA FoodData Central portion')))
    from jsonb_array_elements(coalesce(raw_food->'foodPortions','[]')) p
    where jsonb_typeof(p->'gramWeight')='number'),'[]'),
  'usda_fdc',fdc_id::text,'reviewed',
  jsonb_build_object('provider','USDA FoodData Central','release',release_id,
    'recordId',fdc_id::text,'canonicalName',description,'familyReview','food-families-v2')
from facts
on conflict(source,source_id) do update set
  name=excluded.name,brand=null,serving_label=excluded.serving_label,serving_grams=excluded.serving_grams,
  calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,
  measures=excluded.measures,provenance=excluded.provenance,updated_at=now();

with facts as (
  select v.*,f.description,f.raw_food,c.id catalog_id
  from reviewed_food_variants v join usda_source_foods f using(release_id,fdc_id)
  join food_catalog_items c on c.source='usda_fdc' and c.source_id=v.fdc_id::text
), snapshots as (
  select facts.*,jsonb_build_object(
    'version',1,
    'source',jsonb_build_object('provider','USDA FoodData Central','recordId',fdc_id::text,
      'release',release_id,'revision',release_id||':'||fdc_id,'canonicalName',description),
    'basis',jsonb_build_object('amount',100,'unit','g','label','100 g','grams',100),
    'nutrients',coalesce((select jsonb_agg(jsonb_build_object(
      'id',n->'nutrient'->>'id','name',n->'nutrient'->>'name',
      'unit',n->'nutrient'->>'unitName','amount',(n->>'amount')::numeric) order by ord)
      from jsonb_array_elements(raw_food->'foodNutrients') with ordinality x(n,ord)
      where jsonb_typeof(n->'amount')='number' and not exists (
        select 1 from jsonb_array_elements(raw_food->'foodNutrients') with ordinality prior(p,pord)
        where pord<ord and p->'nutrient'->>'id'=n->'nutrient'->>'id'
          and jsonb_typeof(p->'amount')='number')),'[]'),
    'portions',jsonb_build_array(
      jsonb_build_object('id','g','label','grams','unit','g','dimension','weight','basisMultiplier',0.01,'grams',1,'evidence','USDA 100 g nutrient basis'),
      jsonb_build_object('id','oz','label','ounces','unit','oz','dimension','weight','basisMultiplier',0.28349523125,'grams',28.349523125,'evidence','Exact international avoirdupois conversion')
    ) || coalesce((select jsonb_agg(jsonb_build_object(
      'id','usda-portion-'||ord,
      'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
      'unit',coalesce(p->'measureUnit'->>'name','serving'),
      'dimension',case when lower(coalesce(p->'measureUnit'->>'name','')) ~ 'cup|tablespoon|teaspoon|fluid' then 'volume'
        when lower(coalesce(p->'measureUnit'->>'name','')) ~ 'serving' then 'serving' else 'count' end,
      'basisMultiplier',(p->>'gramWeight')::numeric/100,'grams',(p->>'gramWeight')::numeric,
      'evidence','USDA FoodData Central portion') order by ord)
      from jsonb_array_elements(coalesce(raw_food->'foodPortions','[]')) with ordinality x(p,ord)
      where jsonb_typeof(p->'gramWeight')='number'),'[]'),
    'variant',jsonb_build_object('familyKey',family_key,'summary',variant_summary,'dimensions',dimensions),
    'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
    'provenance',provenance_kind
  ) snapshot
  from facts
), variants as (
  insert into food_catalog_family_variants(
    family_key,catalog_id,release_id,source_revision,variant_summary,dimensions,nutrition_snapshot,common_order
  )
  select family_key,catalog_id,release_id,release_id||':'||fdc_id,
    variant_summary,dimensions,snapshot,common_order from snapshots
  on conflict(family_key,catalog_id) do update set
    release_id=excluded.release_id,source_revision=excluded.source_revision,
    variant_summary=excluded.variant_summary,dimensions=excluded.dimensions,
    nutrition_snapshot=excluded.nutrition_snapshot,common_order=excluded.common_order
  returning catalog_id,nutrition_snapshot
)
update food_catalog_items c set nutrition_snapshot=v.nutrition_snapshot
from variants v where v.catalog_id=c.id;

update food_catalog_families set
  aliases=case family_key
    when 'ground-beef' then array['ground beef','beef ground','80% ground beef','80/20 beef','85% ground beef','85/15 beef','90% ground beef','90/10 beef','95% ground beef','95/5 beef']
    when 'chicken-breast' then array['chicken breast','chicken breasts','skinless chicken breast','roasted chicken breast']
    when 'chicken-thighs' then array['chicken thigh','chicken thighs','skinless chicken thighs','roasted chicken thighs']
    when 'chicken-wings' then array['chicken wing','chicken wings','roasted chicken wings','fried chicken wings']
    when 'eggs' then array['egg','eggs','egg white','egg whites','boiled egg','fried egg']
    when 'rice' then array['rice','cooked rice','white rice','brown rice','dry rice','glutinous rice']
    when 'yogurt' then array['yogurt','plain yogurt','whole milk yogurt','low fat yogurt','skim milk yogurt']
    else aliases end,
  review_version='food-families-v2';

update food_catalog_families f set default_catalog_id=c.id
from food_catalog_items c
where (f.family_key='rice' and c.source='usda_fdc' and c.source_id='2708408')
   or (f.family_key='ground-beef' and c.source='usda_fdc' and c.source_id='174030');

create or replace function public.search_food_catalog_grouped(
  p_patient_id uuid,p_query text,p_approved_only boolean default false,
  p_limit integer default 6,p_offset integer default 0
) returns jsonb language sql stable security definer set search_path=public as $$
with q as (
  select lower(trim(regexp_replace(p_query,'[^a-zA-Z0-9%/]+',' ','g'))) value
), family_hits as (
  select f.family_key,max(case when lower(a)=q.value then 2000 when lower(a) like q.value||'%' then 1400 else similarity(lower(a),q.value)*1000 end) relevance
  from food_catalog_families f cross join unnest(f.aliases) a cross join q
  where (lower(a)%q.value or lower(a) like '%'||q.value||'%' or q.value like '%'||lower(a)||'%')
    and not(f.family_key='meatballs' and q.value like '%meatless%')
  group by f.family_key
), family_candidates as (
  select 'family:'||f.family_key result_key,f.family_key,f.name,v.catalog_id,
    v.variant_summary,v.dimensions,v.nutrition_snapshot,
    fh.relevance+least(coalesce(u.selection_count,0),100) rank
  from family_hits fh join food_catalog_families f using(family_key) cross join q
  join lateral (
    select candidate.* from food_catalog_family_variants candidate
    where candidate.family_key=f.family_key
      and (not p_approved_only or exists(select 1 from food_catalog_approved_links eligible where eligible.catalog_id=candidate.catalog_id))
      and (f.family_key<>'ground-beef' or (
        (q.value !~ '(80%|80/20|85%|85/15|90%|90/10|95%|95/5)' or
          candidate.dimensions->>'leanness' like case
            when q.value ~ '(80%|80/20)' then '80%' when q.value ~ '(85%|85/15)' then '85%'
            when q.value ~ '(90%|90/10)' then '90%' when q.value ~ '(95%|95/5)' then '95%' end||'%')
        and (q.value not like '% raw%' or candidate.dimensions->>'state'='raw')
        and (q.value not like '%cooked%' or candidate.dimensions->>'state'='cooked')
        and (q.value !~ '(baked|broiled|grilled|fried)' or candidate.dimensions->>'preparation' ~ q.value)
      ))
      and (f.family_key not in ('chicken-breast','chicken-thighs','chicken-wings') or (
        (q.value !~ '(skinless|skin not)' or candidate.dimensions->>'skin'='not eaten')
        and (q.value !~ '(skin eaten|skin on)' or candidate.dimensions->>'skin'='eaten')
        and (q.value not like '%fried%' or candidate.dimensions->>'preparation'='fried')
        and (q.value !~ '(roasted|baked|broiled)' or candidate.dimensions->>'preparation' like '%roasted%')
      ))
      and (f.family_key<>'eggs' or (
        (q.value !~ 'egg whites?' or candidate.dimensions->>'form'='white')
        and (q.value not like '% raw%' or candidate.dimensions->>'preparation'='raw')
        and (q.value not like '%fried%' or candidate.dimensions->>'preparation' like 'fried%')
        and (q.value !~ '(boiled|poached)' or candidate.dimensions->>'preparation'='boiled or poached')
      ))
      and (f.family_key<>'rice' or (
        (q.value not like '%brown%' or candidate.dimensions->>'type' like 'brown%')
        and (q.value not like '%white%' or candidate.dimensions->>'type' like 'white%')
        and (q.value !~ '(dry|raw|uncooked)' or candidate.dimensions->>'state'='dry')
        and (q.value not like '%cooked%' or candidate.dimensions->>'state'='cooked')
        and (q.value not like '%glutinous%' or candidate.dimensions->>'type'='white glutinous')
      ))
      and (f.family_key<>'yogurt' or (
        (q.value !~ '(low fat|lowfat)' or candidate.dimensions->>'fat level'='low fat')
        and (q.value !~ '(skim|nonfat|fat free)' or candidate.dimensions->>'fat level'='skim milk')
        and (q.value not like '%whole milk%' or candidate.dimensions->>'fat level'='whole milk')
      ))
    order by (candidate.catalog_id=f.default_catalog_id) desc,candidate.common_order,candidate.catalog_id limit 1
  ) v on true
  left join food_catalog_usage u on u.catalog_id=v.catalog_id and u.patient_id=p_patient_id
), singleton_candidates as (
  select 'food:'||c.id result_key,null::text family_key,c.name,c.id catalog_id,
    null::text variant_summary,null::jsonb dimensions,c.nutrition_snapshot,
    (case when c.search_text=q.value then 1500 when c.search_text like q.value||'%' then 1000 else 500 end)
      +similarity(c.search_text,q.value)*100+least(coalesce(u.selection_count,0),100) rank
  from food_catalog_items c cross join q
  left join food_catalog_usage u on u.catalog_id=c.id and u.patient_id=p_patient_id
  where c.kind='generic'
    and not exists(select 1 from food_catalog_family_variants v where v.catalog_id=c.id)
    and lower(c.name) !~ '^(beef, ground,|ground beef$|chicken breast,|chicken thigh,|chicken wing,|eggs?, (whole|white)|rice, (white|brown), (long-grain|medium-grain|short-grain|cooked|raw)|yogurt, plain)'
    and (c.search_text%q.value or c.search_text like '%'||q.value||'%')
    and (not p_approved_only or exists(select 1 from food_catalog_approved_links l where l.catalog_id=c.id))
  union all
  select 'private:'||p.food_id,null::text,p.name,null::uuid,null::text,null::jsonb,null::jsonb,
    (case when lower(p.name)=q.value then 1600 when lower(p.name) like q.value||'%' then 900 else 450 end)
      +similarity(lower(p.name||' '||coalesce(p.brand,'')),q.value)*100
  from patient_custom_foods p cross join q
  where p.patient_id=p_patient_id and not p_approved_only
    and lower(p.name||' '||coalesce(p.brand,'')) like '%'||q.value||'%'
), candidates as (
  select * from family_candidates union all select * from singleton_candidates
), rows as (
  select coalesce(c.id::text,replace(x.result_key,'private:','')) id,coalesce(c.kind,'personal') kind,
    x.name,coalesce(c.brand,p.brand) brand,coalesce(c.serving_label,p.serving) serving,c.serving_grams,
    coalesce(c.calories,p.calories) calories,coalesce(c.protein,p.protein) protein,
    coalesce(c.carbs,p.carbs) carbs,coalesce(c.fat,p.fat) fat,coalesce(c.measures,'[]') measures,
    coalesce(c.source,'patient') source,coalesce(c.source_id,p.food_id) source_id,c.barcode,
    coalesce(c.quality_status,'private') quality_status,
    coalesce((select jsonb_agg(jsonb_build_object('id',l.approved_food_id,'name',l.official_name,
      'portion',l.official_portion,'phaseGuidance',l.phase_guidance,'constraints',l.constraints))
      from food_catalog_approved_links l where l.catalog_id=c.id),'[]') approvals,
    x.result_key "resultKey",x.family_key "familyKey",x.variant_summary "variantSummary",
    x.dimensions,false "choiceRequired",x.nutrition_snapshot "nutritionSnapshot",x.rank
  from candidates x left join food_catalog_items c on c.id=x.catalog_id
  left join patient_custom_foods p on x.result_key='private:'||p.food_id and p.patient_id=p_patient_id
  order by x.rank desc,x.result_key offset greatest(p_offset,0) limit least(greatest(p_limit,1),7)
)
select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(rows)-'rank')),'[]') from rows;
$$;

revoke all on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;