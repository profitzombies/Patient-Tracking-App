begin;

create or replace function public.food_catalog_normalize_search_text(p_text text)
returns text
language sql immutable strict parallel safe
set search_path=pg_catalog
as $$
  select lower(trim(regexp_replace(p_text,'[^a-zA-Z0-9%/]+',' ','g')))
$$;
revoke all on function public.food_catalog_normalize_search_text(text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_normalize_search_text(text)
  to service_role;

-- Source 168384 is still an unreviewed safe singleton. Correct only its
-- source-proven presentation class; its catalog name/source/nutrition and
-- eligibility remain untouched.
do $$
declare target uuid;
begin
  select c.id into target
  from public.food_catalog_items c
  join public.food_catalog_curation cur on cur.catalog_id=c.id
  where c.source='usda_fdc' and c.source_id='168384'
    and c.name='Alfalfa Seeds, Sprouted, Raw'
    and cur.eligibility='safe_singleton'
    and cur.review_version='everyday-foods-v3';
  if target is null then
    raise exception 'source-verified alfalfa sprout singleton contract changed';
  end if;
  update public.food_catalog_curation
  set friendly_name='Alfalfa Sprouts'
  where catalog_id=target;
  insert into public.food_catalog_aliases(catalog_id,alias)
  values(target,'alfalfa sprouts'),(target,'alfalfa sprout')
  on conflict do nothing;
end $$;

do $repair$
declare
  definition text;
  changed text;
  old_hits text:=$old$
), family_hits as (
  select f.family_key,max(case when lower(a)=q.base then 3000
    when not exists(
      select 1 from unnest(string_to_array(q.base,' '))token
      where length(token)>1 and lower(a)!~
        ('(^|[^a-z0-9])'||public.food_catalog_regex_literal(token)||'([^a-z0-9]|$)')
    )then 2600 + case
      when cardinality(string_to_array(q.base,' '))=1
        and f.family_key!~'^bulk-' then 200
      else 0 end
    else similarity(lower(a),q.base)*1000 end) relevance
  from food_catalog_families f cross join unnest(f.aliases)a cross join q
  where q.base<>'' and (lower(a)=q.base or similarity(lower(a),q.base)>=0.82
      or(
        not exists(
          select 1 from food_catalog_families exact_family
          cross join unnest(exact_family.aliases)exact_alias
          where lower(exact_alias)=q.base
        )
        and not exists(
          select 1 from unnest(string_to_array(q.base,' '))token
          where length(token)>1 and lower(a)!~
            ('(^|[^a-z0-9])'||public.food_catalog_regex_literal(token)||'([^a-z0-9]|$)')
        )
      ))
    and not(f.family_key='meatballs' and q.value~'\mmeatless\M')
  group by f.family_key
), matched_families as materialized (
  select f.*,fh.relevance
  from family_hits fh join food_catalog_families f using(family_key)
$old$;
  new_hits text:=$new$
), family_hits as (
  select f.family_key,max(case
    when strpos(' '||q.value||' ',
      ' '||public.food_catalog_normalize_search_text(a)||' ')>0
      then 3400+length(public.food_catalog_normalize_search_text(a))
    when public.food_catalog_normalize_search_text(a)=q.base then 3000
    when not exists(
      select 1 from unnest(string_to_array(q.base,' '))token
      where length(token)>1 and public.food_catalog_normalize_search_text(a)!~
        ('(^|[^a-z0-9])'||public.food_catalog_regex_literal(token)||'([^a-z0-9]|$)')
    )then 2600 + case
      when cardinality(string_to_array(q.base,' '))=1
        and f.family_key!~'^bulk-' then 200
      else 0 end
    else similarity(public.food_catalog_normalize_search_text(a),q.base)*1000 end
  ) relevance
  from food_catalog_families f cross join unnest(f.aliases)a cross join q
  where q.base<>'' and (
      strpos(' '||q.value||' ',
        ' '||public.food_catalog_normalize_search_text(a)||' ')>0
      or public.food_catalog_normalize_search_text(a)=q.base
      or similarity(public.food_catalog_normalize_search_text(a),q.base)>=0.82
      or(
        not exists(
          select 1 from food_catalog_families exact_family
          cross join unnest(exact_family.aliases)exact_alias
          where public.food_catalog_normalize_search_text(exact_alias)=q.base
        )
        and not exists(
          select 1 from unnest(string_to_array(q.base,' '))token
          where length(token)>1
            and public.food_catalog_normalize_search_text(a)!~
              ('(^|[^a-z0-9])'||public.food_catalog_regex_literal(token)||'([^a-z0-9]|$)')
        )
      ))
    and not(f.family_key='meatballs' and q.value~'\mmeatless\M')
  group by f.family_key
), matched_families as materialized (
  select f.*,fh.relevance,
    case when identity_alias.value is null then q.value
      else trim(replace(
        ' '||q.value||' ',' '||identity_alias.value||' ',' '
      ))
    end constraint_query
  from family_hits fh
  join food_catalog_families f using(family_key)
  cross join q
  left join lateral (
    select public.food_catalog_normalize_search_text(a) value
    from unnest(f.aliases)a
    where strpos(
      ' '||q.value||' ',
      ' '||public.food_catalog_normalize_search_text(a)||' '
    )>0
      and(
        public.food_catalog_normalize_search_text(a)
          =public.food_catalog_normalize_search_text(f.name)
        or public.food_catalog_normalize_search_text(f.name)~
          '(^| )(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled|boiled|poached|steamed|canned|frozen|dry|skinless|chunky|chunk style|smooth|low fat|lowfat|nonfat|fat free|dry curd)( |$)'
        or public.food_catalog_normalize_search_text(a)!~
          '(^| )(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled|boiled|poached|steamed|canned|frozen|dry|skinless|chunky|chunk style|smooth|low fat|lowfat|nonfat|fat free|dry curd)( |$)'
      )
    order by
      (public.food_catalog_normalize_search_text(a)
        =public.food_catalog_normalize_search_text(f.name))desc,
      length(public.food_catalog_normalize_search_text(a))desc,a
    limit 1
  )identity_alias on true
$new$;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  if position('matched_families as materialized' in definition)=0
    or position('alias_blobs as materialized' in definition)=0 then
    raise exception 'fast materialized search plan is not installed';
  end if;
  if position('constraint_query' in definition)>0 then
    raise exception 'literal identity boundary repair is already installed';
  end if;
  changed:=replace(definition,old_hits,new_hits);
  if changed=definition then
    raise exception 'family identity boundary template no longer matches live core';
  end if;
  changed:=replace(changed,'and(q.value!~','and(f.constraint_query!~');
  changed:=replace(changed,
    'food_catalog_variant_form_matches(q.value,candidate.dimensions)',
    'food_catalog_variant_form_matches(f.constraint_query,candidate.dimensions)');
  changed:=replace(changed,
    'public.food_catalog_variant_explicit_constraints_match(
        q.value,candidate.dimensions,candidate.variant_summary',
    'public.food_catalog_variant_explicit_constraints_match(
        f.constraint_query,candidate.dimensions,candidate.variant_summary');
  if position('and(q.value!~' in changed)>0
    or position('food_catalog_variant_form_matches(q.value' in changed)>0
    or position('explicit_constraints_match(
        q.value' in changed)>0 then
    raise exception 'not all variant constraints use the remaining query';
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
declare
  check_row record;
  rows jsonb;
begin
  for check_row in
    select * from (values
      ('frozen yogurt','bulk-frozen-yogurt','173464'),
      ('frozen yogurts','bulk-frozen-yogurt','173464'),
      ('dry white cheese','bulk-dry-white-cheese','172222'),
      ('cooked pasta','bulk-cooked-pasta','169751'),
      ('dry pasta','bulk-dry-pasta','169736'),
      ('chicken canned','bulk-chicken-canned','171099'),
      ('turkey canned','bulk-turkey-canned','171101'),
      ('chunky beef soup','bulk-chunky-beef-soup','171162'),
      ('chunky chicken noodle soups','bulk-chunky-chicken-noodle-soup','171148'),
      ('chunky vegetable soup','bulk-chunky-vegetable-soup','171559'),
      ('beef broth or bouillon canned soup',
        'bulk-beef-broth-or-bouillon-canned-soup','171538'),
      ('frozen potatoes','bulk-frozen-potato','169268'),
      ('whole-wheat bread','bulk-whole-wheat-bread','172689'),
      ('alfalfa sprouts',null,'168384')
    )x(query,family_key,source_id)
  loop
    rows:=public.search_food_catalog_grouped(null,check_row.query,false,1,0);
    if rows->0->>'source_id'<>check_row.source_id
      or (check_row.family_key is not null
        and rows->0->>'familyKey'<>check_row.family_key) then
      raise exception 'literal identity winner incorrect: %',check_row.query;
    end if;
  end loop;

  -- Modifier aliases still constrain the established base family.
  if public.search_food_catalog_grouped(null,'raw chicken wings',false,1,0)
      ->0->>'familyKey'<>'chicken-wings'
    or public.search_food_catalog_grouped(null,'raw chicken wings',false,1,0)
      ->0->'dimensions'->>'state'<>'raw'
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'raw grilled chicken wings',false,7,0))<>0
    or jsonb_array_length(public.search_food_catalog_grouped(
      null,'77/23 ground beef',false,7,0))<>0
    or exists(
      select 1 from jsonb_array_elements(public.search_food_catalog_grouped(
        null,'meatless meatballs',false,7,0))r
      where r->>'familyKey'='meatballs'
    ) then
    raise exception 'preexisting variant/cross-food constraint regressed';
  end if;

  if (select count(*) from public.food_catalog_curation
      where eligibility like 'reviewed_%')<>1320 then
    raise exception 'reviewed population changed during identity repair';
  end if;
end $$;

notify pgrst,'reload schema';
commit;