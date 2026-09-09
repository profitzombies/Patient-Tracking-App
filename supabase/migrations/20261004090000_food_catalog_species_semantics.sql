begin;

do $$
declare
  definition text;
  original text;
  needle constant text :=
    'and(c.search_text%q.value or c.search_text like''%''||q.value||''%'')';
  replacement constant text :=
    'and(c.search_text%q.value or c.search_text like''%''||q.value||''%'')
  and(q.value!~''(^| )beef( |$)'' or lower(c.name)~''(^|[^a-z])beef([^a-z]|$)'')
  and(q.value!~''(^| )chicken( |$)'' or lower(c.name)~''(^|[^a-z])chicken([^a-z]|$)'')
  and(q.value!~''(^| )turkey( |$)'' or lower(c.name)~''(^|[^a-z])turkey([^a-z]|$)'')
  and(q.value!~''(^| )lamb( |$)'' or lower(c.name)~''(^|[^a-z])lamb([^a-z]|$)'')
  and(q.value!~''(^| )veal( |$)'' or lower(c.name)~''(^|[^a-z])veal([^a-z]|$)'')';
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  original := definition;
  definition := replace(definition,needle,replacement);
  if definition=original then
    raise exception 'grouped search singleton predicate changed unexpectedly';
  end if;
  execute definition;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;