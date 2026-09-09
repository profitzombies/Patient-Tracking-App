begin;

create or replace function public.search_food_catalog_grouped(
  p_patient_id uuid,
  p_query text,
  p_approved_only boolean default false,
  p_limit integer default 6,
  p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path=public
as $$
declare
  normalized text := lower(trim(regexp_replace(p_query,'[^a-zA-Z0-9%/]+',' ','g')));
  result jsonb;
begin
  if normalized like '%beef%'
     and normalized ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})'
     and normalized !~ '(80%|80/20|85%|85/15|90%|90/10|95%|95/5)' then
    return '[]'::jsonb;
  end if;
  result := public.search_food_catalog_grouped_v2_core(
    p_patient_id,p_query,p_approved_only,p_limit,p_offset
  );
  if normalized like '%beef%'
     and normalized ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})' then
    return coalesce((
      select jsonb_agg(row)
      from jsonb_array_elements(result) row
      where row->>'familyKey'='ground-beef'
    ),'[]'::jsonb);
  end if;

  -- Technical catalog rows that are recognizable members of a family are
  -- grouped into that result even when their tuple has not passed review for
  -- the picker. Mixed dishes, meatless foods, other cuts and flavored yogurt
  -- do not match these conservative equivalence rules.
  return coalesce((
    select jsonb_agg(row)
    from jsonb_array_elements(result) row
    where not (
      row->>'familyKey' is null
      and (
        (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='ground-beef')
          and lower(row->>'name') ~ '^beef, (grass-fed, )?ground,')
        or (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='chicken-breast')
          and lower(row->>'name') ~ '^chicken breast,')
        or (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='chicken-thighs')
          and lower(row->>'name') ~ '^chicken thigh,')
        or (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='chicken-wings')
          and lower(row->>'name') ~ '^chicken wing,')
        or (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='eggs')
          and lower(row->>'name') ~ '^egg, (whole|white)')
        or (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='rice')
          and lower(row->>'name') ~ '^rice, (white|brown),' and lower(row->>'name') not like '% with %')
        or (exists(select 1 from jsonb_array_elements(result) f where f->>'familyKey'='yogurt')
          and lower(row->>'name') ~ '^yogurt,.*plain' and lower(row->>'name') !~ '(vanilla|fruit|flavor)')
      )
    )
  ),'[]'::jsonb);
end;
$$;

revoke all on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;