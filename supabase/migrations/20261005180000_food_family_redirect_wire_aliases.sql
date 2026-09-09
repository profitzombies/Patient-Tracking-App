begin;

do $repair$
declare definition text; changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  if position('"familyKeyAliases"' in definition)>0 then
    raise exception 'grouped family-key wire aliases are already installed';
  end if;
  changed:=replace(definition,
    'x.result_key "resultKey",x.family_key "familyKey",',
    'x.result_key "resultKey",x.family_key "familyKey",
    coalesce((
      select jsonb_agg(redirect.historical_family_key
        order by redirect.historical_family_key)
      from public.food_catalog_family_redirects redirect
      where redirect.canonical_family_key=x.family_key
    ),''[]''::jsonb) "familyKeyAliases",');
  if changed=definition then
    raise exception 'grouped result wire template no longer matches live core';
  end if;
  execute changed;

  select pg_get_functiondef(
    'public.get_food_catalog_family(text,boolean)'::regprocedure
  ) into definition;
  if position('''familyKeyAliases''' in definition)>0 then
    raise exception 'family getter wire aliases are already installed';
  end if;
  changed:=replace(definition,
    '''resultKey'',''family:''||f.family_key||'':''||c.id,''familyKey'',f.family_key,',
    '''resultKey'',''family:''||f.family_key||'':''||c.id,''familyKey'',f.family_key,
  ''familyKeyAliases'',coalesce((
    select jsonb_agg(redirect.historical_family_key
      order by redirect.historical_family_key)
    from public.food_catalog_family_redirects redirect
    where redirect.canonical_family_key=f.family_key
  ),''[]''::jsonb),');
  if changed=definition then
    raise exception 'family getter result wire template no longer matches live function';
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
revoke all on function public.get_food_catalog_family(text,boolean)
  from public,anon,authenticated;
grant execute on function public.get_food_catalog_family(text,boolean)
  to service_role;

do $$
declare rows jsonb; legacy_rows jsonb;
begin
  rows:=public.search_food_catalog_grouped(null,'cooked pasta',false,1,0);
  if jsonb_array_length(rows)<>1
    or jsonb_typeof(rows->0->'familyKeyAliases') is distinct from 'array'
    or not (rows->0->'familyKeyAliases' @> '["bulk-cooked-pasta"]'::jsonb)
    or rows->0->>'familyKey' is distinct from 'everyday-pasta'
    or rows->0->>'source_id' is distinct from '168928' then
    raise exception 'redirected grouped result lacks legacy family-key alias';
  end if;

  rows:=public.search_food_catalog_grouped(null,'chicken breast',false,1,0);
  if jsonb_array_length(rows)<>1
    or jsonb_typeof(rows->0->'familyKeyAliases') is distinct from 'array'
    or jsonb_array_length(rows->0->'familyKeyAliases')<>0 then
    raise exception 'ordinary grouped result lacks explicit empty family-key aliases';
  end if;

  legacy_rows:=public.get_food_catalog_family('bulk-cooked-pasta',false);
  if jsonb_array_length(legacy_rows)<>3
    or exists(
      select 1 from jsonb_array_elements(legacy_rows) row
      where row->>'familyKey' is distinct from 'everyday-pasta'
        or jsonb_typeof(row->'familyKeyAliases') is distinct from 'array'
        or not (row->'familyKeyAliases' @> '["bulk-cooked-pasta"]'::jsonb)
    )
    or not exists(
      select 1 from jsonb_array_elements(legacy_rows) row
      where row->>'source_id'='168928'
    )
    or not exists(
      select 1 from jsonb_array_elements(legacy_rows) row
      where row->>'source_id'='169751'
    )
    or not exists(
      select 1 from jsonb_array_elements(legacy_rows) row
      where row->>'source_id'='169737'
    ) then
    raise exception 'legacy family getter did not return all canonical variants/aliases';
  end if;

  legacy_rows:=public.get_food_catalog_family('bulk-whole-wheat-bread',false);
  if jsonb_array_length(legacy_rows)<>2
    or exists(
      select 1 from jsonb_array_elements(legacy_rows) row
      where row->>'familyKey' is distinct from 'everyday-whole-wheat-bread'
        or not (row->'familyKeyAliases'
          @> '["bulk-whole-wheat-bread"]'::jsonb)
    ) then
    raise exception 'whole-wheat legacy getter compatibility failed';
  end if;
end $$;

notify pgrst,'reload schema';
commit;