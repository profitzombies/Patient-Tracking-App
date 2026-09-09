begin;

create or replace function public.food_catalog_identity_query(p_query text)
returns text language sql immutable strict parallel safe as $$
select coalesce(string_agg(token,' 'order by ord),'')
from unnest(string_to_array(p_query,' '))with ordinality x(token,ord)
where token!~'^(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled|boiled|poached|steamed|canned|frozen|dry|skinless|[0-9]{2}%|[0-9]{2}/[0-9]{1,2})$';
$$;
revoke all on function public.food_catalog_identity_query(text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_identity_query(text)to service_role;

do $$
declare definition text;changed text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  )into definition;
  changed:=replace(definition,
    'trim(regexp_replace(regexp_replace(value,
      ''(^| )(raw|uncooked|cooked|grilled|fried|roasted|baked|broiled|boiled|poached|steamed|canned|frozen|dry|skinless|[0-9]{2}%|[0-9]{2}/[0-9]{1,2})( |$)'',
      '' '',''g''),''\s+'','' '',''g'')) base',
    'public.food_catalog_identity_query(value) base');
  if changed=definition then raise exception 'stacked constraint tokenizer template changed unexpectedly';end if;
  execute changed;
end $$;

revoke all on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;