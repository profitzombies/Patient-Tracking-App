begin;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  )into definition;

  changed:=replace(definition,
    'select f.family_key,max(case when lower(a)=q.base then 3000
    else similarity(lower(a),q.base)*1000 end) relevance',
    'select f.family_key,max(case when lower(a)=q.base then 3000
    when not exists(
      select 1 from unnest(string_to_array(q.base,'' ''))token
      where length(token)>1 and lower(a)!~
        (''(^|[^a-z0-9])''||token||''([^a-z0-9]|$)'')
    )then 2600
    else similarity(lower(a),q.base)*1000 end) relevance');

  changed:=replace(changed,
    'where q.base<>'''' and (lower(a)=q.base or similarity(lower(a),q.base)>=0.82)',
    'where q.base<>'''' and (lower(a)=q.base or similarity(lower(a),q.base)>=0.82
      or not exists(
        select 1 from unnest(string_to_array(q.base,'' ''))token
        where length(token)>1 and lower(a)!~
          (''(^|[^a-z0-9])''||token||''([^a-z0-9]|$)'')
      ))');

  changed:=replace(changed,
    'and not exists(select 1 from family_hits)
    and not exists(',
    'and not exists(');

  changed:=replace(changed,
    '    )
  union all
  select ''private:''||p.food_id',
    '    )
    and not exists(
      select 1 from family_hits covered
      join food_catalog_families family using(family_key)
      cross join unnest(family.aliases) alias
      where not exists(
        select 1 from unnest(string_to_array(lower(alias),'' '')) alias_token
        where length(alias_token)>1 and c.search_blob!~
          (''(^|[^a-z0-9])''||alias_token||''([^a-z0-9]|$)'')
      )
    )
  union all
  select ''private:''||p.food_id');

  if changed=definition then raise exception 'broad family discovery template changed unexpectedly';end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;