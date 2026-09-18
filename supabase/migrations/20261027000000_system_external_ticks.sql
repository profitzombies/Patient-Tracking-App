-- External scheduler heartbeat for the job framework.
--
-- Production runs the API server as an autoscale deployment: no process is
-- guaranteed to be alive during quiet hours, so the in-process tickers are
-- turned off (JOBS_DISABLED=1, NOTIFICATIONS_DISABLED=1) and an external
-- scheduled trigger POSTs /api/internal/jobs/tick and
-- /api/internal/notifications/tick every minute. Each authenticated tick
-- upserts one row here so HQ → System health can show when the trigger last
-- reached the server and warn when it has gone quiet.
--
-- One row per tick kind (never a row per tick): the table is a heartbeat,
-- not a log. Run history stays in system_job_runs.

create table if not exists public.system_external_ticks (
  kind text primary key check (kind in ('jobs', 'notifications')),
  last_at timestamptz not null,
  owner text check (owner is null or char_length(owner) <= 160),
  status text not null check (status in ('succeeded', 'failed')),
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  error text check (error is null or char_length(error) <= 500),
  updated_at timestamptz not null default now()
);

comment on table public.system_external_ticks is
  'Last external scheduler tick per kind (jobs / notifications). Service-role only; HQ reads it through the API.';

alter table public.system_external_ticks enable row level security;
revoke all on public.system_external_ticks from public, anon, authenticated;
grant all on public.system_external_ticks to service_role;
