begin;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  )into definition;
  changed:=replace(definition,
    'or not exists(
        select 1 from unnest(string_to_array(q.base,'' ''))token
        where length(token)>1 and lower(a)!~
          (''(^|[^a-z0-9])''||token||''([^a-z0-9]|$)'')
      ))',
    'or(
        not exists(
          select 1 from food_catalog_families exact_family
          cross join unnest(exact_family.aliases)exact_alias
          where lower(exact_alias)=q.base
        )
        and not exists(
          select 1 from unnest(string_to_array(q.base,'' ''))token
          where length(token)>1 and lower(a)!~
            (''(^|[^a-z0-9])''||token||''([^a-z0-9]|$)'')
        )
      ))');
  if changed=definition then raise exception 'exact identity boundary template changed unexpectedly';end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;