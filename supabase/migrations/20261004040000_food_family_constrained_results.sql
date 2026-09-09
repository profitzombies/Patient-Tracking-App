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
  -- A constrained family query may return its exact supported tuple or
  -- nothing. Unrelated fuzzy singleton rows are never substitutes.
  if normalized like '%beef%'
     and normalized ~ '([0-9]{2}%|[0-9]{2}/[0-9]{1,2})' then
    return coalesce((
      select jsonb_agg(row)
      from jsonb_array_elements(result) row
      where row->>'familyKey'='ground-beef'
    ),'[]'::jsonb);
  end if;
  return result;
end;
$$;

revoke all on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  from public,anon,authenticated;
grant execute on function public.search_food_catalog_grouped(uuid,text,boolean,integer,integer)
  to service_role;
notify pgrst,'reload schema';
commit;