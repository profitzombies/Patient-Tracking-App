-- Office access SETUP GATE: the office cannot use the dashboard until its own
-- money arrangements with THINNR are in place.
--
-- 20261125000000_office_access_subscriptions.sql created the engine (plan,
-- instruments, charges). This migration adds what the *gate* needs on top of
-- it:
--
--   access_disclosure_text        HQ-owned wording of the access-fee terms the
--                                 office acknowledges during setup. The gate
--                                 never hard-codes this copy.
--   plan_selected_at              the office actively chose monthly or yearly
--                                 (the `plan` column has always had a default,
--                                 so it cannot answer "did they choose?").
--   disclosure_acknowledged_*     who accepted the disclosure, when, and which
--                                 settings version they were shown.

begin;

alter table public.hq_organization_settings
  add column if not exists access_disclosure_text text not null default
    'THINNR charges your practice an access fee for the provider dashboard and the provider mobile app. '
    'We keep a bank account and two credit cards on file and charge the bank account first; if it fails we try your cards. '
    'Your included period is free — the first access charge lands the day it ends, at the price shown above. '
    'If an access payment lapses and stays unpaid through the recovery window, your practice keeps operating but THINNR''s share of each patient payment increases until the balance is settled. '
    'You can change cards, re-verify your bank account, or pay a balance at any time from Payment methods.';

alter table public.billing_office_access_subscriptions
  add column if not exists plan_selected_at timestamptz,
  add column if not exists disclosure_acknowledged_at timestamptz,
  add column if not exists disclosure_acknowledged_by text,
  add column if not exists disclosure_version integer;

-- The SetupIntent that collected an instrument. A microdeposit bank account is
-- verified on Stripe's own hosted page, which is reachable only from the
-- SetupIntent, so the office must be able to return to it days later.
alter table public.billing_office_access_instruments
  add column if not exists setup_intent_id text;

comment on column public.billing_office_access_subscriptions.plan_selected_at is
  'Set when the office picks monthly or yearly during setup; null means the plan column is still its default.';
comment on column public.billing_office_access_subscriptions.disclosure_acknowledged_at is
  'Set when the office accepts the HQ-authored access-fee disclosure during setup.';

commit;
