-- Per-order sandbox verification allowance.
--
-- Stripe TEST (sandbox) orders are never sent to the warehouse, never
-- status-synced and never email or push anybody. End-to-end verification of
-- checkout -> warehouse -> tracking -> email needs one narrow, explicit
-- exception: a row here names ONE sandbox order id, a designated test inbox
-- that receives its emails instead of the payer, and an expiry. The API only
-- honours a row while the warehouse connection points at the SANDBOX tenant;
-- a live tenant ignores the table entirely and real (live-mode) orders are
-- never subject to it. Service role only: no anon/authenticated access.
create table if not exists public.billing_sandbox_verifications (
  order_id uuid primary key references public.billing_orders(id) on delete cascade,
  designated_inbox text not null,
  authorized_by text not null,
  note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint billing_sandbox_verifications_inbox_check check (position('@' in designated_inbox) > 1),
  constraint billing_sandbox_verifications_window_check
    check (expires_at > created_at and expires_at <= created_at + interval '12 hours')
);
create index if not exists billing_sandbox_verifications_expires_idx
  on public.billing_sandbox_verifications (expires_at);
alter table public.billing_sandbox_verifications enable row level security;
revoke all on public.billing_sandbox_verifications from anon, authenticated;
