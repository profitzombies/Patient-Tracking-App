-- Customer email delivery ledger.
--
-- billing_customer_emails grows from a once-only claim into the delivery record
-- staff act on: each row is one email to one address, retried up to
-- max_attempts before it is terminal, and carries the template id plus the
-- PHI-linted variables it was rendered from so a preview can re-render it
-- later. Bodies are never stored. Automatic rows keep the transition dedupe
-- key (one automatic email per transition, retries reuse the claim); resends
-- and one-off "send to another address" rows are new rows linked to the
-- original through parent_id and never count as a second automatic send.
alter table public.billing_customer_emails
  add column if not exists kind text not null default 'automatic'
    check (kind in ('automatic', 'resend', 'send_to_other')),
  add column if not exists parent_id uuid references public.billing_customer_emails(id),
  add column if not exists payer_id uuid references public.billing_payers(id),
  add column if not exists recipient text,
  add column if not exists subject text,
  add column if not exists variables jsonb,
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists vendor_message_id text,
  -- One entry per attempt: { at, outcome: sent|failed, error, vendor_message_id, recipient_hash, recipient_domain }.
  add column if not exists attempt_log jsonb not null default '[]'::jsonb,
  add column if not exists requested_by uuid;
-- Copies fanned out to a payer's additional contacts point back at the contact
-- (added after the contacts table exists, below).

-- 'retrying' = at least one failed attempt, another is scheduled (next_attempt_at).
alter table public.billing_customer_emails drop constraint if exists billing_customer_emails_status_check;
alter table public.billing_customer_emails
  add constraint billing_customer_emails_status_check
    check (status in ('claimed', 'retrying', 'sent', 'skipped', 'failed'));
alter table public.billing_customer_emails drop constraint if exists billing_customer_emails_attempts_check;
alter table public.billing_customer_emails
  add constraint billing_customer_emails_attempts_check check (attempts >= 0 and max_attempts between 1 and 10);

create index if not exists billing_customer_emails_retry_idx
  on public.billing_customer_emails (next_attempt_at) where status = 'retrying';
create index if not exists billing_customer_emails_payer_idx
  on public.billing_customer_emails (payer_id, created_at desc);
create index if not exists billing_customer_emails_provider_idx
  on public.billing_customer_emails (provider_id, created_at desc);
create index if not exists billing_customer_emails_created_idx
  on public.billing_customer_emails (created_at desc, id desc);
create index if not exists billing_customer_emails_vendor_message_idx
  on public.billing_customer_emails (vendor_message_id) where vendor_message_id is not null;
create index if not exists billing_customer_emails_parent_idx
  on public.billing_customer_emails (parent_id) where parent_id is not null;

-- Additional notification contacts: extra addresses a payer wants copied on
-- future order and shipment emails. Each contact receives its own ledger row
-- (same template and variables, its own retry budget). Removal is a soft
-- flag so the history of who was copied stays intact.
create table if not exists public.billing_notification_contacts (
  id uuid primary key default gen_random_uuid(),
  payer_id uuid not null references public.billing_payers(id),
  provider_id text not null references public.providers(provider_id),
  email text not null,
  label text,
  active boolean not null default true,
  created_by uuid,
  removed_at timestamptz,
  removed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_mode text check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text,
  constraint billing_notification_contacts_identity_pair
    check ((stripe_mode is null) = (stripe_platform_account_id is null)),
  constraint billing_notification_contacts_email_check check (email = lower(btrim(email)) and position('@' in email) > 1)
);
create index if not exists billing_notification_contacts_identity_idx
  on public.billing_notification_contacts (stripe_mode, stripe_platform_account_id);
create index if not exists billing_notification_contacts_payer_idx
  on public.billing_notification_contacts (payer_id, created_at asc);
create unique index if not exists billing_notification_contacts_active_unique
  on public.billing_notification_contacts (payer_id, email, stripe_mode, stripe_platform_account_id) where active;
alter table public.billing_notification_contacts enable row level security;
revoke all on public.billing_notification_contacts from anon, authenticated;
drop trigger if exists billing_touch_updated_at on public.billing_notification_contacts;
create trigger billing_touch_updated_at before update on public.billing_notification_contacts
  for each row execute function public.billing_touch_updated_at();
drop trigger if exists billing_identity_guard on public.billing_notification_contacts;
create trigger billing_identity_guard before insert or update on public.billing_notification_contacts
  for each row execute function public.guard_billing_identity();

-- Vendor delivery events (delivered / opened / clicked / bounced / complained),
-- keyed by the vendor message id so webhook ingestion can attach them to the
-- ledger row. Populated by the outbox work; created here so the ledger has
-- one place for them from the start.
create table if not exists public.billing_customer_email_events (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.billing_customer_emails(id),
  vendor_message_id text not null,
  vendor_event_id text,
  event_type text not null check (event_type in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked')),
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_mode text check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text,
  constraint billing_customer_email_events_identity_pair
    check ((stripe_mode is null) = (stripe_platform_account_id is null)),
  constraint billing_customer_email_events_vendor_event_unique
    unique (vendor_event_id, stripe_mode, stripe_platform_account_id)
);
create index if not exists billing_customer_email_events_identity_idx
  on public.billing_customer_email_events (stripe_mode, stripe_platform_account_id);
create index if not exists billing_customer_email_events_message_idx
  on public.billing_customer_email_events (vendor_message_id, occurred_at desc);
create index if not exists billing_customer_email_events_email_idx
  on public.billing_customer_email_events (email_id, occurred_at desc);
alter table public.billing_customer_email_events enable row level security;
revoke all on public.billing_customer_email_events from anon, authenticated;
drop trigger if exists billing_touch_updated_at on public.billing_customer_email_events;
create trigger billing_touch_updated_at before update on public.billing_customer_email_events
  for each row execute function public.billing_touch_updated_at();
drop trigger if exists billing_identity_guard on public.billing_customer_email_events;
create trigger billing_identity_guard before insert or update on public.billing_customer_email_events
  for each row execute function public.guard_billing_identity();

alter table public.billing_customer_emails
  add column if not exists contact_id uuid references public.billing_notification_contacts(id);
