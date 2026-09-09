begin;

-- General form/fat constraints apply to every reviewed family. A requested
-- tuple may select its exact variant or return no family; it never falls back.
create or replace function public.food_catalog_variant_form_matches(
  p_query text,p_dimensions jsonb
) returns boolean language sql immutable strict parallel safe as $$
select
  (p_query!~'(^| )(chunky|chunk style)( |$)' or p_dimensions->>'form' in('chunky','chunk style'))
  and(p_query!~'(^| )smooth( |$)' or p_dimensions->>'form'='smooth')
  and(p_query!~'(^| )(low fat|lowfat)( |$)' or p_dimensions->>'fat level'='low fat')
  and(p_query!~'(^| )(nonfat|fat free)( |$)' or p_dimensions->>'fat level' in('nonfat','fat free','skim milk'))
  and(p_query!~'(^| )dry curd( |$)' or p_dimensions->>'form'='dry curd');
$$;
revoke all on function public.food_catalog_variant_form_matches(text,jsonb)
  from public,anon,authenticated;
grant execute on function public.food_catalog_variant_form_matches(text,jsonb)
  to service_role;

do $$
declare definition text; changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  )into definition;
  changed:=replace(definition,
    'and(q.value!~''(93%|93/7)'' or candidate.dimensions->>''leanness'' like ''93% lean%'')',
    'and(q.value!~''(93%|93/7)'' or candidate.dimensions->>''leanness'' like ''93% lean%'')
      and public.food_catalog_variant_form_matches(q.value,candidate.dimensions)');
  if changed=definition then
    raise exception 'catalog variant predicate changed unexpectedly';
  end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;