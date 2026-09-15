-- Staff attention digests, delivery preferences and staff push outbox.
-- Every object is service-role only; patient identity guards are reinstalled
-- because office_attention_seen carries patient_id.

alter table public.provider_policy_overrides
  add column if not exists alert_recipient_mode text not null default 'all'
    check (alert_recipient_mode in ('all', 'owners_admins', 'selected')),
  add column if not exists alert_recipient_member_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(alert_recipient_member_ids) = 'array'),
  add column if not exists alert_send_time text not null default '08:00'
    check (alert_send_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists alert_time_zone text;

create table if not exists public.staff_alert_preferences (
  provider_id text not null references public.providers(provider_id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  email_enabled boolean not null default true,
  push_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (provider_id, auth_user_id)
);
comment on table public.staff_alert_preferences is
  'Per-staff-member email and push choices for daily attention alerts. Service-role only; RLS enabled with no policies by design.';

create table if not exists public.staff_push_tokens (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null references public.providers(provider_id) on delete cascade,
  token text not null check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_:-]{1,200}\]$'),
  device_id text not null check (char_length(device_id) between 1 and 128),
  platform text not null check (platform in ('ios', 'android')),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or char_length(disabled_reason) <= 64),
  last_registered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auth_user_id, token)
);
comment on table public.staff_push_tokens is
  'Expo push tokens for office staff. Service-role only; RLS enabled with no policies by design. Disabled rows remain as delivery audit evidence.';
create index if not exists staff_push_tokens_active_idx on public.staff_push_tokens (auth_user_id) where disabled_at is null;
create index if not exists staff_push_tokens_device_idx on public.staff_push_tokens (device_id);

create table if not exists public.staff_notifications (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('push', 'email')),
  email text check (email is null or char_length(email) between 3 and 320),
  kind text not null default 'staff_attention_digest' check (kind = 'staff_attention_digest'),
  category text not null default 'staff_alerts' check (category = 'staff_alerts'),
  title text not null check (char_length(title) between 1 and 200),
  body text not null check (char_length(body) between 1 and 2000),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  dedupe_key text not null unique check (char_length(dedupe_key) <= 200),
  scheduled_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '3 days',
  status text not null default 'queued' check (status in ('queued','sending','sent','delivered','opened','failed','suppressed','opted_out','expired')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text check (lease_owner is null or char_length(lease_owner) <= 128),
  lease_until timestamptz,
  suppression_reason text check (suppression_reason is null or char_length(suppression_reason) <= 64),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  engaged_at timestamptz,
  finalized_at timestamptz,
  receipts_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.staff_notifications is
  'Daily staff attention delivery outbox with leased send lifecycle and final outcome. Service-role only; RLS enabled with no policies by design.';
create index if not exists staff_notifications_due_idx on public.staff_notifications (next_attempt_at) where status in ('queued','sending');
create index if not exists staff_notifications_recipient_idx on public.staff_notifications (auth_user_id, created_at desc);

create table if not exists public.staff_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.staff_notifications(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  token_id uuid references public.staff_push_tokens(id) on delete set null,
  attempt integer not null check (attempt >= 1),
  ticket_id text check (ticket_id is null or char_length(ticket_id) <= 128),
  outcome text not null check (outcome in ('ticket_ok','ticket_error','request_failed')),
  error_code text check (error_code is null or char_length(error_code) <= 64),
  error_message text check (error_message is null or char_length(error_message) <= 500),
  receipt_outcome text check (receipt_outcome is null or receipt_outcome in ('ok','error','missing')),
  receipt_error_code text check (receipt_error_code is null or char_length(receipt_error_code) <= 64),
  receipt_checked_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.staff_notification_attempts is
  'One delivery attempt per staff push token, including Expo ticket and receipt state. Service-role only; RLS enabled with no policies by design.';
create index if not exists staff_notification_attempts_notification_idx on public.staff_notification_attempts (notification_id, created_at);

create table if not exists public.office_attention_digests (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null references public.providers(provider_id) on delete cascade,
  digest_date date not null,
  generated_at timestamptz not null default now(),
  time_zone text not null,
  flagged_count integer not null check (flagged_count >= 0),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  unique (provider_id, digest_date)
);
comment on table public.office_attention_digests is
  'Immutable once-daily office snapshots of patients whose live facts need staff attention. Service-role only; RLS enabled with no policies by design.';
create index if not exists office_attention_digests_provider_idx on public.office_attention_digests (provider_id, digest_date desc);

create table if not exists public.office_attention_seen (
  provider_id text not null references public.providers(provider_id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  signature text not null check (char_length(signature) between 1 and 512),
  seen_at timestamptz not null default now(),
  primary key (provider_id, auth_user_id, patient_id)
);
comment on table public.office_attention_seen is
  'Per-staff acknowledgement of a patient attention signature; a changed signature becomes unseen automatically. Service-role only; RLS enabled with no policies by design.';

alter table public.staff_alert_preferences enable row level security;
alter table public.staff_push_tokens enable row level security;
alter table public.staff_notifications enable row level security;
alter table public.staff_notification_attempts enable row level security;
alter table public.office_attention_digests enable row level security;
alter table public.office_attention_seen enable row level security;
revoke all on public.staff_alert_preferences, public.staff_push_tokens, public.staff_notifications,
  public.staff_notification_attempts, public.office_attention_digests, public.office_attention_seen
  from public, anon, authenticated;
grant all on public.staff_alert_preferences, public.staff_push_tokens, public.staff_notifications,
  public.staff_notification_attempts, public.office_attention_digests, public.office_attention_seen to service_role;

-- Extend the existing roster RPC so the shared evaluator receives the exact
-- persisted stall JSON and its patient-local dates without another read.
drop function if exists public.provider_outreach_states(text);
create function public.provider_outreach_states(p_provider_id text)
returns table (
  patient_id uuid, eligible boolean, crossed_on_key date, as_of_date date, stall jsonb,
  evaluated_at timestamptz, decision text, nudge_opt_out boolean, nudge_engaged boolean,
  nudge_last_sent_key date, nudge_last_crossing_key date, notification_id uuid,
  notification_status text, notification_updated_at timestamptz,
  notification_suppression_reason text
)
language sql stable set search_path = public, pg_temp
as $$
  select p.id, coalesce(s.eligible,false), s.crossed_on_key, s.as_of_date, s.stall,
    s.evaluated_at, s.decision, coalesce(f.nudge_opt_out,false),
    coalesce(f.nudge_engaged,false), f.nudge_last_sent_key,
    f.nudge_last_crossing_key, n.id, n.status, n.updated_at, n.suppression_reason
  from public.patients p
  left join public.patient_outreach_state s on s.patient_id=p.id
  left join public.patient_flags f on f.patient_id=p.id
  left join lateral (
    select x.id,x.status,x.updated_at,x.suppression_reason
    from public.patient_notifications x
    where x.patient_id=p.id and x.kind='coach_outreach'
    order by x.created_at desc limit 1
  ) n on true
  where p.provider_id=p_provider_id
    and (s.patient_id is not null or f.patient_id is not null or n.id is not null);
$$;
revoke all on function public.provider_outreach_states(text) from public, anon, authenticated;
grant execute on function public.provider_outreach_states(text) to service_role;

create or replace function public.claim_staff_notifications(
  p_owner text, p_limit integer default 25, p_lease_seconds integer default 120
)
returns setof public.staff_notifications
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if p_owner is null or char_length(p_owner) = 0 then raise exception 'lease owner is required'; end if;
  return query
  with due as (
    select n.id from public.staff_notifications n
    where n.next_attempt_at <= now()
      and (n.status = 'queued' or (n.status = 'sending' and (n.lease_until is null or n.lease_until < now())))
    order by n.next_attempt_at, n.created_at
    limit greatest(1, least(coalesce(p_limit, 25), 200))
    for update skip locked
  )
  update public.staff_notifications n
  set status='sending', lease_owner=p_owner,
      lease_until=now() + make_interval(secs => greatest(10, coalesce(p_lease_seconds,120))),
      updated_at=now()
  from due where n.id=due.id returning n.*;
end;
$$;
revoke all on function public.claim_staff_notifications(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_staff_notifications(text, integer, integer) to service_role;

select private.install_patient_identity_write_guards();
notify pgrst, 'reload schema';