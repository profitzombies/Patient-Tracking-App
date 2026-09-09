begin;

do $$
declare
  result jsonb := public.search_food_catalog_grouped(null,'ground beef',false,7,0);
  eligible_singletons integer;
begin
  if (select count(*) from jsonb_array_elements(result) row
      where row->>'familyKey'='ground-beef') <> 1 then
    raise exception 'ground beef corpus must contain exactly one family row';
  end if;
  if exists(
    select 1 from jsonb_array_elements(result) row
    where row->>'familyKey' is null
      and lower(row->>'name') !~ '(^|[^a-z])beef([^a-z]|$)'
  ) then
    raise exception 'ground beef corpus contains a singleton without the beef token';
  end if;

  select count(*) into eligible_singletons
  from food_catalog_items c
  where c.kind='generic'
    and not exists(select 1 from food_catalog_family_variants v where v.catalog_id=c.id)
    and lower(c.name) !~ '^(beef, ground,|ground beef$|chicken, broilers or fryers, (breast|thigh|wing),|chicken breast,|chicken thigh,|chicken wing,|eggs?, (whole|white)|rice, (white|brown), (long-grain|medium-grain|short-grain|cooked|raw)|yogurt, plain)'
    and (c.search_text%'ground beef' or c.search_text like '%ground beef%')
    and lower(c.name) ~ '(^|[^a-z])beef([^a-z]|$)';

  if jsonb_array_length(result) <> least(1+eligible_singletons,7) then
    raise exception 'ground beef lookahead does not match the semantic candidate count';
  end if;
end $$;

commit;