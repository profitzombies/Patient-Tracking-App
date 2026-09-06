begin;

-- These aliases expose distinct USDA preparation variants for everyday wing
-- searches without changing canonical USDA descriptions or approval links.
with reviewed(source_id, alias) as (
  values
    ('173630', 'chicken wing'),
    ('173630', 'chicken wings'),
    ('173630', 'roasted chicken wings'),
    ('172392', 'chicken wing'),
    ('172392', 'chicken wings'),
    ('172392', 'roasted chicken wings'),
    ('172392', 'skinless chicken wings'),
    ('172390', 'chicken wing'),
    ('172390', 'chicken wings'),
    ('172390', 'raw chicken wings'),
    ('172391', 'chicken wing'),
    ('172391', 'chicken wings'),
    ('172391', 'fried chicken wings'),
    ('173628', 'chicken wing'),
    ('173628', 'chicken wings'),
    ('173628', 'fried chicken wings'),
    ('173628', 'battered chicken wings'),
    ('171523', 'chicken wing'),
    ('171523', 'chicken wings'),
    ('171523', 'rotisserie chicken wings')
)
insert into public.food_catalog_aliases (catalog_id, alias)
select item.id, reviewed.alias
from reviewed
join public.food_catalog_items item
  on item.source = 'usda_fdc' and item.source_id = reviewed.source_id
on conflict (catalog_id, alias) do nothing;

-- Exact reviewed aliases outrank technical canonical prefixes, while preserving
-- usage/popularity as tie-breakers within the same patient-friendly identity.
create or replace function public.search_food_catalog(
  p_patient_id uuid, p_query text, p_limit integer default 20
) returns jsonb
language sql stable security definer set search_path = public
as $$
  with q as (select lower(trim(regexp_replace(p_query, '\s+', ' ', 'g'))) value),
  alias_hits as (
    select a.catalog_id,
      max(similarity(lower(a.alias), q.value)) alias_score,
      bool_or(lower(a.alias) = q.value) exact_alias
    from food_catalog_aliases a cross join q
    where lower(a.alias) % q.value or lower(a.alias) like '%' || q.value || '%'
    group by a.catalog_id
  ),
  shared as (
    select c.id::text id, c.kind, c.name, c.brand, c.serving_label serving,
      c.serving_grams, c.calories, c.protein, c.carbs, c.fat, c.measures,
      c.source, c.source_id, c.barcode, c.quality_status,
      coalesce(jsonb_agg(distinct jsonb_build_object(
        'id', l.approved_food_id, 'name', l.official_name,
        'portion', l.official_portion, 'phaseGuidance', l.phase_guidance,
        'constraints', l.constraints
      )) filter (where l.approved_food_id is not null), '[]'::jsonb) approvals,
      (case when coalesce(bool_or(ah.exact_alias), false) then 1500
            when c.search_text = q.value then 1000
            when c.search_text like q.value || '%' then 700 else 300 end
       + greatest(similarity(c.search_text, q.value), coalesce(max(ah.alias_score), 0)) * 100
       + least(coalesce(u.selection_count, 0), 100) * 5
       + least(c.popularity, 10000)::numeric / 100) rank
    from food_catalog_items c cross join q
    left join alias_hits ah on ah.catalog_id = c.id
    left join food_catalog_usage u on u.catalog_id = c.id and u.patient_id = p_patient_id
    left join food_catalog_approved_links l on l.catalog_id = c.id
    where c.search_text % q.value or c.search_text like '%' || q.value || '%' or ah.catalog_id is not null
    group by c.id, q.value, u.selection_count
  ),
  personal as (
    select f.food_id id, 'personal'::text kind, f.name, f.brand,
      f.serving, null::numeric serving_grams, f.calories, f.protein, f.carbs, f.fat,
      '[]'::jsonb measures, 'patient'::text source, f.food_id source_id,
      null::text barcode, 'private'::text quality_status, '[]'::jsonb approvals,
      (case when lower(f.name) = q.value then 1600
            when lower(f.name) like q.value || '%' then 800 else 350 end
       + similarity(lower(f.name || ' ' || coalesce(f.brand, '')), q.value) * 100) rank
    from patient_custom_foods f cross join q
    where f.patient_id = p_patient_id
      and lower(f.name || ' ' || coalesce(f.brand, '')) like '%' || q.value || '%'
  ),
  ranked as (
    select * from shared union all select * from personal
    order by rank desc, name asc limit least(greatest(p_limit, 1), 50)
  )
  select coalesce(jsonb_agg(to_jsonb(ranked) - 'rank'), '[]'::jsonb) from ranked;
$$;
revoke all on function public.search_food_catalog(uuid, text, integer) from public;
grant execute on function public.search_food_catalog(uuid, text, integer) to service_role;

commit;