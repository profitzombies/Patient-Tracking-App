begin;

-- Broad category words intentionally discover several familiar reviewed
-- families. They are literal aliases, not patterns, and do not alter defaults.
update public.food_catalog_families
set aliases=aliases||array['beef']
where family_key=any(array['ground-beef','everyday-sirloin-steak'])
  and not ('beef'=any(aliases));

update public.food_catalog_families
set aliases=aliases||array['fish']
where family_key=any(array[
  'everyday-cod','everyday-salmon','everyday-tilapia','everyday-trout','everyday-tuna'
]) and not ('fish'=any(aliases));

update public.food_catalog_families
set aliases=aliases||array['vegetable']
where family_key=any(array[
  'everyday-asparagus','everyday-broccoli','everyday-carrots','everyday-cauliflower',
  'everyday-cucumber','everyday-green-beans','everyday-potatoes','everyday-spinach',
  'everyday-sweet-potatoes','everyday-zucchini'
]) and not ('vegetable'=any(aliases));

do $$
declare
  definition text;
  changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;

  if position('food_catalog_regex_literal(token)' in definition)=0 then
    raise exception 'literal-token repair is not installed';
  end if;
  if position('family_key!~''^bulk-''' in definition)>0 then
    raise exception 'familiar-family ranking repair is already installed';
  end if;

  changed:=replace(
    definition,
    ')then 2600',
    ')then 2600 + case
      when cardinality(string_to_array(q.base,'' ''))=1
        and f.family_key!~''^bulk-'' then 200
      else 0 end'
  );
  if changed=definition then
    raise exception 'familiar-family ranking template no longer matches current core';
  end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(
  uuid,text,boolean,integer,integer
) from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(
  uuid,text,boolean,integer,integer
) to service_role;

do $$
declare
  rows jsonb;
  repeated jsonb;
  exact_row jsonb;
  family text;
begin
  -- Golden corpus v3: broad chicken remains family-first and preserves the old
  -- familiar ordering contract.
  rows:=public.search_food_catalog_grouped(null,'chicken',false,6,0);
  repeated:=public.search_food_catalog_grouped(null,'chicken',false,6,0);
  if rows<>repeated or jsonb_array_length(rows)<>6 then
    raise exception 'chicken six-row page is not deterministic';
  end if;
  if rows->0->>'familyKey'<>'chicken-breast' then
    raise exception 'chicken breast is not the broad chicken winner';
  end if;
  foreach family in array array['chicken-breast','chicken-thighs','chicken-wings'] loop
    if not exists(select 1 from jsonb_array_elements(rows) r where r->>'familyKey'=family) then
      raise exception 'golden chicken family missing: %',family;
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(rows) r where r->>'familyKey' is null) then
    raise exception 'broad chicken returned a singleton before families';
  end if;

  -- Other requiredFamilies entries are copied from golden-query-corpus-v3.
  rows:=public.search_food_catalog_grouped(null,'ground',false,7,0);
  foreach family in array array['ground-beef','everyday-ground-turkey'] loop
    if not exists(select 1 from jsonb_array_elements(rows) r where r->>'familyKey'=family) then
      raise exception 'golden ground family missing: %',family;
    end if;
  end loop;

  rows:=public.search_food_catalog_grouped(null,'beans',false,7,0);
  foreach family in array array[
    'everyday-black-beans','everyday-chickpeas','everyday-green-beans',
    'everyday-kidney-beans','everyday-lima-beans','everyday-navy-beans',
    'everyday-pinto-beans'
  ] loop
    if not exists(select 1 from jsonb_array_elements(rows) r where r->>'familyKey'=family) then
      raise exception 'golden beans family missing: %',family;
    end if;
  end loop;

  -- New broad aliases must surface familiar families, not technical singleton
  -- records or alphabetically early dishes.
  foreach family in array array['ground-beef','everyday-salmon','everyday-broccoli'] loop
    rows:=public.search_food_catalog_grouped(
      null,
      case family when 'ground-beef' then 'beef'
        when 'everyday-salmon' then 'fish' else 'vegetable' end,
      false,6,0
    );
    if not exists(select 1 from jsonb_array_elements(rows) r where r->>'familyKey'=family) then
      raise exception 'broad staple family missing: %',family;
    end if;
    if exists(select 1 from jsonb_array_elements(rows) r where r->>'familyKey' is null) then
      raise exception 'broad staple query returned singleton before families: %',family;
    end if;
  end loop;

  -- Exact identity/default source winners are immutable ranking contracts.
  foreach exact_row in array array[
    jsonb_build_object('q','chicken breast','family','chicken-breast',
      'id','0b083963-0b7a-414b-a2fd-ad4190c53c66','source','2705956'),
    jsonb_build_object('q','ground beef','family','ground-beef',
      'id','6ebd4064-7076-4c31-b8bb-fec168b1f372','source','174030'),
    jsonb_build_object('q','salmon','family','everyday-salmon',
      'id','b01d8fce-f97c-4bf9-85ab-c464c58848ee','source','175138'),
    jsonb_build_object('q','broccoli','family','everyday-broccoli',
      'id','30786967-2ada-4c26-b37c-7dd65b9115b7','source','170379')
  ] loop
    rows:=public.search_food_catalog_grouped(null,exact_row->>'q',false,1,0);
    if rows->0->>'familyKey'<>exact_row->>'family'
      or rows->0->>'id'<>exact_row->>'id'
      or rows->0->>'source_id'<>exact_row->>'source' then
      raise exception 'exact identity/default source winner changed: %',exact_row->>'q';
    end if;
  end loop;

  -- Offset pages are slices of one deterministic family ordering.
  rows:=public.search_food_catalog_grouped(null,'chicken',false,6,0);
  repeated:=public.search_food_catalog_grouped(null,'chicken',false,6,6);
  if exists(
    select 1 from jsonb_array_elements(rows) a
    join jsonb_array_elements(repeated) b
      on a->>'resultKey'=b->>'resultKey'
  ) then
    raise exception 'chicken pages overlap';
  end if;
end $$;

notify pgrst,'reload schema';
commit;