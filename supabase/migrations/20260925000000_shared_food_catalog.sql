-- Shared, server-owned food catalog.  Nutrition variants are deliberately
-- separate from official THINNR approval copy and from patient-owned foods.
create extension if not exists pg_trgm;

create table if not exists public.food_catalog_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('generic', 'branded')),
  name text not null check (char_length(name) between 1 and 160),
  brand text check (brand is null or char_length(brand) between 1 and 100),
  serving_label text not null check (char_length(serving_label) between 1 and 100),
  serving_grams numeric check (serving_grams is null or serving_grams > 0),
  calories numeric not null check (calories between 0 and 5000),
  protein numeric not null check (protein between 0 and 500),
  carbs numeric not null check (carbs between 0 and 500),
  fat numeric not null check (fat between 0 and 500),
  measures jsonb not null default '[]'::jsonb check (jsonb_typeof(measures) = 'array'),
  source text not null check (source in ('usda_fdc', 'openfoodfacts')),
  source_id text not null check (char_length(source_id) between 1 and 120),
  barcode text check (barcode is null or barcode ~ '^[0-9]{8}$' or barcode ~ '^[0-9]{13}$'),
  quality_status text not null default 'reviewed'
    check (quality_status in ('reviewed', 'community_verified')),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  popularity bigint not null default 0 check (popularity >= 0),
  search_text text generated always as
    (lower(name || ' ' || coalesce(brand, ''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id),
  check (
    (kind = 'generic' and source = 'usda_fdc' and serving_grams is not null and quality_status = 'reviewed')
    or
    (kind = 'branded' and source = 'openfoodfacts' and quality_status = 'community_verified')
  )
);
create unique index if not exists food_catalog_barcode_unique
  on public.food_catalog_items (barcode) where barcode is not null;
create index if not exists food_catalog_search_trgm
  on public.food_catalog_items using gin (search_text gin_trgm_ops);

create table if not exists public.food_catalog_aliases (
  catalog_id uuid not null references public.food_catalog_items(id) on delete cascade,
  alias text not null check (char_length(alias) between 1 and 160),
  -- Stable ids from the original mobile seed live here as compatibility aliases.
  legacy_id text check (legacy_id is null or char_length(legacy_id) between 1 and 80),
  primary key (catalog_id, alias)
);
create unique index if not exists food_catalog_legacy_id_unique
  on public.food_catalog_aliases (legacy_id) where legacy_id is not null;
create index if not exists food_catalog_alias_trgm
  on public.food_catalog_aliases using gin (lower(alias) gin_trgm_ops);

create table if not exists public.food_catalog_approved_links (
  catalog_id uuid not null references public.food_catalog_items(id) on delete cascade,
  approved_food_id text not null,
  official_name text not null,
  -- The official manual does not provide these fields on every row. Null means
  -- “not stated by the source”, never an invented portion or phase.
  official_portion text,
  phase_guidance text,
  constraints jsonb check (constraints is null or jsonb_typeof(constraints) = 'object'),
  reviewed_at timestamptz not null,
  primary key (catalog_id, approved_food_id)
);
-- Upgrade environments that briefly received the pre-release shape where the
-- optional official fields were NOT NULL and constraints was plain text.
alter table public.food_catalog_approved_links
  alter column official_portion drop not null,
  alter column phase_guidance drop not null,
  alter column constraints drop default;
alter table public.food_catalog_approved_links
  alter column constraints type jsonb using constraints::jsonb,
  alter column constraints drop default,
  alter column constraints drop not null;

create or replace function public.guard_food_catalog_approval()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1 from food_catalog_items
    where id = new.catalog_id and kind = 'generic' and quality_status = 'reviewed'
  ) then
    raise exception 'only reviewed generic catalog variants may link to Approved Foods';
  end if;
  return new;
end $$;
drop trigger if exists food_catalog_approval_guard on public.food_catalog_approved_links;
create trigger food_catalog_approval_guard
before insert or update on public.food_catalog_approved_links
for each row execute function public.guard_food_catalog_approval();

create table if not exists public.food_catalog_usage (
  patient_id uuid not null references public.patients(id) on delete cascade,
  catalog_id uuid not null references public.food_catalog_items(id) on delete cascade,
  selection_count integer not null default 1 check (selection_count > 0),
  last_selected_at timestamptz not null default now(),
  primary key (patient_id, catalog_id)
);

alter table public.food_catalog_items enable row level security;
alter table public.food_catalog_aliases enable row level security;
alter table public.food_catalog_approved_links enable row level security;
alter table public.food_catalog_usage enable row level security;
revoke all on public.food_catalog_items, public.food_catalog_aliases,
  public.food_catalog_approved_links, public.food_catalog_usage from anon, authenticated;

-- All catalog access goes through the API service role. The RPC performs local
-- ranking and unions only the caller's private foods; no custom row is copied
-- into a shared table.
create or replace function public.search_food_catalog(
  p_patient_id uuid, p_query text, p_limit integer default 20
) returns jsonb
language sql stable security definer set search_path = public
as $$
  with q as (select lower(trim(p_query)) value),
  alias_hits as (
    select a.catalog_id, max(similarity(lower(a.alias), q.value)) alias_score
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
      (case when c.search_text = q.value then 1000
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
    -- food_id is the app's canonical owner-scoped id. Do not prefix it: doing
    -- so makes a search result differ from favorites, recents, and diary refs.
    select f.food_id id, 'personal'::text kind, f.name, f.brand,
      f.serving, null::numeric serving_grams, f.calories, f.protein, f.carbs, f.fat,
      '[]'::jsonb measures, 'patient'::text source, f.food_id source_id,
      null::text barcode, 'private'::text quality_status, '[]'::jsonb approvals,
      (case when lower(f.name) = q.value then 1200
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

create or replace function public.record_food_catalog_selection(
  p_patient_id uuid, p_catalog_id uuid
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into food_catalog_usage(patient_id, catalog_id)
  values (p_patient_id, p_catalog_id)
  on conflict (patient_id, catalog_id) do update
    set selection_count = food_catalog_usage.selection_count + 1,
        last_selected_at = now();
  update food_catalog_items set popularity = popularity + 1 where id = p_catalog_id;
end $$;
revoke all on function public.record_food_catalog_selection(uuid, uuid) from public;
grant execute on function public.record_food_catalog_selection(uuid, uuid) to service_role;
