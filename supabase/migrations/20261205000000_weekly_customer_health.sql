-- Weekly Customer health email + score history.
--
-- Three pieces, all service-role only (the API reads and writes them with the
-- service key after its own HQ membership checks):
--
--   1. hq_member_notification_preferences — one row per HQ member per
--      notification kind. The first kind is the Monday 9am ET Customer health
--      summary email; a member subscribes themself from the page. Keyed by the
--      auth user because hq_memberships.auth_user_id is unique and the row
--      must not outlive the login (cascade).
--   2. office_customer_health_weekly_snapshots — one row per office per ISO
--      week with the score, band, bucket and the five inputs the score was
--      computed from. Written by the weekly run; the page and the email read
--      last week's row to say how each office moved.
--   3. customer_health_weekly_runs — one row per ISO week once the run has
--      written its snapshots and queued its emails. The job's "already ran
--      this week" check reads it, so restarts and repeated ticks on Monday
--      cannot send twice.
--
-- The staff outbox gains the new HQ-addressed kind (weekly_customer_health,
-- provider_id null) so deliveries show on the existing HQ delivery view.

create table if not exists public.hq_member_notification_preferences (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('weekly_customer_health_email')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (auth_user_id, kind)
);
comment on table public.hq_member_notification_preferences is
  'Per-HQ-member notification opt-ins (first kind: the Monday Customer health summary email). Service-role only; the API gates on an active HQ membership.';
alter table public.hq_member_notification_preferences enable row level security;
revoke all on public.hq_member_notification_preferences from public, anon, authenticated;
grant all on public.hq_member_notification_preferences to service_role;

create table if not exists public.office_customer_health_weekly_snapshots (
  iso_week text not null check (iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  provider_id text not null references public.providers(provider_id) on delete cascade,
  as_of_date date not null,
  office_name text not null,
  rank integer not null check (rank >= 1),
  score integer not null check (score between 0 and 100),
  band text not null check (band in ('healthy', 'watch', 'atRisk')),
  bucket text not null check (bucket in ('active', 'quiet3to6', 'quiet6to12', 'quietOverYear')),
  is_new boolean not null default false,
  last_paid_order_at timestamptz,
  active_subscribers integer not null default 0 check (active_subscribers >= 0),
  cancelling_subscriptions integer not null default 0 check (cancelling_subscriptions >= 0),
  app_users integer not null default 0 check (app_users >= 0),
  active_app_users_30d integer not null default 0 check (active_app_users_30d >= 0),
  active_app_users_prior_30d integer not null default 0 check (active_app_users_prior_30d >= 0),
  staff_enrolled integer not null default 0 check (staff_enrolled >= 0),
  flags jsonb not null default '[]'::jsonb,
  captured_at timestamptz not null default now(),
  primary key (iso_week, provider_id)
);
comment on table public.office_customer_health_weekly_snapshots is
  'One Customer health score per office per ISO week (score, band, bucket, the five inputs and the attention flags), written by the weekly-customer-health job. Office-level only. Service-role only.';
create index if not exists office_customer_health_weekly_snapshots_office_idx
  on public.office_customer_health_weekly_snapshots (provider_id, iso_week desc);
alter table public.office_customer_health_weekly_snapshots enable row level security;
revoke all on public.office_customer_health_weekly_snapshots from public, anon, authenticated;
grant all on public.office_customer_health_weekly_snapshots to service_role;

create table if not exists public.customer_health_weekly_runs (
  iso_week text primary key check (iso_week ~ '^[0-9]{4}-W[0-9]{2}$'),
  generated_at timestamptz not null default now(),
  time_zone text not null,
  office_count integer not null default 0 check (office_count >= 0),
  attention_count integer not null default 0 check (attention_count >= 0),
  recipients_queued integer not null default 0 check (recipients_queued >= 0)
);
comment on table public.customer_health_weekly_runs is
  'One row per ISO week once the weekly Customer health run wrote its snapshots and queued its emails; the job treats a present row as "already sent this week". Service-role only.';
alter table public.customer_health_weekly_runs enable row level security;
revoke all on public.customer_health_weekly_runs from public, anon, authenticated;
grant all on public.customer_health_weekly_runs to service_role;

-- ── Staff outbox: admit the weekly HQ summary ───────────────────────────────
alter table public.staff_notifications drop constraint if exists staff_notifications_kind_check;
alter table public.staff_notifications
  add constraint staff_notifications_kind_check
  check (kind in ('staff_attention_digest', 'system_threshold', 'office_access_restricted', 'coach_chat_flag', 'weekly_customer_health'));
alter table public.staff_notifications drop constraint if exists staff_notifications_scope_check;
alter table public.staff_notifications
  add constraint staff_notifications_scope_check
  check (
    (kind in ('system_threshold', 'office_access_restricted', 'weekly_customer_health') and provider_id is null)
    or (kind not in ('system_threshold', 'office_access_restricted', 'weekly_customer_health') and provider_id is not null)
  );
comment on column public.staff_notifications.provider_id is
  'Office the alert belongs to; null only for the HQ-addressed kinds (system_threshold, office_access_restricted, weekly_customer_health).';
