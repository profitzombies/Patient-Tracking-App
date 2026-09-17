-- In-app checkout carts: one row per cart key, claimed before any order row or
-- Stripe call is made. The primary key is the atomic claim: two requests with
-- the same cart key cannot both create a row set, and a cart that died between
-- inserts stays "staging" so the retry finishes the same rows instead of new ones.
create table if not exists public.billing_carts (
  id uuid primary key,
  provider_id text not null references public.providers(provider_id),
  patient_id uuid not null,
  status text not null default 'staging' check (status in ('staging', 'ready')),
  -- Quote snapshot the patient confirmed (for staff and receipts).
  quote jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_carts_patient_idx on public.billing_carts (patient_id, created_at desc);
alter table public.billing_carts enable row level security;
drop trigger if exists billing_touch_updated_at on public.billing_carts;
create trigger billing_touch_updated_at before update on public.billing_carts
  for each row execute function public.billing_touch_updated_at();
