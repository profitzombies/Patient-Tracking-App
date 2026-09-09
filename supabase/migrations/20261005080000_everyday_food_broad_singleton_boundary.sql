begin;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  )into definition;
  changed:=replace(definition,
    'where q.value<>''''
    and not exists(',
    'where q.value<>''''
    and(
      not exists(select 1 from family_hits)
      or(q.value=q.base and not exists(select 1 from family_hits where relevance>=3000))
    )
    and not exists(');
  if changed=definition then raise exception 'broad singleton boundary template changed unexpectedly';end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;