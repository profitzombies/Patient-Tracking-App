begin;

-- This table is the authoritative release decision for every shared catalog row.
-- It is service-only metadata: the immutable USDA archive remains unchanged.
create table if not exists public.food_catalog_curation (
  catalog_id uuid primary key references public.food_catalog_items(id) on delete cascade,
  eligibility text not null check (eligibility in ('reviewed_family','safe_singleton','excluded')),
  friendly_name text not null,
  category text,
  reason text not null,
  review_version text not null,
  source_revision text,
  reviewed_at timestamptz not null default now()
);
alter table public.food_catalog_curation enable row level security;
revoke all on public.food_catalog_curation from public,anon,authenticated;
grant select on public.food_catalog_curation to service_role;

create table if not exists public.food_catalog_query_resolutions (
  misspelling text primary key check (misspelling=lower(misspelling)),
  replacement text not null,
  resolution text not null check (resolution in ('automatic','suggestion')),
  review_version text not null
);
alter table public.food_catalog_query_resolutions enable row level security;
revoke all on public.food_catalog_query_resolutions from public,anon,authenticated;
grant select on public.food_catalog_query_resolutions to service_role;

insert into public.food_catalog_query_resolutions(misspelling,replacement,resolution,review_version) values
  ('aple','apple','automatic','everyday-foods-v3'),
  ('bannana','banana','automatic','everyday-foods-v3'),
  ('brocoli','broccoli','automatic','everyday-foods-v3'),
  ('chiken','chicken','automatic','everyday-foods-v3'),
  ('strawbery','strawberry','automatic','everyday-foods-v3'),
  ('avacado','avocado','automatic','everyday-foods-v3'),
  ('spinich','spinach','automatic','everyday-foods-v3'),
  ('yogart','yogurt','automatic','everyday-foods-v3'),
  ('qunioa','quinoa','automatic','everyday-foods-v3'),
  ('mayonaise','mayonnaise','automatic','everyday-foods-v3'),
  ('stake','steak','suggestion','everyday-foods-v3'),
  ('flower','flour','suggestion','everyday-foods-v3'),
  ('serial','cereal','suggestion','everyday-foods-v3')
on conflict(misspelling) do update set replacement=excluded.replacement,
  resolution=excluded.resolution,review_version=excluded.review_version;

create temporary table reviewed_everyday(
  family_key text,release_id text,fdc_id bigint,display_name text,
  category text,variant_summary text,dimensions jsonb,provenance text
) on commit drop;

with selected as (
  select source_id,display_name,ord
  from unnest(array[
    171505,168251,168249,168728,173810,171098,172373,174611,172476,174272,
    175138,175159,175180,171955,175176,175153,174205,174209,175139,167742,
    170379,169961,170026,168482,170393,168462,169986,168389,169291,168409,
    169097,167762,171711,174683,169118,169928,169124,167765,169910,171705,
    173904,168917,170285,172688,168928,169697,169700,173241,167533,172762,
    173735,175194,173757,172421,175200,173746,172429,174253,174271,172454,
    172179,171265,170899,170845,173418,171257,173410,171251,170851,173420,
    172470,170567,170187,170162,170184,170182,170562,170556,170554,170150,
    172234,171009,172473,174524,174527,172237,168561,174523,169640,169661,
    173647,171890,173227,169099,173933,170174,170458,173041,173217,174678
  ]::bigint[],array[
    'Ground Turkey','Pork Chops','Pork Tenderloin','Sirloin Steak','Lamb Chops',
    'Turkey Breast','Chicken Drumsticks','Ham','Tofu','Tempeh',
    'Salmon','Tuna','Shrimp','Cod','Tilapia','Trout','Crab','Lobster','Sardines','Scallops',
    'Broccoli','Green Beans','Potatoes','Sweet Potatoes','Carrots','Spinach','Cauliflower',
    'Asparagus','Zucchini','Cucumber','Oranges','Strawberries','Blueberries','Grapes',
    'Pears','Peaches','Pineapple','Watermelon','Mangoes','Avocados',
    'Oatmeal','Quinoa','Barley','Whole Wheat Bread','Pasta','Cornmeal','Couscous',
    'Corn Tortillas','Bagels','English Muffins','Black Beans','Kidney Beans','Chickpeas',
    'Lentils','Pinto Beans','Navy Beans','Split Peas','Lima Beans','Soybeans','Hummus',
    'Cottage Cheese','Whole Milk','Cheddar Cheese','Mozzarella Cheese','Cream Cheese',
    'Sour Cream','Butter','Swiss Cheese','Ricotta Cheese','Feta Cheese','Peanut Butter',
    'Almonds','Walnuts','Cashews','Pistachios','Pecans','Sunflower Seeds','Pumpkin Seeds',
    'Chia Seeds','Sesame Seeds','Mustard','Mayonnaise','Soy Sauce','Salsa','Hot Sauce',
    'Vinegar','Relish','Barbecue Sauce','Honey','Maple Syrup','Water','Coffee','Tea',
    'Orange Juice','Apple Juice','Coconut Water','Tomato Juice','Grape Juice','Lemonade',
    'Grapefruit Juice'
  ]::text[]) with ordinality x(source_id,display_name,ord)
), facts as (
  select s.*,f.release_id,f.description,
    case when lower(f.description)~'\m(raw|unprepared)\M' then 'Raw'
      when lower(f.description)~'\m(cooked|boiled|steamed|broiled|roasted)\M' then 'Cooked'
      when lower(f.description)~'\m(canned|bottled)\M' then 'Prepared'
      when lower(f.description)~'\m(dry|dried|uncooked)\M' then 'Dry'
      else 'Generic' end variant_summary,
    jsonb_strip_nulls(jsonb_build_object(
      'state',case when lower(f.description)~'\m(raw|unprepared)\M' then 'raw'
        when lower(f.description)~'\m(cooked|boiled|steamed|broiled|roasted)\M' then 'cooked'
        when lower(f.description)~'\m(canned|bottled)\M' then 'prepared'
        when lower(f.description)~'\m(dry|dried|uncooked)\M' then 'dry' end,
      'skin',case when lower(f.description) like '%skin%' then
        case when lower(f.description)~'skinless|skin not eaten' then 'not eaten' else 'eaten' end end
    )) dimensions
  from selected s join public.usda_source_foods f on f.fdc_id=s.source_id
  join public.usda_source_releases r on r.id=f.release_id and r.status='ready'
)
insert into reviewed_everyday
select 'everyday-'||trim(both '-' from regexp_replace(lower(display_name),'[^a-z0-9]+','-','g')),
  release_id,source_id,display_name,
  (array['proteins','seafood','vegetables','fruits','grains','legumes','dairy','nuts','condiments','beverages'])
    [ceil(ord/10.0)::integer],
  variant_summary,dimensions,
  case when source_id=170026 then 'generic_source_estimate' else 'generic_source' end
from facts;

do $$
begin
  if (select count(*) from reviewed_everyday)<>100
     or (select count(distinct fdc_id) from reviewed_everyday)<>100 then
    raise exception 'everyday review must contain 100 distinct source identities';
  end if;
  if exists(
    select 1 from reviewed_everyday e
    join usda_source_foods f on f.release_id=e.release_id and f.fdc_id=e.fdc_id
    where exists(
      select 1 from (values('1008'),('1003'),('1005'),('1004')) required(id)
      where not exists(select 1 from jsonb_array_elements(f.raw_food->'foodNutrients') n
        where n->'nutrient'->>'id'=required.id and jsonb_typeof(n->'amount')='number')
    )
  ) then raise exception 'reviewed source macro evidence is incomplete'; end if;
end $$;

-- Families must exist before the reviewed additional variants are attached.
insert into public.food_catalog_families(family_key,name,aliases,review_version)
select family_key,display_name,
  array[lower(display_name),case when lower(display_name)like'%s'
    then left(lower(display_name),-1)else lower(display_name)||'s'end],
  'everyday-foods-v3'
from reviewed_everyday
on conflict(family_key)do update set name=excluded.name,aliases=excluded.aliases,
  review_version=excluded.review_version;

-- Common identities receive additional exact choices when the archive supports
-- a materially different state/form. These do not increase the identity count.
create or replace function public.build_food_catalog_source_snapshot(
  p_release_id text,p_fdc_id bigint,p_family_key text,p_summary text,
  p_dimensions jsonb,p_provenance text
) returns jsonb language sql stable security definer set search_path=public as $$
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
    where jsonb_typeof(n->'amount')='number' and not exists(
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
      'id','usda-portion-'||ord,
      'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
      'unit',coalesce(p->'measureUnit'->>'name','serving'),
      'dimension',case when lower(coalesce(p->'measureUnit'->>'name',''))~
        'cup|tablespoon|teaspoon|fluid' then 'volume'
        when lower(coalesce(p->'measureUnit'->>'name',''))~'serving' then 'serving'
        else 'count' end,
      'basisMultiplier',(p->>'gramWeight')::numeric/100,
      'grams',(p->>'gramWeight')::numeric,
      'evidence','USDA FoodData Central portion'
    )order by ord)
    from jsonb_array_elements(coalesce(f.raw_food->'foodPortions','[]'))with ordinality x(p,ord)
    where jsonb_typeof(p->'gramWeight')='number'
      and lower(coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name',''))
        not in('quantity not specified','amount not specified','')
  ),'[]'),
  'variant',jsonb_build_object('familyKey',p_family_key,'summary',p_summary,'dimensions',p_dimensions),
  'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
  'provenance',p_provenance
) from usda_source_foods f join usda_source_releases r on r.id=f.release_id and r.status='ready'
where f.release_id=p_release_id and f.fdc_id=p_fdc_id;
$$;
revoke all on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.build_food_catalog_source_snapshot(text,bigint,text,text,jsonb,text)
  to service_role;

create temporary table reviewed_everyday_extra(
  family_key text,release_id text,fdc_id bigint,display_name text,
  variant_summary text,dimensions jsonb,common_order integer,provenance text
)on commit drop;
insert into reviewed_everyday_extra values
  ('everyday-ground-turkey','sr-legacy-2018-04',171506,'Ground Turkey','Cooked','{"state":"cooked"}',2,'generic_source'),
  ('everyday-ground-turkey','sr-legacy-2018-04',172850,'Ground Turkey','93% lean / 7% fat · Raw','{"state":"raw","leanness":"93% lean / 7% fat"}',3,'generic_source'),
  ('everyday-ground-turkey','sr-legacy-2018-04',172851,'Ground Turkey','93% lean / 7% fat · Cooked','{"state":"cooked","leanness":"93% lean / 7% fat","preparation":"pan-broiled"}',4,'generic_source'),
  ('everyday-broccoli','sr-legacy-2018-04',168510,'Broccoli','Cooked · Boiled · Salt added','{"state":"cooked","preparation":"boiled","salt":"added"}',2,'generic_source'),
  ('everyday-carrots','sr-legacy-2018-04',168518,'Carrots','Canned · No salt added','{"state":"prepared","preparation":"canned","salt":"none added"}',2,'generic_source'),
  ('everyday-carrots','sr-legacy-2018-04',168519,'Carrots','Frozen · Cooked · Boiled','{"state":"cooked","preparation":"boiled","form":"frozen"}',3,'generic_source'),
  ('everyday-spinach','sr-legacy-2018-04',168463,'Spinach','Cooked · Boiled · No salt added','{"state":"cooked","preparation":"boiled","salt":"none added"}',2,'generic_source'),
  ('everyday-spinach','sr-legacy-2018-04',169287,'Spinach','Frozen · Unprepared','{"state":"raw","form":"frozen"}',3,'generic_source'),
  ('everyday-spinach','sr-legacy-2018-04',169285,'Spinach','Canned','{"state":"prepared","preparation":"canned"}',4,'generic_source'),
  ('everyday-potatoes','sr-legacy-2018-04',170093,'Potatoes','Baked · Flesh and skin · No salt added','{"state":"cooked","preparation":"baked","skin":"eaten","salt":"none added"}',2,'generic_source_estimate'),
  ('everyday-salmon','sr-legacy-2018-04',172001,'Salmon','Cooked · Dry heat','{"state":"cooked","preparation":"dry heat"}',2,'generic_source'),
  ('everyday-salmon','sr-legacy-2018-04',173690,'Salmon','Canned','{"state":"prepared","preparation":"canned"}',3,'generic_source'),
  ('everyday-cottage-cheese','sr-legacy-2018-04',173417,'Cottage Cheese','Low fat · 1% milkfat','{"fat level":"low fat","milkfat":"1%"}',2,'generic_source'),
  ('everyday-cottage-cheese','sr-legacy-2018-04',172181,'Cottage Cheese','Nonfat · Dry curd','{"fat level":"nonfat","form":"dry curd"}',3,'generic_source'),
  ('everyday-peanut-butter','sr-legacy-2018-04',172469,'Peanut Butter','Chunky · No salt added','{"form":"chunky","salt":"none added"}',2,'generic_source'),
  ('everyday-peanut-butter','sr-legacy-2018-04',174266,'Peanut Butter','Smooth · Salt added','{"form":"smooth","salt":"added"}',3,'generic_source');

do $$
begin
  if (select count(*) from reviewed_everyday_extra)<>16 or exists(
    select 1 from reviewed_everyday_extra e
    left join usda_source_foods f using(release_id,fdc_id)
    left join usda_source_releases r on r.id=f.release_id and r.status='ready'
    where f.fdc_id is null or r.id is null
  ) then raise exception 'expanded everyday variant source review is incomplete'; end if;
end $$;

with facts as(
  select e.*,f.description,f.raw_food,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients')n
      where n->'nutrient'->>'id'='1008'and jsonb_typeof(n->'amount')='number'limit 1)calories,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients')n
      where n->'nutrient'->>'id'='1003'and jsonb_typeof(n->'amount')='number'limit 1)protein,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients')n
      where n->'nutrient'->>'id'='1005'and jsonb_typeof(n->'amount')='number'limit 1)carbs,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients')n
      where n->'nutrient'->>'id'='1004'and jsonb_typeof(n->'amount')='number'limit 1)fat,
    build_food_catalog_source_snapshot(e.release_id,e.fdc_id,e.family_key,
      e.variant_summary,e.dimensions,e.provenance)snapshot
  from reviewed_everyday_extra e join usda_source_foods f using(release_id,fdc_id)
),items as(
  insert into food_catalog_items(
    kind,name,brand,serving_label,serving_grams,calories,protein,carbs,fat,measures,
    source,source_id,quality_status,provenance,nutrition_snapshot
  )
  select'generic',display_name,null,'100 g',100,calories,protein,carbs,fat,
    (select coalesce(jsonb_agg(jsonb_build_object(
      'label',p->>'label','grams',p->'grams','unit',p->>'unit','evidence',p->>'evidence'
    )),'[]')from jsonb_array_elements(snapshot->'portions')p),
    'usda_fdc',fdc_id::text,'reviewed',
    jsonb_build_object('provider','USDA FoodData Central','release',release_id,
      'recordId',fdc_id::text,'canonicalName',description,
      'familyReview','everyday-foods-v3','mapping',provenance),snapshot
  from facts
  on conflict(source,source_id)do update set
    name=excluded.name,serving_label=excluded.serving_label,serving_grams=excluded.serving_grams,
    calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,
    measures=excluded.measures,provenance=excluded.provenance,
    nutrition_snapshot=excluded.nutrition_snapshot,updated_at=now()
  returning id,source_id,nutrition_snapshot
)insert into food_catalog_family_variants(
  family_key,catalog_id,release_id,source_revision,variant_summary,dimensions,
  nutrition_snapshot,common_order
)
select e.family_key,i.id,e.release_id,e.release_id||':'||e.fdc_id,e.variant_summary,
  e.dimensions,i.nutrition_snapshot,e.common_order
from reviewed_everyday_extra e join items i on i.source_id=e.fdc_id::text
on conflict(family_key,catalog_id)do update set
  source_revision=excluded.source_revision,variant_summary=excluded.variant_summary,
  dimensions=excluded.dimensions,nutrition_snapshot=excluded.nutrition_snapshot,
  common_order=excluded.common_order;

create or replace function public.resolve_food_catalog_query(
  p_query text,p_patient_id uuid default null
)
returns jsonb language sql stable security definer set search_path=public as $$
with normalized as (
  select lower(trim(regexp_replace(coalesce(p_query,''),'[^a-zA-Z0-9%/]+',' ','g'))) value
), owned_exact as (
  select exists(
    select 1 from patient_custom_foods p cross join normalized n
    where p.patient_id=p_patient_id
      and lower(trim(regexp_replace(p.name,'[^a-zA-Z0-9%/]+',' ','g')))=n.value
  ) found
), tokens as (
  select token,ord from normalized,
    unnest(string_to_array(value,' '))with ordinality t(token,ord)
), decisions as (
  select t.*,r.replacement,r.resolution
  from tokens t left join food_catalog_query_resolutions r on r.misspelling=t.token
), resolved as (
  select n.value,o.found,
    string_agg(case when not o.found and d.resolution='automatic'
      then d.replacement else d.token end,' ' order by d.ord) corrected,
    coalesce(array_agg(distinct regexp_replace(n.value,'(^| )'||d.token||'( |$)',
      '\1'||d.replacement||'\2','g'))filter(
        where not o.found and d.resolution='suggestion'
      ),'{}') suggestions
  from normalized n cross join owned_exact o left join decisions d on true
  group by n.value,o.found
)
select jsonb_strip_nulls(jsonb_build_object(
  'query',case when cardinality(suggestions)>0 then value else corrected end,
  'suggestions',to_jsonb(suggestions),
  'correctedQuery',case when cardinality(suggestions)=0 and corrected<>value then corrected end
)) from resolved;
$$;
revoke all on function public.resolve_food_catalog_query(text,uuid) from public,anon,authenticated;
grant execute on function public.resolve_food_catalog_query(text,uuid) to service_role;

create or replace function public.search_food_catalog_grouped_v2_core(
  p_patient_id uuid,p_query text,p_approved_only boolean default false,
  p_limit integer default 6,p_offset integer default 0
) returns jsonb language sql stable security definer set search_path=public as $$
with q0 as (
  select lower(trim(regexp_replace(coalesce(p_query,''),'[^a-zA-Z0-9%/]+',' ','g'))) value
), q as (
  select value,
    trim(regexp_replace(regexp_replace(value,
      '(^| )(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled|boiled|poached|steamed|canned|frozen|dry|skinless|[0-9]{2}%|[0-9]{2}/[0-9]{1,2})( |$)',
      ' ','g'),'\s+',' ','g')) base
  from q0
), eligible as (
  select c.*,cur.friendly_name,cur.eligibility
  from food_catalog_items c
  join food_catalog_curation cur on cur.catalog_id=c.id and cur.eligibility<>'excluded'
  where c.kind='generic'
    and(not p_approved_only or exists(
      select 1 from food_catalog_approved_links approved where approved.catalog_id=c.id
    ))
), family_hits as (
  select f.family_key,max(case when lower(a)=q.base then 3000
    else similarity(lower(a),q.base)*1000 end) relevance
  from food_catalog_families f cross join unnest(f.aliases)a cross join q
  where q.base<>'' and (lower(a)=q.base or similarity(lower(a),q.base)>=0.82)
    and not(f.family_key='meatballs' and q.value~'\mmeatless\M')
  group by f.family_key
), family_candidates as (
  select 'family:'||f.family_key result_key,f.family_key,f.name,
    v.catalog_id,v.variant_summary,v.dimensions,v.nutrition_snapshot,
    null::jsonb catalog_metadata,fh.relevance rank
  from family_hits fh join food_catalog_families f using(family_key) cross join q
  join lateral(
    select candidate.*
    from food_catalog_family_variants candidate
    join eligible ec on ec.id=candidate.catalog_id
    where candidate.family_key=f.family_key
      and(q.value!~'(^| )(raw|uncooked)( |$)' or candidate.dimensions->>'state'='raw')
      and(q.value!~'(^| )cooked( |$)' or candidate.dimensions->>'state'='cooked')
      and(q.value!~'(^| )canned( |$)' or candidate.dimensions->>'state'='prepared')
      and(q.value!~'(^| )dry( |$)' or candidate.dimensions->>'state'='dry')
      and(q.value!~'(^| )frozen( |$)' or
        candidate.variant_summary~*'frozen' or candidate.dimensions->>'state'='frozen')
      and(q.value!~'(^| )skinless( |$)' or candidate.dimensions->>'skin'='not eaten')
      and(q.value!~'(^| )grilled( |$)' or candidate.dimensions->>'preparation'='grilled')
      and(q.value!~'(^| )fried( |$)' or candidate.dimensions->>'preparation'~'fried')
      and(q.value!~'(^| )(roasted|baked|broiled)( |$)' or
        candidate.dimensions->>'preparation'~'roasted|baked|broiled')
      and(q.value!~'(^| )(boiled|poached)( |$)' or
        candidate.dimensions->>'preparation'~'boiled|poached')
      and(q.value!~'(^| )steamed( |$)' or candidate.dimensions->>'preparation'~'steamed')
      and(q.value!~'(80%|80/20)' or candidate.dimensions->>'leanness' like '80% lean%')
      and(q.value!~'(85%|85/15)' or candidate.dimensions->>'leanness' like '85% lean%')
      and(q.value!~'(90%|90/10)' or candidate.dimensions->>'leanness' like '90% lean%')
      and(q.value!~'(95%|95/5)' or candidate.dimensions->>'leanness' like '95% lean%')
      and(q.value!~'(93%|93/7)' or candidate.dimensions->>'leanness' like '93% lean%')
    order by(candidate.catalog_id=f.default_catalog_id)desc,candidate.common_order,candidate.catalog_id
    limit 1
  )v on true
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
), singleton_candidates as (
  select 'food:'||c.id result_key,null::text family_key,c.friendly_name name,c.id catalog_id,
    null::text variant_summary,null::jsonb dimensions,c.nutrition_snapshot,
    null::jsonb catalog_metadata,
    case when c.search_text=q.value then 2200
      when c.search_text like q.value||'%' then 1800 else 1200 end rank
  from singleton_blobs c cross join q
  where q.value<>''
    and not exists(select 1 from family_hits)
    and not exists(
      select 1 from unnest(string_to_array(q.value,' ')) token
      where length(token)>1
        and c.search_blob!~('(^|[^a-z0-9])'||token||'([^a-z0-9]|$)')
    )
  union all
  select 'private:'||p.food_id,null::text,p.name,null::uuid,null::text,null::jsonb,
    p.nutrition_snapshot,p.catalog_metadata,
    case when lower(p.name)=q.value then 2400 else 1300 end
  from patient_custom_foods p cross join q
  where p.patient_id=p_patient_id and not p_approved_only and q.value<>''
    and not exists(
      select 1 from unnest(string_to_array(q.value,' ')) token
      where length(token)>1 and lower(p.name||' '||coalesce(p.brand,''))!~
        ('(^|[^a-z0-9])'||token||'([^a-z0-9]|$)')
    )
), candidates as (
  select*from family_candidates union all select*from singleton_candidates
), rows as (
  select coalesce(c.id::text,replace(x.result_key,'private:','')) id,
    coalesce(c.kind,'personal') kind,x.name,coalesce(c.brand,p.brand) brand,
    coalesce(c.serving_label,p.serving) serving,c.serving_grams,
    coalesce(c.calories,p.calories) calories,coalesce(c.protein,p.protein) protein,
    coalesce(c.carbs,p.carbs) carbs,coalesce(c.fat,p.fat) fat,
    coalesce(c.measures,'[]') measures,coalesce(c.source,'patient') source,
    coalesce(c.source_id,p.food_id) source_id,c.barcode,
    coalesce(c.quality_status,'private') quality_status,
    coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.approved_food_id,'name',l.official_name,'portion',l.official_portion,
      'phaseGuidance',l.phase_guidance,'constraints',l.constraints
    ))from food_catalog_approved_links l where l.catalog_id=c.id),'[]') approvals,
    x.result_key "resultKey",x.family_key "familyKey",
    x.variant_summary "variantSummary",x.dimensions,false "choiceRequired",
    x.nutrition_snapshot "nutritionSnapshot",x.catalog_metadata "catalogMetadata",x.rank
  from candidates x left join food_catalog_items c on c.id=x.catalog_id
  left join patient_custom_foods p on x.result_key='private:'||p.food_id
    and p.patient_id=p_patient_id
  order by x.rank desc,x.result_key
  offset greatest(p_offset,0) limit least(greatest(p_limit,1),7)
)
select coalesce(jsonb_agg(jsonb_strip_nulls(to_jsonb(rows)-'rank')),'[]')from rows;
$$;

create or replace function public.search_food_catalog_grouped(
  p_patient_id uuid,p_query text,p_approved_only boolean default false,
  p_limit integer default 6,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare normalized text:=lower(trim(regexp_replace(coalesce(p_query,''),'[^a-zA-Z0-9%/]+',' ','g')));
begin
  if normalized~'\mbeef\M'
    and normalized~'([0-9]{2}%|[0-9]{2}/[0-9]{1,2})'
    and normalized!~'(80%|80/20|85%|85/15|90%|90/10|95%|95/5)'
  then return '[]'; end if;
  return public.search_food_catalog_grouped_v2_core(
    p_patient_id,normalized,p_approved_only,p_limit,p_offset
  );
end;
$$;

create or replace function public.get_food_catalog_family(
  p_family_key text,p_approved_only boolean default false
) returns jsonb language sql stable security definer set search_path=public as $$
select coalesce(jsonb_agg(jsonb_build_object(
  'id',c.id::text,'kind',c.kind,'name',f.name,'brand',c.brand,
  'serving',c.serving_label,'serving_grams',c.serving_grams,
  'calories',c.calories,'protein',c.protein,'carbs',c.carbs,'fat',c.fat,
  'measures',c.measures,'source',c.source,'source_id',c.source_id,
  'barcode',c.barcode,'quality_status',c.quality_status,
  'approvals',coalesce((select jsonb_agg(jsonb_build_object(
    'id',l.approved_food_id,'name',l.official_name,'portion',l.official_portion,
    'phaseGuidance',l.phase_guidance,'constraints',l.constraints
  ))from food_catalog_approved_links l where l.catalog_id=c.id),'[]'),
  'resultKey','family:'||f.family_key||':'||c.id,'familyKey',f.family_key,
  'variantSummary',v.variant_summary,'dimensions',v.dimensions,
  'choiceRequired',false,'nutritionSnapshot',v.nutrition_snapshot
)order by v.common_order,c.id),'[]')
from food_catalog_families f join food_catalog_family_variants v using(family_key)
join food_catalog_items c on c.id=v.catalog_id
join food_catalog_curation cur on cur.catalog_id=c.id and cur.eligibility='reviewed_family'
where f.family_key=p_family_key
  and(not p_approved_only or exists(
    select 1 from food_catalog_approved_links l where l.catalog_id=c.id
  ));
$$;

insert into public.food_catalog_families(family_key,name,aliases,review_version)
select family_key,display_name,
  array[lower(display_name),
    case when lower(display_name) like '%s' then left(lower(display_name),-1)
      else lower(display_name)||'s' end],
  'everyday-foods-v3'
from reviewed_everyday
on conflict(family_key) do update set name=excluded.name,aliases=excluded.aliases,
  review_version=excluded.review_version;

-- Explicit reviewed body-name aliases never erase source cut/species/state.
update public.food_catalog_families set aliases=aliases||case family_key
  when 'everyday-ground-turkey' then array['turkey mince']
  when 'everyday-green-beans' then array['string beans','snap beans']
  when 'everyday-chickpeas' then array['garbanzo beans']
  when 'everyday-oatmeal' then array['oats','porridge']
  when 'everyday-whole-wheat-bread' then array['wholemeal bread']
  when 'everyday-soy-sauce' then array['shoyu']
  when 'everyday-mayonnaise' then array['mayo']
  when 'everyday-barbecue-sauce' then array['bbq sauce']
  when 'everyday-potatoes' then array['potato']
  when 'everyday-sweet-potatoes' then array['sweet potato']
  when 'everyday-peaches' then array['peach']
  when 'everyday-mangoes' then array['mango']
  else '{}'::text[] end
where family_key like 'everyday-%';

update reviewed_everyday set variant_summary=case fdc_id
  when 168251 then 'Top loin · Boneless · Lean only · Raw'
  when 168728 then 'Choice · Lean and fat · Raw'
  when 173810 then 'Loin chop · Lean only · Raw'
  when 171098 then 'Meat only · Raw'
  when 172373 then 'Meat and skin · Raw'
  when 174611 then 'Honey-smoked · Cooked'
  when 172476 then 'Regular · Calcium-set · Raw'
  when 175138 then 'Pink salmon · Raw'
  when 175159 then 'Yellowfin · Raw'
  when 175139 then 'Atlantic · Canned in oil · Bones included'
  when 167742 then 'Bay and sea · Steamed'
  when 169099 then 'Canned · Unsweetened'
  when 173217 then 'From frozen concentrate · Prepared with water'
  else variant_summary end
where fdc_id in(168251,168728,173810,171098,172373,174611,172476,175138,
  175159,175139,167742,169099,173217);

with facts as (
  select e.*,f.description,f.raw_food,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id'='1008' and jsonb_typeof(n->'amount')='number' limit 1) calories,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id'='1003' and jsonb_typeof(n->'amount')='number' limit 1) protein,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id'='1005' and jsonb_typeof(n->'amount')='number' limit 1) carbs,
    (select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
      where n->'nutrient'->>'id'='1004' and jsonb_typeof(n->'amount')='number' limit 1) fat
  from reviewed_everyday e join usda_source_foods f using(release_id,fdc_id)
), prepared as (
  select facts.*,
    jsonb_build_array(
      jsonb_build_object('label','grams','grams',1),
      jsonb_build_object('label','ounces','grams',28.349523125)
    )||coalesce((
      select jsonb_agg(jsonb_build_object(
        'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
        'grams',(p->>'gramWeight')::numeric,
        'amount',case when jsonb_typeof(p->'amount')='number' then p->'amount' end,
        'unit',p->'measureUnit'->>'name',
        'evidence','USDA FoodData Central portion'
      ) order by ord)
      from jsonb_array_elements(coalesce(raw_food->'foodPortions','[]'))with ordinality x(p,ord)
      where jsonb_typeof(p->'gramWeight')='number'
        and lower(coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name',''))
          not in ('quantity not specified','amount not specified','')
    ),'[]') measures,
    jsonb_build_object(
      'version',1,
      'source',jsonb_build_object(
        'provider','USDA FoodData Central','recordId',fdc_id::text,
        'release',release_id,'revision',release_id||':'||fdc_id,
        'canonicalName',description
      ),
      'basis',jsonb_build_object('amount',100,'unit','g','label','100 g','grams',100),
      'nutrients',coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',n->'nutrient'->>'id','name',n->'nutrient'->>'name',
          'unit',n->'nutrient'->>'unitName','amount',(n->>'amount')::numeric
        ) order by ord)
        from jsonb_array_elements(raw_food->'foodNutrients')with ordinality x(n,ord)
        where jsonb_typeof(n->'amount')='number'
          and not exists(
            select 1 from jsonb_array_elements(raw_food->'foodNutrients')with ordinality prior(p,pord)
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
          'id','usda-portion-'||ord,
          'label',coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name'),
          'unit',coalesce(p->'measureUnit'->>'name','serving'),
          'dimension',case
            when lower(coalesce(p->'measureUnit'->>'name',''))~'cup|tablespoon|teaspoon|fluid'
              then 'volume'
            when lower(coalesce(p->'measureUnit'->>'name',''))~'serving' then 'serving'
            else 'count' end,
          'basisMultiplier',(p->>'gramWeight')::numeric/100,
          'grams',(p->>'gramWeight')::numeric,
          'evidence','USDA FoodData Central portion'
        ) order by ord)
        from jsonb_array_elements(coalesce(raw_food->'foodPortions','[]'))with ordinality x(p,ord)
        where jsonb_typeof(p->'gramWeight')='number'
          and lower(coalesce(p->>'portionDescription',p->>'modifier',p->'measureUnit'->>'name',''))
            not in ('quantity not specified','amount not specified','')
      ),'[]'),
      'variant',jsonb_build_object('familyKey',family_key,'summary',variant_summary,'dimensions',dimensions),
      'selected',jsonb_build_object('amount',100,'unitId','g','scale',1),
      'provenance',provenance
    ) snapshot
  from facts
), items as (
  insert into public.food_catalog_items(
    kind,name,brand,serving_label,serving_grams,calories,protein,carbs,fat,
    measures,source,source_id,quality_status,provenance,nutrition_snapshot
  )
  select 'generic',display_name,null,'100 g',100,calories,protein,carbs,fat,
    measures,'usda_fdc',fdc_id::text,'reviewed',
    jsonb_build_object(
      'provider','USDA FoodData Central','release',release_id,'recordId',fdc_id::text,
      'canonicalName',description,'familyReview','everyday-foods-v3',
      'mapping',provenance
    ),snapshot
  from prepared
  on conflict(source,source_id) do update set
    name=excluded.name,serving_label=excluded.serving_label,serving_grams=excluded.serving_grams,
    calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,
    measures=excluded.measures,provenance=excluded.provenance,
    nutrition_snapshot=excluded.nutrition_snapshot,updated_at=now()
  returning id,source_id,nutrition_snapshot
)
insert into public.food_catalog_family_variants(
  family_key,catalog_id,release_id,source_revision,variant_summary,
  dimensions,nutrition_snapshot,common_order
)
select e.family_key,i.id,e.release_id,e.release_id||':'||e.fdc_id,
  e.variant_summary,e.dimensions,i.nutrition_snapshot,1
from reviewed_everyday e join items i on i.source_id=e.fdc_id::text
on conflict(family_key,catalog_id) do update set
  source_revision=excluded.source_revision,variant_summary=excluded.variant_summary,
  dimensions=excluded.dimensions,nutrition_snapshot=excluded.nutrition_snapshot,
  common_order=excluded.common_order;

update public.food_catalog_families f set default_catalog_id=v.catalog_id
from public.food_catalog_family_variants v
where v.family_key=f.family_key and f.family_key like 'everyday-%' and v.common_order=1;

insert into public.food_catalog_aliases(catalog_id,alias)
select v.catalog_id,a
from public.food_catalog_family_variants v
join public.food_catalog_families f using(family_key)
cross join unnest(f.aliases) a
where f.family_key like 'everyday-%'
on conflict(catalog_id,alias) do nothing;

-- First classify the whole current catalog, then upgrade exact reviewed variants.
insert into public.food_catalog_curation(
  catalog_id,eligibility,friendly_name,category,reason,review_version,source_revision
)
select c.id,
  case
    when c.kind<>'generic' or c.source<>'usda_fdc' then 'excluded'
    when c.name~*'\m(babyfood|infant formula|restaurant|school lunch)\M' then 'excluded'
    else 'safe_singleton'
  end,
  c.name,null,
  case
    when c.kind<>'generic' or c.source<>'usda_fdc' then 'packaged or non-USDA records require intentional search'
    when c.name~*'\m(babyfood|infant formula|restaurant|school lunch)\M' then 'specialized or institutional record'
    else 'source-backed generic singleton; exact all-token matching only'
  end,
  'everyday-foods-v3',
  coalesce(c.provenance->>'release','sr-legacy-2018-04')||':'||c.source_id
from public.food_catalog_items c
on conflict(catalog_id) do update set
  eligibility=excluded.eligibility,friendly_name=excluded.friendly_name,
  category=excluded.category,reason=excluded.reason,
  review_version=excluded.review_version,source_revision=excluded.source_revision,
  reviewed_at=now();

update public.food_catalog_curation q set
  eligibility='reviewed_family',friendly_name=f.name,
  category=coalesce(e.category,q.category),
  reason='reviewed source-backed family variant',
  review_version=case when f.family_key like 'everyday-%' then 'everyday-foods-v3' else f.review_version end,
  source_revision=v.source_revision,reviewed_at=now()
from public.food_catalog_family_variants v
join public.food_catalog_families f using(family_key)
left join reviewed_everyday e using(family_key)
where q.catalog_id=v.catalog_id;

do $$
begin
  if exists(
    select 1 from reviewed_everyday e
    join food_catalog_items c on c.source='usda_fdc' and c.source_id=e.fdc_id::text
    join usda_source_foods f on f.release_id=e.release_id and f.fdc_id=e.fdc_id
    where c.nutrition_snapshot->'source'->>'revision'<>e.release_id||':'||e.fdc_id
      or c.nutrition_snapshot->'source'->>'canonicalName'<>f.description
      or c.calories<>(select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
        where n->'nutrient'->>'id'='1008' and jsonb_typeof(n->'amount')='number' limit 1)
      or c.protein<>(select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
        where n->'nutrient'->>'id'='1003' and jsonb_typeof(n->'amount')='number' limit 1)
      or c.carbs<>(select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
        where n->'nutrient'->>'id'='1005' and jsonb_typeof(n->'amount')='number' limit 1)
      or c.fat<>(select(n->>'amount')::numeric from jsonb_array_elements(f.raw_food->'foodNutrients') n
        where n->'nutrient'->>'id'='1004' and jsonb_typeof(n->'amount')='number' limit 1)
  ) then raise exception 'catalog/source snapshot reconciliation failed'; end if;
end $$;

do $$
begin
  if exists(
    select 1 from reviewed_everyday_extra e
    join food_catalog_items c on c.source='usda_fdc'and c.source_id=e.fdc_id::text
    join usda_source_foods f using(release_id,fdc_id)
    where c.nutrition_snapshot<>build_food_catalog_source_snapshot(
      e.release_id,e.fdc_id,e.family_key,e.variant_summary,e.dimensions,e.provenance
    )
  ) then raise exception 'expanded variant/source snapshot reconciliation failed'; end if;
end $$;

revoke all on function
  public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer),
  public.search_food_catalog_grouped(uuid,text,boolean,integer,integer),
  public.get_food_catalog_family(text,boolean)
from public,anon,authenticated;
grant execute on function
  public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer),
  public.search_food_catalog_grouped(uuid,text,boolean,integer,integer),
  public.get_food_catalog_family(text,boolean)
to service_role;

notify pgrst,'reload schema';
commit;