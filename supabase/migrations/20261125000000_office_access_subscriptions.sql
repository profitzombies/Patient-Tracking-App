-- Office access subscriptions: THINNR's own revenue stream.
--
-- Everything else in billing_* moves money on the OFFICE's connected Stripe
-- account (patients pay their office, THINNR takes an application fee). This
-- migration owns the second, independent direction: the office pays THINNR for
-- access to the provider dashboard and provider mobile app, billed on THINNR's
-- OWN platform account.
--
--   hq_organization_settings.access_*        HQ-configurable prices and policy
--   billing_office_access_subscriptions      one row per office: plan, price,
--                                            included period, paid-through,
--                                            current access state
--   billing_office_access_instruments        the bank account and two cards
--                                            stored on the platform customer
--   billing_office_access_attempts           every charge attempt and outcome
--   billing_office_access_events             auditable state/override history
--   claim_office_access_charge(...)          idempotent per-period claim
--
-- Like every billing_* table these carry the immutable (stripe_mode,
-- stripe_platform_account_id) identity pair and the guard trigger installed by
-- 20261112000000_billing_mode_isolation.sql, so test and live data can never
-- mix or reference each other.

begin;

-- ── HQ pricing and policy ───────────────────────────────────────────────────
-- Prices are the standard list; an office can be overridden individually on
-- its own subscription row. The included period is the free window before paid
-- billing starts (default one year, up to three); "lifetime" is a per-office
-- flag, not a setting.

alter table public.hq_organization_settings
  add column if not exists access_monthly_price_cents integer not null default 20000
    check (access_monthly_price_cents >= 0 and access_monthly_price_cents <= 10000000),
  add column if not exists access_yearly_price_cents integer not null default 200000
    check (access_yearly_price_cents >= 0 and access_yearly_price_cents <= 100000000),
  add column if not exists access_included_period_days integer not null default 365
    check (access_included_period_days >= 0 and access_included_period_days <= 1095),
  add column if not exists access_grace_period_days integer not null default 7
    check (access_grace_period_days >= 1 and access_grace_period_days <= 30),
  add column if not exists access_share_normal_percent integer not null default 60
    check (access_share_normal_percent >= 0 and access_share_normal_percent <= 100),
  add column if not exists access_share_restricted_percent integer not null default 100
    check (access_share_restricted_percent >= 0 and access_share_restricted_percent <= 100);

-- ── Per-office access subscription ──────────────────────────────────────────

create table if not exists public.billing_office_access_subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  -- The access state machine. Only the server writes it; see
  -- artifacts/api-server/src/billing/office-access/state.ts for the legal
  -- transitions and for the derivation that re-checks it from the dates.
  state text not null default 'setup_incomplete'
    check (state in ('setup_incomplete', 'included_period', 'paid_current', 'past_due', 'restricted')),
  plan text not null default 'monthly' check (plan in ('monthly', 'yearly')),
  -- HQ per-office price override in cents; null = the HQ standard price.
  price_cents_override integer check (price_cents_override is null or price_cents_override >= 0),
  -- Set once, by the office owner's first provider-dashboard sign-in.
  included_period_started_at timestamptz,
  included_period_ends_at timestamptz,
  -- The complimentary override: never billed, never restricted.
  lifetime boolean not null default false,
  -- Access is paid for up to this instant, whoever paid and however.
  paid_through timestamptz,
  paid_through_source text check (paid_through_source in ('stripe', 'offline', 'hq_migration')),
  -- The period a charge is currently being collected for.
  current_period_start timestamptz,
  current_period_end timestamptz,
  -- The recovery clock. grace_started_at is stamped from the FAILURE
  -- NOTIFICATION (a late ACH bounce starts it on the day it arrives, not on
  -- the day the debit was submitted).
  grace_started_at timestamptz,
  grace_ends_at timestamptz,
  restricted_at timestamptz,
  -- Platform-account Stripe customer holding the instruments.
  stripe_customer_id text,
  setup_completed_at timestamptz,
  -- 48 hours after setup: a microdeposit bank account must be verified by then.
  bank_verification_deadline timestamptz,
  last_attempt_at timestamptz,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_mode text not null check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text not null,
  constraint billing_office_access_subscriptions_identity_pair
    check (stripe_mode is not null and stripe_platform_account_id is not null),
  constraint billing_office_access_subscriptions_provider_key
    unique (provider_id, stripe_mode, stripe_platform_account_id)
);
create index if not exists billing_office_access_subscriptions_identity_idx
  on public.billing_office_access_subscriptions (stripe_mode, stripe_platform_account_id);
create index if not exists billing_office_access_subscriptions_due_idx
  on public.billing_office_access_subscriptions (state, paid_through);

-- ── Stored instruments ──────────────────────────────────────────────────────
-- Exactly three slots. The charge waterfall walks them in this order:
-- bank → card_primary → card_backup.

create table if not exists public.billing_office_access_instruments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.billing_office_access_subscriptions(id) on delete cascade,
  provider_id text not null,
  slot text not null check (slot in ('bank', 'card_primary', 'card_backup')),
  kind text not null check (kind in ('bank', 'card')),
  stripe_payment_method_id text not null,
  -- Stripe's card fingerprint: the same physical card presented twice shares
  -- it even with a different number, expiry or wallet token.
  fingerprint text,
  brand text,
  last4 text,
  exp_month integer check (exp_month is null or (exp_month >= 1 and exp_month <= 12)),
  exp_year integer check (exp_year is null or (exp_year >= 2000 and exp_year <= 2100)),
  bank_name text,
  verification_status text not null default 'verified'
    check (verification_status in ('verified', 'pending', 'failed')),
  verification_deadline timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_mode text not null check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text not null,
  constraint billing_office_access_instruments_identity_pair
    check (stripe_mode is not null and stripe_platform_account_id is not null),
  constraint billing_office_access_instruments_kind_slot
    check ((slot = 'bank') = (kind = 'bank'))
);
create index if not exists billing_office_access_instruments_identity_idx
  on public.billing_office_access_instruments (stripe_mode, stripe_platform_account_id);
-- One live instrument per slot; replaced ones keep their history via removed_at.
create unique index if not exists billing_office_access_instruments_slot_key
  on public.billing_office_access_instruments (subscription_id, slot, stripe_mode, stripe_platform_account_id)
  where removed_at is null;
-- The backup card may not be the same physical card as the primary.
create unique index if not exists billing_office_access_instruments_fingerprint_key
  on public.billing_office_access_instruments (subscription_id, fingerprint, stripe_mode, stripe_platform_account_id)
  where removed_at is null and kind = 'card' and fingerprint is not null;

-- ── Charge attempts ─────────────────────────────────────────────────────────
-- One row per instrument tried. `cycle` is the dunning cycle within the period
-- (1 = the first billing run, 2..n = the recovery retries).

create table if not exists public.billing_office_access_attempts (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.billing_office_access_subscriptions(id) on delete cascade,
  provider_id text not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  cycle integer not null check (cycle >= 1),
  slot text not null check (slot in ('bank', 'card_primary', 'card_backup')),
  plan text not null check (plan in ('monthly', 'yearly')),
  amount_cents integer not null check (amount_cents >= 0),
  stripe_payment_intent_id text,
  -- processing: an ACH debit Stripe has accepted but not settled. It can still
  -- succeed or fail days later, which is what the webhook handlers are for.
  status text not null default 'processing'
    check (status in ('processing', 'succeeded', 'failed')),
  failure_code text,
  failure_message text,
  settled_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stripe_mode text not null check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text not null,
  constraint billing_office_access_attempts_identity_pair
    check (stripe_mode is not null and stripe_platform_account_id is not null),
  constraint billing_office_access_attempts_cycle_slot_key
    unique (subscription_id, period_start, cycle, slot, stripe_mode, stripe_platform_account_id)
);
create index if not exists billing_office_access_attempts_identity_idx
  on public.billing_office_access_attempts (stripe_mode, stripe_platform_account_id);
create index if not exists billing_office_access_attempts_period_idx
  on public.billing_office_access_attempts (subscription_id, period_start, cycle);
create unique index if not exists billing_office_access_attempts_intent_key
  on public.billing_office_access_attempts (stripe_payment_intent_id, stripe_mode, stripe_platform_account_id)
  where stripe_payment_intent_id is not null;

-- ── Auditable history ───────────────────────────────────────────────────────

create table if not exists public.billing_office_access_events (
  id bigint generated always as identity primary key,
  subscription_id uuid not null references public.billing_office_access_subscriptions(id) on delete cascade,
  provider_id text not null,
  event text not null,
  from_state text,
  to_state text,
  actor_user_id uuid,
  actor_kind text not null default 'system'
    check (actor_kind in ('system', 'hq', 'provider', 'team_member', 'stripe')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  stripe_mode text not null check (stripe_mode in ('test', 'live')),
  stripe_platform_account_id text not null,
  constraint billing_office_access_events_identity_pair
    check (stripe_mode is not null and stripe_platform_account_id is not null)
);
create index if not exists billing_office_access_events_identity_idx
  on public.billing_office_access_events (stripe_mode, stripe_platform_account_id);
create index if not exists billing_office_access_events_subscription_idx
  on public.billing_office_access_events (subscription_id, created_at desc);

-- ── Access posture ──────────────────────────────────────────────────────────
-- No client may read or write any of this: the server is the only authority
-- over an office's access state.

alter table public.billing_office_access_subscriptions enable row level security;
alter table public.billing_office_access_instruments enable row level security;
alter table public.billing_office_access_attempts enable row level security;
alter table public.billing_office_access_events enable row level security;
revoke all on table public.billing_office_access_subscriptions,
                  public.billing_office_access_instruments,
                  public.billing_office_access_attempts,
                  public.billing_office_access_events
  from public, anon, authenticated;
grant all on table public.billing_office_access_subscriptions,
                 public.billing_office_access_instruments,
                 public.billing_office_access_attempts,
                 public.billing_office_access_events
  to service_role;

-- The identity guard is installed by a one-shot DO block in the mode-isolation
-- migration, so new billing tables attach it themselves.
do $$
declare t text;
begin
  foreach t in array array[
    'billing_office_access_subscriptions', 'billing_office_access_instruments',
    'billing_office_access_attempts', 'billing_office_access_events'
  ] loop
    if not exists (
      select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass
        and tgname = 'billing_identity_guard'
    ) then
      execute format(
        'create trigger billing_identity_guard before insert or update on public.%I for each row execute function public.guard_billing_identity()', t);
    end if;
  end loop;
end $$;

-- ── Idempotent per-period claim ─────────────────────────────────────────────
-- Billing the same period twice must never double-charge. The caller claims a
-- cycle before it talks to Stripe: under a per-subscription advisory lock this
-- refuses when the period is already paid or when an attempt is still in
-- flight (an unsettled ACH debit), and otherwise hands back the cycle number
-- to record attempts under.
--
-- p_cycle lets the dunning runner ask for one specific recovery cycle; passing
-- null means "the next one".

create or replace function public.claim_office_access_charge(
  p_subscription_id uuid,
  p_period_start timestamptz,
  p_cycle integer default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cycle integer;
  v_exists boolean;
begin
  if p_subscription_id is null or p_period_start is null then
    raise exception 'Subscription and period are required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-access-charge:' || p_subscription_id::text, 0));

  -- Already collected for this period: nothing to claim, ever again.
  if exists (
    select 1 from public.billing_office_access_attempts
    where subscription_id = p_subscription_id and period_start = p_period_start and status = 'succeeded'
  ) then
    return null;
  end if;
  -- A debit is still in flight (ACH). Wait for its webhook rather than
  -- submitting a second one.
  if exists (
    select 1 from public.billing_office_access_attempts
    where subscription_id = p_subscription_id and period_start = p_period_start and status = 'processing'
  ) then
    return null;
  end if;

  if p_cycle is null then
    select coalesce(max(cycle), 0) + 1 into v_cycle
    from public.billing_office_access_attempts
    where subscription_id = p_subscription_id and period_start = p_period_start;
  else
    v_cycle := p_cycle;
    select exists (
      select 1 from public.billing_office_access_attempts
      where subscription_id = p_subscription_id and period_start = p_period_start and cycle = v_cycle
    ) into v_exists;
    -- A named cycle that already ran is a replay, not a new charge.
    if v_exists then return null; end if;
  end if;
  return v_cycle;
end $$;

revoke all on function public.claim_office_access_charge(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_office_access_charge(uuid, timestamptz, integer) to service_role;

commit;
