begin;

-- Food names and aliases are data, never regular expressions. Some legitimate
-- source labels contain parentheses/brackets; matching one must not break an
-- unrelated search. Escape characters individually to avoid a second regex
-- escaping convention inside the repair itself.
create or replace function public.food_catalog_regex_literal(p_text text)
returns text
language sql immutable strict parallel safe
set search_path=pg_catalog
as $$
  select coalesce(string_agg(
    case when ch=any(array[E'\\','.', '^', '$', '|', '?', '*', '+',
      '(', ')', '[', ']', '{', '}'])
      then E'\\'||ch else ch end,
    '' order by ord
  ),'')
  from regexp_split_to_table(p_text,'') with ordinality as letters(ch,ord)
$$;
revoke all on function public.food_catalog_regex_literal(text) from public,anon,authenticated;
grant execute on function public.food_catalog_regex_literal(text) to service_role;

do $$
declare original text; repaired text;
begin
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into original;
  repaired:=replace(replace(original,
    '||token||','||public.food_catalog_regex_literal(token)||'),
    '||alias_token||','||public.food_catalog_regex_literal(alias_token)||');
  if repaired=original and position('food_catalog_regex_literal' in original)=0 then
    raise exception 'food search token repair did not match the current function';
  end if;
  if repaired<>original then execute repaired; end if;
end $$;

do $$
declare sample text;
begin
  foreach sample in array array['(unclosed','closed)','[bracket','a+b','a.b','a*','a?',E'a\\b'] loop
    if not(sample~('^'||public.food_catalog_regex_literal(sample)||'$')) then
      raise exception 'food search literal-token regression failed';
    end if;
  end loop;
  if 'axb'~('^'||public.food_catalog_regex_literal('a.b')||'$') then
    raise exception 'food search literal tokens still interpret operators';
  end if;
  if jsonb_array_length(public.search_food_catalog_grouped(null,'chicken',false,6,0))<>6 then
    raise exception 'expanded catalog broad-search regression failed';
  end if;
end $$;
commit;