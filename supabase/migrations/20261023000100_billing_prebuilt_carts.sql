-- Expiring, single-use carts composed by office staff. This transient row only
-- stores product selections and a quote; address and card data never live here.
create table if not exists public.billing_prebuilt_carts (
  id uuid primary key default gen_random_uuid(),
  token text not null unique check (length(token) >= 32),
  provider_id text not null references public.providers(provider_id),
  patient_id uuid null references public.patients(id) on delete cascade,
  created_by_user_id uuid null,
  label text null,
  lines jsonb not null,
  quote jsonb not null,
  status text not null default 'open'
    check (status in ('open','verified','checkout','paid','failed','expired','revoked','locked')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  phone_attempts integer not null default 0 check (phone_attempts between 0 and 5),
  verification_id uuid null references public.claim_verifications(id) on delete set null,
  verified_at timestamptz null,
  session_hash text null,
  checkout_attempt integer not null default 0 check (checkout_attempt >= 0),
  -- Set before checkoutCart atomically claims billing_carts, so this cannot be
  -- an immediate FK without reversing the required derived-id flow.
  cart_id uuid null,
  paid_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billing_prebuilt_carts_provider_created_idx
  on public.billing_prebuilt_carts(provider_id, created_at desc);
create index if not exists billing_prebuilt_carts_patient_created_idx
  on public.billing_prebuilt_carts(patient_id, created_at desc) where patient_id is not null;
alter table public.billing_prebuilt_carts enable row level security;
drop trigger if exists billing_touch_updated_at on public.billing_prebuilt_carts;
create trigger billing_touch_updated_at before update on public.billing_prebuilt_carts
  for each row execute function public.billing_touch_updated_at();

-- Patient-less public carts also use the shared checkout claim table.
alter table public.billing_carts alter column patient_id drop not null;

-- The shared verification ledger and atomic send-cap RPC accept this purpose.
alter table public.claim_verifications
  drop constraint if exists claim_verifications_purpose_check;
alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array[
    'claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text, 'recovery'::text,
    'profile_email'::text, 'profile_phone'::text, 'password_change'::text, 'cart_pay'::text
  ]));

-- Join the identity reconciliation write barrier just like billing_carts.
do $$
begin
  if to_regprocedure('private.install_patient_identity_write_guards()') is not null then
    perform private.install_patient_identity_write_guards();
  end if;
end;
$$;

-- Explicit purge classification: prebuilt carts are transient and are deleted,
-- never anonymized. The patient purge RPC ultimately deletes public.patients;
-- this guarded trigger makes that purge step delete these rows before the
-- patient row, in addition to the FK cascade safety net.
create or replace function private.purge_patient_prebuilt_carts()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog
as $$
begin
  delete from public.billing_prebuilt_carts where patient_id = old.id;
  return old;
end;
$$;
drop trigger if exists purge_patient_prebuilt_carts on public.patients;
create trigger purge_patient_prebuilt_carts
  before delete on public.patients for each row
  execute function private.purge_patient_prebuilt_carts();
revoke all on function private.purge_patient_prebuilt_carts() from public;