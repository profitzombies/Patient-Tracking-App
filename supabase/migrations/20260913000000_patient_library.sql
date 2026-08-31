-- THINNR account-backed foods library — custom foods, saved AI recipes, and
-- the per-patient media ledger behind their photos.
--
-- A signed-in patient's My Foods (label scans, barcode misses, manual
-- entries, coach cards) and saved AI recipes currently live only on the
-- device; this rail moves them onto the account so a reinstall or a new
-- phone rebuilds the same Library. Rows are keyed by patients.id exactly
-- like the diary rail (20260912000000_patient_diary.sql).
--
-- Both item tables are SELF-CONTAINED nutrition snapshots in the app's own
-- shape: ids are client-generated (optimistic rendering and Undo restore the
-- exact same row), and values are stored verbatim so the row the app wrote
-- is the row it hydrates later. Photos are NOT stored inline: the app
-- uploads bytes through /api/patient-media/* into App Storage and the rows
-- keep only the object path. `photo_path` must live under the owning
-- patient's own media prefix — ownership is baked into the path.
--
-- patient_media is the ledger of uploaded objects (one row per stored
-- object): written on finalize, re-registered on item upsert (Undo), and
-- deleted alongside the items that reference it so a deleted item's photo is
-- no longer referenced by the account. Object BYTES are not deleted here —
-- sweeping unreferenced objects is a storage-hygiene job, not a row concern.
--
-- RLS: enabled with NO policies on purpose, and privileges revoked from
-- anon/authenticated. Only the API server's service role (which bypasses
-- RLS) reads or writes; the mobile app always goes through /api with a
-- bearer session token. Do not add anon/authenticated policies here.
--
-- Safe to re-run: guarded with IF NOT EXISTS.

-- ── Media ledger ────────────────────────────────────────────────────────────

create table if not exists public.patient_media (
  -- Canonical object path, e.g. "/objects/patient-media/<patient>/food-<id>".
  -- The owning patient's id is part of the path, so a row can never point at
  -- another patient's object.
  object_path text primary key
    check (
      char_length(object_path) <= 300
      and object_path like ('/objects/patient-media/' || patient_id::text || '/%')
    ),
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- What the object decorates: a custom food or a saved recipe.
  kind text not null
    check (kind in ('food', 'recipe')),
  -- Facts recorded at finalize after the server re-validated the stored
  -- bytes; null when the row was re-registered by an item upsert (Undo).
  content_type text
    check (content_type is null or char_length(content_type) between 1 and 100),
  size_bytes bigint
    check (size_bytes is null or size_bytes > 0),
  created_at timestamptz not null default now()
);

create index if not exists patient_media_by_patient
  on public.patient_media (patient_id);

comment on table public.patient_media is
  'Ledger of per-patient uploaded media objects (custom-food and saved-recipe photos). Ownership is baked into the object path. Service-role only; RLS enabled with no policies by design.';

alter table public.patient_media enable row level security;
revoke all on public.patient_media from anon, authenticated;

-- ── Custom foods (My Foods) ─────────────────────────────────────────────────

create table if not exists public.patient_custom_foods (
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Client-generated id (e.g. "custom_mf2k1x_7"); opaque to the server.
  food_id text not null
    check (food_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  name text not null
    check (char_length(name) between 1 and 200),
  brand text
    check (brand is null or char_length(brand) between 1 and 120),
  serving text not null
    check (char_length(serving) between 1 and 160),
  calories numeric not null check (calories >= 0 and calories <= 50000),
  protein numeric not null check (protein >= 0 and protein <= 5000),
  carbs numeric not null check (carbs >= 0 and carbs <= 5000),
  fat numeric not null check (fat >= 0 and fat <= 5000),
  -- Optional dish photo: an object path under THIS patient's media prefix
  -- (see patient_media). Null for photo-less foods.
  photo_path text
    check (
      photo_path is null
      or (
        char_length(photo_path) <= 300
        and photo_path like ('/objects/patient-media/' || patient_id::text || '/%')
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (patient_id, food_id)
);

comment on table public.patient_custom_foods is
  'Live per-patient custom foods (My Foods): self-contained nutrition snapshots with an optional patient-media photo path. Written and read solely by the API server via the service role; RLS enabled with no policies by design.';

alter table public.patient_custom_foods enable row level security;
revoke all on public.patient_custom_foods from anon, authenticated;

-- ── Saved AI recipes ────────────────────────────────────────────────────────

create table if not exists public.patient_saved_recipes (
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Client-generated id (e.g. "airec_mf2k1x_7"); opaque to the server.
  recipe_id text not null
    check (recipe_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  name text not null
    check (char_length(name) between 1 and 200),
  meal text not null
    check (meal in ('breakfast', 'lunch', 'dinner', 'snacks')),
  -- Which coach flow produced it: a cook-it recipe, a cravings fix, or a
  -- meal-photo read.
  mode text not null
    check (mode in ('recipe', 'cravings', 'meal')),
  -- App-shaped lists stored verbatim (tags/steps: strings; ingredients:
  -- amount/unit/name rows with optional per-ingredient nutrition).
  tags jsonb not null default '[]'::jsonb
    check (jsonb_typeof(tags) = 'array'),
  minutes numeric not null
    check (minutes >= 0 and minutes <= 2000),
  servings numeric not null
    check (servings >= 0 and servings <= 1000),
  -- Per-serving totals, exactly as the app displays them.
  calories numeric not null check (calories >= 0 and calories <= 50000),
  protein numeric not null check (protein >= 0 and protein <= 5000),
  carbs numeric not null check (carbs >= 0 and carbs <= 5000),
  fat numeric not null check (fat >= 0 and fat <= 5000),
  description text not null default ''
    check (char_length(description) <= 2000),
  ingredients jsonb not null default '[]'::jsonb
    check (jsonb_typeof(ingredients) = 'array'),
  steps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(steps) = 'array'),
  grocery_list jsonb
    check (grocery_list is null or jsonb_typeof(grocery_list) = 'array'),
  -- The client's save stamp, stored verbatim (the app renders it as-is).
  saved_at text not null
    check (char_length(saved_at) between 1 and 40),
  -- Optional dish photo: an object path under THIS patient's media prefix.
  photo_path text
    check (
      photo_path is null
      or (
        char_length(photo_path) <= 300
        and photo_path like ('/objects/patient-media/' || patient_id::text || '/%')
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (patient_id, recipe_id)
);

comment on table public.patient_saved_recipes is
  'Live per-patient saved AI recipes (coach suggestions saved to the Library): full recipe snapshots with an optional patient-media photo path. Written and read solely by the API server via the service role; RLS enabled with no policies by design.';

alter table public.patient_saved_recipes enable row level security;
revoke all on public.patient_saved_recipes from anon, authenticated;
