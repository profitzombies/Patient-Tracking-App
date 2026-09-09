begin;

do $$
declare definition text;
begin
  select pg_get_functiondef(
    'public.food_catalog_regex_literal(text)'::regprocedure
  ) into definition;
  if position('regexp_split_to_table' in definition)=0 then
    raise exception 'literal-token helper is not the expected safe pre-repair version';
  end if;
  select pg_get_functiondef(
    'public.search_food_catalog_grouped_v2_core(uuid,text,boolean,integer,integer)'::regprocedure
  ) into definition;
  if position('food_catalog_regex_literal(token)' in definition)=0
    or position('food_catalog_regex_literal(alias_token)' in definition)=0 then
    raise exception 'search core no longer uses the literal-token helper';
  end if;
end $$;

create temporary table literal_helper_samples(
  sample text primary key,
  prior_escape text not null
) on commit drop;

insert into literal_helper_samples(sample,prior_escape)
select sample,public.food_catalog_regex_literal(sample)
from unnest(array[
  E'\\','.', '^', '$', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}',
  '(unclosed','closed)','[bracket','a+b','a.b','a*','a?',E'a\\b',
  'a^$|{}[]()','x'' or ''1''=''1','.*','[a-z]+','foo|bar','(?:group)'
]) sample;

create temporary table search_semantic_baseline(
  ordinal integer primary key,
  query text not null,
  approved boolean not null,
  page_limit integer not null,
  page_offset integer not null,
  result jsonb not null
) on commit drop;

insert into search_semantic_baseline
select ordinal,query,approved,page_limit,page_offset,
  public.search_food_catalog_grouped(
    null,query,approved,page_limit,page_offset
  )
from (values
  (1,'chicken',false,6,0),
  (2,'chicken',false,6,6),
  (3,'chicken breast',false,7,0),
  (4,'raw skinless chicken wings',false,7,0),
  (5,'77/23 ground turkey',false,7,0),
  (6,'meatless meatballs',false,7,0),
  (7,'puffed wheat',false,7,0),
  (8,'salmon',true,7,0)
) cases(ordinal,query,approved,page_limit,page_offset);

-- One built-in regex pass replaces a correlated set-returning function,
-- per-character CASE, sort, and aggregate. The replacement prefixes every
-- PostgreSQL ARE metacharacter with one literal backslash.
create or replace function public.food_catalog_regex_literal(p_text text)
returns text
language sql immutable strict parallel safe
set search_path=pg_catalog
as $$
  select regexp_replace(
    p_text,
    '([\\.^$|?*+(){}\[\]])',
    E'\\\\\\1',
    'g'
  )
$$;

revoke all on function public.food_catalog_regex_literal(text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_regex_literal(text)
  to service_role;

do $$
declare
  bad text;
  baseline record;
begin
  select sample into bad
  from literal_helper_samples
  where prior_escape<>public.food_catalog_regex_literal(sample)
    or not (sample~('^'||public.food_catalog_regex_literal(sample)||'$'))
    or (sample||'x')~('^'||public.food_catalog_regex_literal(sample)||'$')
  limit 1;
  if bad is not null then
    raise exception 'fast literal-token helper changed safe matching for %',bad;
  end if;

  if 'axb'~('^'||public.food_catalog_regex_literal('a.b')||'$')
    or 'aaaa'~('^'||public.food_catalog_regex_literal('a*')||'$')
    or 'bar'~('^'||public.food_catalog_regex_literal('foo|bar')||'$')
    or 'anything'~('^'||public.food_catalog_regex_literal('.*')||'$')
    or 'x'~('^'||public.food_catalog_regex_literal('x'' or ''1''=''1')||'$') then
    raise exception 'fast literal-token helper still interprets regex/injection-like input';
  end if;

  for baseline in select * from search_semantic_baseline order by ordinal loop
    if public.search_food_catalog_grouped(
      null,baseline.query,baseline.approved,baseline.page_limit,baseline.page_offset
    ) is distinct from baseline.result then
      raise exception 'search semantics changed for focused case %: %',
        baseline.ordinal,baseline.query;
    end if;
  end loop;
end $$;

notify pgrst,'reload schema';
commit;