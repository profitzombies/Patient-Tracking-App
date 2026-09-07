-- Real push notifications with delivery tracking.
--
-- Four service-only tables plus two RPCs:
--
--   * patient_push_tokens          Expo push tokens per (patient, device).
--   * patient_notifications        Durable notification outbox. Every push the
--                                  server ever decides to send is a row here,
--                                  from "queued" through its final status.
--   * patient_notification_attempts One row per Expo push ticket (per token)
--                                  with the ticket id, its later receipt, and
--                                  any error the service reported.
--   * patient_outreach_state       Latest server-side coach stall-outreach
--                                  evaluation per patient (roster eligibility).
--
--   * claim_patient_notifications  Leased FOR UPDATE SKIP LOCKED claim so two
--                                  API processes never send the same row.
--   * provider_outreach_states     One office's outreach/notification state
--                                  per patient for the roster chip.
--
-- All four tables are written and read solely by the API server with the
-- service role: RLS is enabled with no policies, anon/authenticated grants are
-- revoked. Every table carrying patient_id joins the patient identity
-- reconciliation write-guard protocol (installer re-run at the end).

-- ── Push tokens ─────────────────────────────────────────────────────────────

create table if not exists public.patient_push_tokens (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Expo push token exactly as the SDK returned it.
  token text not null
    check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_:-]{1,200}\]$'),
  -- App-generated stable id for the installation (SecureStore), so an account
  -- switch on one phone retires the previous account's registration.
  device_id text not null check (char_length(device_id) between 1 and 128),
  platform text not null check (platform in ('ios', 'android')),
  disabled_at timestamptz,
  -- 'signed_out' | 'account_switch' | 'device_not_registered' | 'invalid_credentials'
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 64),
  last_registered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (patient_id, token)
);

comment on table public.patient_push_tokens is
  'Expo push tokens per patient account and device. Service-role only; RLS enabled with no policies by design. Disabled rows are kept for the audit trail (disabled_reason says why).';

create index if not exists patient_push_tokens_active_idx
  on public.patient_push_tokens (patient_id)
  where disabled_at is null;
create index if not exists patient_push_tokens_device_idx
  on public.patient_push_tokens (device_id);

alter table public.patient_push_tokens enable row level security;
revoke all on public.patient_push_tokens from anon, authenticated;

-- ── Notification outbox ─────────────────────────────────────────────────────

create table if not exists public.patient_notifications (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Machine kind ('coach_outreach', 'check_in_reminder', ...).
  kind text not null check (kind ~ '^[a-z_]{1,64}$'),
  -- Patient-controlled category the preference switches key on.
  category text not null
    check (category in ('coach_outreach', 'check_in_reminders', 'office_reminders')),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 2000),
  -- Deep-link payload delivered with the push (route + ids); opaque here.
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  -- Optional idempotency key ("coach_outreach:<patient>:<crossing day>").
  dedupe_key text unique check (dedupe_key is null or char_length(dedupe_key) <= 200),
  scheduled_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days',
  status text not null default 'queued'
    check (status in (
      'queued', 'sending', 'sent', 'delivered', 'opened',
      'failed', 'suppressed', 'opted_out', 'expired'
    )),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or char_length(lease_owner) <= 128),
  lease_until timestamptz,
  -- Why the row was suppressed/deferred/opted out ('quiet_hours', 'no_device',
  -- 'category_off', 'nudge_opt_out', 'quiet_hours_deferred').
  suppression_reason text
    check (suppression_reason is null or char_length(suppression_reason) <= 64),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  -- Patient acted on the notification's purpose (replied to the outreach).
  engaged_at timestamptz,
  -- When the row reached a terminal status.
  finalized_at timestamptz,
  -- Set once receipts were fetched (or given up on) for the sent tickets.
  receipts_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.patient_notifications is
  'Server-side notification outbox: one row per push the server decided to send, with lease/attempt bookkeeping and the final delivery status. Service-role only; RLS enabled with no policies by design.';

create index if not exists patient_notifications_due_idx
  on public.patient_notifications (next_attempt_at)
  where status in ('queued', 'sending');
create index if not exists patient_notifications_receipts_idx
  on public.patient_notifications (sent_at)
  where status = 'sent' and receipts_checked_at is null;
create index if not exists patient_notifications_patient_idx
  on public.patient_notifications (patient_id, created_at desc);

alter table public.patient_notifications enable row level security;
revoke all on public.patient_notifications from anon, authenticated;

-- ── Delivery attempts (one per push ticket) ─────────────────────────────────

create table if not exists public.patient_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.patient_notifications(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  token_id uuid references public.patient_push_tokens(id) on delete set null,
  attempt integer not null check (attempt >= 1),
  ticket_id text check (ticket_id is null or char_length(ticket_id) <= 128),
  -- 'ticket_ok' | 'ticket_error' | 'request_failed'
  outcome text not null check (outcome in ('ticket_ok', 'ticket_error', 'request_failed')),
  error_code text check (error_code is null or char_length(error_code) <= 64),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  -- Receipt bookkeeping for ticket_ok rows: 'ok' | 'error' | 'missing'.
  receipt_outcome text
    check (receipt_outcome is null or receipt_outcome in ('ok', 'error', 'missing')),
  receipt_error_code text
    check (receipt_error_code is null or char_length(receipt_error_code) <= 64),
  receipt_checked_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.patient_notification_attempts is
  'One row per Expo push ticket (per device token) for a notification: ticket id, ticket/receipt outcome and any error code. Service-role only; RLS enabled with no policies by design.';

create index if not exists patient_notification_attempts_notification_idx
  on public.patient_notification_attempts (notification_id, created_at);

alter table public.patient_notification_attempts enable row level security;
revoke all on public.patient_notification_attempts from anon, authenticated;

-- ── Coach outreach evaluation state ─────────────────────────────────────────

create table if not exists public.patient_outreach_state (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  -- Denormalized so one office's roster reads its rows without an id list.
  provider_id text not null,
  evaluated_at timestamptz not null default now(),
  -- The patient's local day the signals were evaluated for.
  as_of_date date not null,
  eligible boolean not null default false,
  crossed_on_key date,
  adherence jsonb not null default '{}'::jsonb check (jsonb_typeof(adherence) = 'object'),
  stall jsonb not null default '{}'::jsonb check (jsonb_typeof(stall) = 'object'),
  -- What the evaluator did: 'not_eligible' | 'enqueued' | 'standing' |
  -- 'cooldown' | 'opted_out' | 'engaged'.
  decision text not null check (char_length(decision) <= 32),
  notification_id uuid references public.patient_notifications(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.patient_outreach_state is
  'Latest server-side coach stall-outreach evaluation per patient (same rules as the companion app). Service-role only; RLS enabled with no policies by design.';

create index if not exists patient_outreach_state_provider_idx
  on public.patient_outreach_state (provider_id);
create index if not exists patient_outreach_state_evaluated_idx
  on public.patient_outreach_state (evaluated_at);

alter table public.patient_outreach_state enable row level security;
revoke all on public.patient_outreach_state from anon, authenticated;

-- ── Leased claim ────────────────────────────────────────────────────────────
--
-- Claims up to p_limit due rows for p_owner: queued rows whose next attempt
-- is due, plus 'sending' rows whose lease expired (a crashed sender). The
-- claimed rows flip to 'sending' with a fresh lease inside the same
-- statement, so concurrent callers (two API instances, an in-process timer
-- and the internal trigger) never hand the same row to two senders.

create or replace function public.claim_patient_notifications(
  p_owner text,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns setof public.patient_notifications
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_owner is null or char_length(p_owner) = 0 then
    raise exception 'lease owner is required';
  end if;
  return query
  with due as (
    select n.id
    from public.patient_notifications n
    where n.next_attempt_at <= now()
      and (
        n.status = 'queued'
        or (n.status = 'sending' and (n.lease_until is null or n.lease_until < now()))
      )
    order by n.next_attempt_at asc, n.created_at asc
    limit greatest(1, least(coalesce(p_limit, 25), 200))
    for update skip locked
  )
  update public.patient_notifications n
  set status = 'sending',
      lease_owner = p_owner,
      lease_until = now() + make_interval(secs => greatest(10, coalesce(p_lease_seconds, 120))),
      updated_at = now()
  from due
  where n.id = due.id
  returning n.*;
end;
$$;

revoke all on function public.claim_patient_notifications(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_patient_notifications(text, integer, integer)
  to service_role;

-- ── Roster outreach states ──────────────────────────────────────────────────
--
-- One row per patient of the office that has ANY outreach state: the latest
-- evaluation, the nudge bookkeeping flags, and the newest coach-outreach
-- notification's status. The API server turns these into the roster chip.

create or replace function public.provider_outreach_states(p_provider_id text)
returns table (
  patient_id uuid,
  eligible boolean,
  crossed_on_key date,
  evaluated_at timestamptz,
  decision text,
  nudge_opt_out boolean,
  nudge_engaged boolean,
  nudge_last_sent_key date,
  nudge_last_crossing_key date,
  notification_id uuid,
  notification_status text,
  notification_updated_at timestamptz,
  notification_suppression_reason text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select
    p.id as patient_id,
    coalesce(s.eligible, false) as eligible,
    s.crossed_on_key,
    s.evaluated_at,
    s.decision,
    coalesce(f.nudge_opt_out, false) as nudge_opt_out,
    coalesce(f.nudge_engaged, false) as nudge_engaged,
    f.nudge_last_sent_key,
    f.nudge_last_crossing_key,
    n.id as notification_id,
    n.status as notification_status,
    n.updated_at as notification_updated_at,
    n.suppression_reason as notification_suppression_reason
  from public.patients p
  left join public.patient_outreach_state s on s.patient_id = p.id
  left join public.patient_flags f on f.patient_id = p.id
  left join lateral (
    select x.id, x.status, x.updated_at, x.suppression_reason
    from public.patient_notifications x
    where x.patient_id = p.id and x.kind = 'coach_outreach'
    order by x.created_at desc
    limit 1
  ) n on true
  where p.provider_id = p_provider_id
    and (s.patient_id is not null or f.patient_id is not null or n.id is not null);
$$;

revoke all on function public.provider_outreach_states(text)
  from public, anon, authenticated;
grant execute on function public.provider_outreach_states(text)
  to service_role;

-- ── Identity write guards for the new patient_id tables ─────────────────────

select private.install_patient_identity_write_guards();
