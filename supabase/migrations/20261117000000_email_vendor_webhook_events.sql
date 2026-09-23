-- Email vendor webhook inbox.
--
-- The email vendor (Resend) posts signed delivery events (sent, delivered,
-- delivery delayed, bounced, complained, opened, clicked) that reference the
-- vendor message id returned at send time. Every accepted event lands here
-- first, exactly once per vendor event id, whether or not a ledger row with
-- that message id exists yet: the vendor's "sent" event can beat our own
-- ledger update, and a message id we never issued must not be dropped on the
-- floor. Matched events are additionally copied into
-- billing_customer_email_events (which carries the billing identity of its
-- ledger row) so the scoped ledger reads light up; this table is identity-free
-- on purpose because an unmatched event has no identity to carry.
--
-- No recipient address, subject, or body is stored here: the row holds the
-- vendor ids, the event type, its time, and a small detail object (click
-- link, bounce classification) that the outbox page can explain from.
create table if not exists public.email_vendor_events (
  id uuid primary key default gen_random_uuid(),
  vendor text not null default 'resend',
  vendor_event_id text not null,
  vendor_message_id text not null,
  event_type text not null check (event_type in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked')),
  occurred_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb,
  email_id uuid references public.billing_customer_emails(id) on delete set null,
  matched_at timestamptz,
  received_at timestamptz not null default now(),
  constraint email_vendor_events_vendor_event_unique unique (vendor, vendor_event_id)
);
create index if not exists email_vendor_events_message_idx
  on public.email_vendor_events (vendor_message_id, occurred_at desc);
create index if not exists email_vendor_events_received_idx
  on public.email_vendor_events (received_at desc);
create index if not exists email_vendor_events_unmatched_idx
  on public.email_vendor_events (received_at) where email_id is null;
alter table public.email_vendor_events enable row level security;
revoke all on public.email_vendor_events from anon, authenticated;

-- One row of webhook health: when the last event arrived and how many
-- deliveries were refused for a bad or missing signature. Refusals are
-- counted (never stored) so a forgery flood cannot grow a table; the count
-- is bumped atomically by the RPC below.
create table if not exists public.email_webhook_health (
  vendor text primary key,
  last_event_at timestamptz,
  last_event_type text,
  last_rejected_at timestamptz,
  rejected_total bigint not null default 0,
  rejected_day_count integer not null default 0,
  rejected_day date,
  updated_at timestamptz not null default now()
);
alter table public.email_webhook_health enable row level security;
revoke all on public.email_webhook_health from anon, authenticated;
insert into public.email_webhook_health (vendor) values ('resend') on conflict (vendor) do nothing;

create or replace function public.email_webhook_note_rejection(p_vendor text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.email_webhook_health as h (vendor, last_rejected_at, rejected_total, rejected_day_count, rejected_day, updated_at)
  values (p_vendor, now(), 1, 1, (now() at time zone 'utc')::date, now())
  on conflict (vendor) do update set
    last_rejected_at = now(),
    rejected_total = h.rejected_total + 1,
    rejected_day_count = case when h.rejected_day = (now() at time zone 'utc')::date then h.rejected_day_count + 1 else 1 end,
    rejected_day = (now() at time zone 'utc')::date,
    updated_at = now();
$$;
revoke all on function public.email_webhook_note_rejection(text) from public, anon, authenticated;

create or replace function public.email_webhook_note_event(p_vendor text, p_event_type text, p_at timestamptz)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.email_webhook_health as h (vendor, last_event_at, last_event_type, updated_at)
  values (p_vendor, p_at, p_event_type, now())
  on conflict (vendor) do update set
    last_event_at = greatest(coalesce(h.last_event_at, p_at), p_at),
    last_event_type = case when h.last_event_at is null or p_at >= h.last_event_at then p_event_type else h.last_event_type end,
    updated_at = now();
$$;
revoke all on function public.email_webhook_note_event(text, text, timestamptz) from public, anon, authenticated;

-- Delivery facts folded onto the ledger row itself (first time each event
-- was seen, plus the latest event) so list and summary reads never need the
-- event rows: the HQ outbox pages and counts over the ledger alone. Opens are
-- pixel-based (mail clients block or pre-fetch them) and therefore indicative.
alter table public.billing_customer_emails
  add column if not exists delivered_at timestamptz,
  add column if not exists delayed_at timestamptz,
  add column if not exists bounced_at timestamptz,
  add column if not exists complained_at timestamptz,
  add column if not exists opened_at timestamptz,
  add column if not exists clicked_at timestamptz,
  add column if not exists last_event_type text
    check (last_event_type is null or last_event_type in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked')),
  add column if not exists last_event_at timestamptz;
create index if not exists billing_customer_emails_bounced_idx
  on public.billing_customer_emails (bounced_at) where bounced_at is not null;
