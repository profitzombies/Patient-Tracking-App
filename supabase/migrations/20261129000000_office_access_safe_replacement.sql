-- Office access instruments: safe replacement and the name on each method.
--
-- Three things the instrument ledger could not express before:
--
--   staged_at               a replacement bank account that is still waiting
--                           on Stripe's test deposits. It sits beside the
--                           verified account it will replace (which stays
--                           chargeable) and is promoted once it verifies, or
--                           dropped if verification fails or expires.
--   replaces_instrument_id  the live row a staged bank will take over from.
--   detached_at             when the payment method was detached from the
--                           office's Stripe customer after being replaced.
--                           A removed row with no detached_at is still
--                           attached in Stripe and is swept by the billing job
--                           once no charge is in flight.
--   billing_name            the cardholder / account-holder name saved on the
--                           payment method, shown on Payment methods.
--
-- The one-live-instrument-per-slot rule now counts only rows that are in
-- service (not removed and not staged); a second partial index allows at most
-- one staged replacement per slot.

begin;

alter table public.billing_office_access_instruments
  add column if not exists staged_at timestamptz,
  add column if not exists replaces_instrument_id uuid
    references public.billing_office_access_instruments(id) on delete set null,
  add column if not exists detached_at timestamptz,
  add column if not exists billing_name text;

drop index if exists public.billing_office_access_instruments_slot_key;
create unique index if not exists billing_office_access_instruments_slot_key
  on public.billing_office_access_instruments (subscription_id, slot, stripe_mode, stripe_platform_account_id)
  where removed_at is null and staged_at is null;

create unique index if not exists billing_office_access_instruments_staged_slot_key
  on public.billing_office_access_instruments (subscription_id, slot, stripe_mode, stripe_platform_account_id)
  where removed_at is null and staged_at is not null;

-- The billing job looks for replaced rows still attached in Stripe.
create index if not exists billing_office_access_instruments_undetached_idx
  on public.billing_office_access_instruments (stripe_mode, stripe_platform_account_id)
  where removed_at is not null and detached_at is null;

comment on column public.billing_office_access_instruments.staged_at is
  'Set while a replacement bank account awaits microdeposit verification; the row it replaces stays in service until it verifies.';
comment on column public.billing_office_access_instruments.detached_at is
  'When the replaced payment method was detached from the office''s platform Stripe customer.';

commit;
