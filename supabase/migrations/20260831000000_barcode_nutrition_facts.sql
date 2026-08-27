-- THINNR barcode nutrition cache — shared per-serving nutrition facts for
-- packaged foods, keyed by normalized barcode (EAN-8 or GTIN-13; UPC-A is
-- stored zero-padded to 13 digits).
--
-- The mobile diary's barcode scanner looks products up through the API
-- server: the server checks this table FIRST and only calls Open Food Facts
-- on a miss, saving the normalized result here. The first successful scan of
-- a product (by anyone) therefore answers every later scan of that code from
-- our own table, with no third-party call at all. Rows are product facts
-- only — no user identity, no scan history, no timestamps beyond fetched_at.
--
-- RLS: enabled with NO policies on purpose. Only the API server's service
-- role (which bypasses RLS) reads or writes; anon and authenticated clients
-- get nothing. Do not add anon policies here — the mobile app always goes
-- through GET /api/barcode/:code.
--
-- Safe to re-run: guarded with IF NOT EXISTS.

create table if not exists public.barcode_nutrition_facts (
  -- Canonical barcode: digits only, EAN-8 kept as 8 digits, everything else
  -- normalized to its 13-digit GTIN form by the API server before touching
  -- this table.
  code text primary key
    check (code ~ '^[0-9]{8}$' or code ~ '^[0-9]{13}$'),
  name text not null
    check (char_length(name) between 1 and 120),
  brand text
    check (brand is null or char_length(brand) between 1 and 80),
  -- The serving the values below describe, as labeled on the package
  -- ("30 g", "2 cookies (28g)"); "100 g" when the source only published
  -- per-100g values.
  serving text not null
    check (char_length(serving) between 1 and 80),
  calories numeric not null check (calories >= 0),
  protein numeric not null check (protein >= 0),
  carbs numeric not null check (carbs >= 0),
  fat numeric not null check (fat >= 0),
  -- Which upstream produced the row (openfoodfacts today; the server proxy
  -- keeps a later provider swap cheap).
  source text not null default 'openfoodfacts'
    check (char_length(source) between 1 and 40),
  fetched_at timestamptz not null default now()
);

comment on table public.barcode_nutrition_facts is
  'Shared nutrition-facts cache for barcode-scanned packaged foods. Product facts only (no user data); written and read solely by the API server via the service role. RLS is enabled with no policies by design.';

alter table public.barcode_nutrition_facts enable row level security;
