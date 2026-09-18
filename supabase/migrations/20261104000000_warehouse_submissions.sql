-- Automatic WarehouseCraft submission of paid orders.
--
-- Every paid order gets exactly one submission intent row, created by a
-- trigger inside the same transaction as the paid transition, so a paid order
-- can never miss the warehouse queue. A leased system job drains the intents;
-- the shipment row mirrors the outcome (warehouse id / sent timestamp / state)
-- for the fulfillment screens.

create table if not exists public.billing_warehouse_submissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.billing_orders(id) on delete cascade,
  provider_id uuid not null,
  patient_id uuid references public.patients(id) on delete set null,
  state text not null default 'pending' check (state in ('pending', 'sent', 'needs_attention', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  warehouse_order_id text,
  warehouse_status text,
  last_error text,
  last_error_kind text check (last_error_kind is null or last_error_kind in ('rejected', 'transient', 'incomplete')),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  skipped_reason text,
  payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_warehouse_submissions_order_id_key unique (order_id)
);
create index if not exists billing_warehouse_submissions_due_idx
  on public.billing_warehouse_submissions (next_attempt_at) where state = 'pending';
create index if not exists billing_warehouse_submissions_recent_idx
  on public.billing_warehouse_submissions (last_attempt_at desc);
alter table public.billing_warehouse_submissions enable row level security;
revoke all on public.billing_warehouse_submissions from anon, authenticated;
drop trigger if exists billing_touch_updated_at on public.billing_warehouse_submissions;
create trigger billing_touch_updated_at before update on public.billing_warehouse_submissions
  for each row execute function public.billing_touch_updated_at();

-- Mirror on the shipment row (what the fulfillment queue reads).
alter table public.billing_shipments
  add column if not exists warehouse_order_id text,
  add column if not exists warehouse_state text check (warehouse_state is null or warehouse_state in ('pending', 'sent', 'needs_attention', 'skipped')),
  add column if not exists warehouse_sent_at timestamptz,
  add column if not exists warehouse_error text;

-- HQ kill switch: pauses the drain without losing intents.
alter table public.billing_settings
  add column if not exists warehouse_auto_submit boolean not null default true;

-- Intent creation rides the paid transition itself (insert or update).
create or replace function public.billing_order_queue_warehouse()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
    insert into public.billing_warehouse_submissions (order_id, provider_id, patient_id)
    values (new.id, new.provider_id, new.patient_id)
    on conflict (order_id) do nothing;
  end if;
  return new;
end;
$$;
-- Trigger-only: never callable through PostgREST rpc.
revoke all on function public.billing_order_queue_warehouse() from public, anon, authenticated;
drop trigger if exists billing_order_queue_warehouse on public.billing_orders;
create trigger billing_order_queue_warehouse after insert or update of status on public.billing_orders
  for each row execute function public.billing_order_queue_warehouse();

-- Join the identity reconciliation write barrier (new patient-linked table).
do $$
begin
  if to_regprocedure('private.install_patient_identity_write_guards()') is not null then
    perform private.install_patient_identity_write_guards();
  end if;
end;
$$;

-- Purge classification: the order itself is anonymized by the purge RPC, so the
-- submission row is kept for accounting but its address-bearing payload is
-- dropped and the patient link cleared before the patient row disappears.
create or replace function private.purge_patient_warehouse_submissions()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  update public.billing_warehouse_submissions
     set payload = null, patient_id = null, last_error = case when last_error is null then null else 'redacted' end
   where patient_id = old.id;
  return old;
end;
$$;
drop trigger if exists purge_patient_warehouse_submissions on public.patients;
create trigger purge_patient_warehouse_submissions
  before delete on public.patients for each row
  execute function private.purge_patient_warehouse_submissions();
revoke all on function private.purge_patient_warehouse_submissions() from public;
