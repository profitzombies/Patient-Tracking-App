begin;

do $$
declare
  definition text;
  changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;

  changed := replace(
    definition,
    'fh.relevance+least(coalesce(u.selection_count,0),100)rank',
    'fh.relevance rank'
  );
  if changed=definition then raise exception 'family usage-rank clause changed unexpectedly'; end if;
  definition := changed;

  changed := replace(
    definition,
    '+similarity(c.search_text,q.value)*100+least(coalesce(u.selection_count,0),100)',
    '+similarity(c.search_text,q.value)*100'
  );
  if changed=definition then raise exception 'singleton usage-rank clause changed unexpectedly'; end if;
  definition := changed;

  changed := replace(
    definition,
    'and(q.value not like''%fried%''or candidate.dimensions->>''preparation''=''fried'')
   and(q.value!~''(roasted|baked|broiled)''or candidate.dimensions->>''preparation''like''%roasted%'')',
    'and(q.value not like''%fried%''or candidate.dimensions->>''preparation''=''fried'')
   and(q.value!~''(^| )grilled( |$)''or candidate.dimensions->>''preparation''=''grilled'')
   and(q.value!~''(roasted|baked|broiled)''or candidate.dimensions->>''preparation''like''%roasted%'')'
  );
  if changed=definition then raise exception 'poultry preparation clause changed unexpectedly'; end if;
  definition := changed;

  changed := replace(
    definition,
    'and(c.search_text%q.value or c.search_text like''%''||q.value||''%'')',
    'and(c.search_text%q.value or c.search_text like''%''||q.value||''%'')
  and(q.value!~''(^| )beef( |$)'' or q.value!~''([0-9]{2}%|[0-9]{2}/[0-9]{1,2})'')'
  );
  if changed=definition then raise exception 'singleton constraint clause changed unexpectedly'; end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;