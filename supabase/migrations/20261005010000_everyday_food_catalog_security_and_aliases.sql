begin;

update public.food_catalog_families
set aliases=aliases||case family_key
  when 'everyday-peanut-butter' then array['chunky peanut butter','smooth peanut butter']
  when 'everyday-cottage-cheese' then array['low fat cottage cheese','nonfat cottage cheese','dry curd cottage cheese']
  when 'everyday-ground-turkey' then array['93% ground turkey','93/7 ground turkey']
  else '{}'::text[] end
where family_key in(
  'everyday-peanut-butter','everyday-cottage-cheese','everyday-ground-turkey'
);

insert into public.food_catalog_aliases(catalog_id,alias)
select v.catalog_id,a
from public.food_catalog_family_variants v
join public.food_catalog_families f using(family_key)
cross join unnest(f.aliases)a
where f.family_key in(
  'everyday-peanut-butter','everyday-cottage-cheese','everyday-ground-turkey'
)
on conflict(catalog_id,alias)do nothing;

-- These legacy RPCs are API-server seams, not browser-callable authorization
-- surfaces. Existing migrations revoked public only; make the intent explicit.
revoke all on function public.search_food_catalog(uuid,text,integer),
  public.record_food_catalog_selection(uuid,uuid)
from anon,authenticated;
grant execute on function public.search_food_catalog(uuid,text,integer),
  public.record_food_catalog_selection(uuid,uuid)
to service_role;

notify pgrst,'reload schema';
commit;