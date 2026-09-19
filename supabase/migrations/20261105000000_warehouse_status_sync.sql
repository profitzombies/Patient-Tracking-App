-- WarehouseCraft status, tracking, and delivered sync.
--
-- A leased system job polls the 3PL's order-status feed and applies what it
-- sees to the shipment rows of orders that were submitted to the warehouse.
-- The shipment row remembers the last warehouse status it saw, the key of the
-- last event it applied (so re-polling the same window is a no-op), and the
-- raw row, while a small poll ledger feeds System health and the stalled-feed
-- alert.

alter table public.billing_shipments
  add column if not exists warehouse_status text,
  add column if not exists warehouse_status_at timestamptz,
  add column if not exists warehouse_back_ordered boolean not null default false,
  add column if not exists warehouse_event_key text,
  add column if not exists warehouse_last_event jsonb,
  add column if not exists warehouse_synced_at timestamptz;

-- One row per poll. Trimmed by the sync job itself (older than 7 days).
create table if not exists public.billing_warehouse_sync_polls (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean not null default false,
  window_start date not null,
  window_end date not null,
  rows_seen integer not null default 0,
  matched integer not null default 0,
  transitions integer not null default 0,
  errors integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists billing_warehouse_sync_polls_started_idx
  on public.billing_warehouse_sync_polls (started_at desc);
alter table public.billing_warehouse_sync_polls enable row level security;
revoke all on public.billing_warehouse_sync_polls from anon, authenticated;
