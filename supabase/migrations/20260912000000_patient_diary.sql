-- THINNR live patient diary — the first real per-patient persistence rail.
--
-- A signed-in patient's food diary entries, water by day, daily-target
-- overrides, and the recents/favorites lists used by the logging screens.
-- Every row is keyed by patients.id (the clinical row an auth user resolves
-- to via patients.auth_user_id), so reinstalling the app or signing in on a
-- second device rebuilds the same diary.
--
-- Diary entries are SELF-CONTAINED nutrition snapshots: name, serving detail,
-- quantity, and the calorie/macro totals as logged. They never re-read the
-- food catalog, mirroring the app's local model where editing a library food
-- must not rewrite history. `entry_id` is the client-generated id (the app
-- builds ids for optimistic rendering and Undo), unique per patient.
--
-- These are CLEAN NEW tables: the legacy pre-reset shapes (patient_logs,
-- patient_measurements, ...) still exist empty in public and are deliberately
-- not reused — the archive re-import task will map old data into these shapes
-- later.
--
-- RLS: enabled with NO policies on purpose, and privileges revoked from
-- anon/authenticated. Only the API server's service role (which bypasses RLS)
-- reads or writes; the mobile app always goes through /api/patient-data/*
-- with a bearer session token. Do not add anon/authenticated policies here.
--
-- Safe to re-run: guarded with IF NOT EXISTS.

-- ── Diary entries ───────────────────────────────────────────────────────────

create table if not exists public.patient_diary_entries (
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Client-generated id (e.g. "log_mf2k1x_7"); opaque to the server.
  entry_id text not null
    check (entry_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  date_key date not null,
  meal text not null
    check (meal in ('breakfast', 'lunch', 'dinner', 'snacks')),
  -- What the entry snapshotted: a catalog/custom food, a recipe, or a
  -- one-off quick log (barcode/label scans and coach quick adds).
  kind text not null
    check (kind in ('food', 'recipe', 'quick')),
  -- Optional reference into the food/recipe catalogs (drives recents);
  -- opaque to the server and allowed to dangle.
  ref_id text
    check (ref_id is null or char_length(ref_id) between 1 and 80),
  name text not null
    check (char_length(name) between 1 and 200),
  detail text not null default ''
    check (char_length(detail) <= 300),
  quantity numeric not null
    check (quantity > 0 and quantity <= 999),
  calories numeric not null check (calories >= 0 and calories <= 50000),
  protein numeric not null check (protein >= 0 and protein <= 5000),
  carbs numeric not null check (carbs >= 0 and carbs <= 5000),
  fat numeric not null check (fat >= 0 and fat <= 5000),
  -- Ingredient-level tweaks from the recipe breakdown editor, stored as the
  -- client's adjustment list (index/amount/unit rows). Null when untouched.
  adjustments jsonb
    check (adjustments is null or jsonb_typeof(adjustments) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (patient_id, entry_id)
);

create index if not exists patient_diary_entries_by_day
  on public.patient_diary_entries (patient_id, date_key);

comment on table public.patient_diary_entries is
  'Live per-patient food diary: self-contained nutrition snapshots (date, meal slot, source kind, logged totals). Written and read solely by the API server via the service role; RLS is enabled with no policies by design.';

alter table public.patient_diary_entries enable row level security;
revoke all on public.patient_diary_entries from anon, authenticated;

-- ── Water by day ────────────────────────────────────────────────────────────

create table if not exists public.patient_water_days (
  patient_id uuid not null references public.patients(id) on delete cascade,
  date_key date not null,
  -- Ounces logged for the day; the app clamps to whole ounces 0..200.
  oz integer not null
    check (oz >= 0 and oz <= 200),
  updated_at timestamptz not null default now(),
  primary key (patient_id, date_key)
);

comment on table public.patient_water_days is
  'Live per-patient water intake by date (whole ounces). Service-role only; RLS enabled with no policies by design.';

alter table public.patient_water_days enable row level security;
revoke all on public.patient_water_days from anon, authenticated;

-- ── Daily-target overrides ──────────────────────────────────────────────────

create table if not exists public.patient_target_overrides (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  -- Each column overrides one default; null means "use the program default",
  -- exactly like the app's local targetOverrides partial.
  calories numeric check (calories is null or (calories >= 0 and calories <= 20000)),
  protein numeric check (protein is null or (protein >= 0 and protein <= 2000)),
  carbs numeric check (carbs is null or (carbs >= 0 and carbs <= 2000)),
  fat numeric check (fat is null or (fat >= 0 and fat <= 2000)),
  water_oz numeric check (water_oz is null or (water_oz >= 0 and water_oz <= 200)),
  updated_at timestamptz not null default now()
);

comment on table public.patient_target_overrides is
  'Live per-patient daily-target overrides (calories/macros/water); null columns fall back to program defaults. Service-role only; RLS enabled with no policies by design.';

alter table public.patient_target_overrides enable row level security;
revoke all on public.patient_target_overrides from anon, authenticated;

-- ── Recents + favorites ─────────────────────────────────────────────────────

create table if not exists public.patient_food_prefs (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  -- Catalog/custom food id lists, stored exactly as the app keeps them
  -- (favorites unordered-append, recents most-recent-first, capped by the
  -- client). Ids are opaque to the server and allowed to dangle.
  favorites jsonb not null default '[]'::jsonb
    check (jsonb_typeof(favorites) = 'array'),
  recents jsonb not null default '[]'::jsonb
    check (jsonb_typeof(recents) = 'array'),
  updated_at timestamptz not null default now()
);

comment on table public.patient_food_prefs is
  'Live per-patient logging preferences: favorite food ids and the most-recently-logged list. Service-role only; RLS enabled with no policies by design.';

alter table public.patient_food_prefs enable row level security;
revoke all on public.patient_food_prefs from anon, authenticated;
