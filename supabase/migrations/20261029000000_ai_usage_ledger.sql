-- AI usage ledger: one row per model call, plus the HQ cost summary.
--
-- AI spend is the one cost that grows in a straight line with usage, and
-- until now only photo reads reported what they cost (in a log line). The
-- API server's shared OpenAI client now meters EVERY call — coach chat,
-- photo/menu/label reads, recipes, titles, support chat, images — and
-- writes them here in batches (artifacts/api-server/src/ai-usage/ledger.ts).
--
-- Rows are counts and ids only: model, token counts (prompt / cached-prompt
-- / completion / reasoning), latency, and an estimated cost in
-- micro-dollars priced from a versioned rate table. Never prompt text,
-- never reply text, never a photo. Patient attribution is a nullable
-- reference so an account purge simply detaches the rows; the spend stays
-- countable for the office and the organization.
--
-- ai_usage_summary(from, to) is the single read HQ needs: totals and
-- breakdowns by UTC day, office, surface, and model for the range, with
-- the active-patient counts (from patient_app_presence) that turn spend
-- into cost per active patient. Service-role only, like the table.

create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  surface text not null,
  api text not null,
  model text not null,
  response_model text,
  scope text not null check (scope in ('patient', 'office', 'anonymous', 'system', 'unattributed')),
  patient_id uuid references public.patients(id) on delete set null,
  provider_id text,
  stream boolean not null default false,
  status text not null check (status in ('ok', 'error', 'aborted')),
  usage_reported boolean not null default false,
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  cached_tokens integer not null default 0 check (cached_tokens >= 0 and cached_tokens <= prompt_tokens),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0 and reasoning_tokens <= completion_tokens),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  first_token_ms integer check (first_token_ms is null or first_token_ms >= 0),
  -- Estimated cost in micro-dollars (1 USD = 1,000,000); null = model unpriced.
  estimated_cost_micros bigint check (estimated_cost_micros is null or estimated_cost_micros >= 0),
  pricing_version text,
  request_id text
);
comment on table public.ai_usage_events is
  'One row per model call made by the API server: surface, model, token counts (prompt/cached/completion/reasoning), latency, and estimated cost in micro-dollars. Counts and ids only; no prompt or reply text. Service-role only.';

create index if not exists ai_usage_events_occurred_idx on public.ai_usage_events (occurred_at desc);
create index if not exists ai_usage_events_provider_idx on public.ai_usage_events (provider_id, occurred_at desc) where provider_id is not null;
create index if not exists ai_usage_events_patient_idx on public.ai_usage_events (patient_id, occurred_at desc) where patient_id is not null;
create index if not exists ai_usage_events_surface_idx on public.ai_usage_events (surface, occurred_at desc);

alter table public.ai_usage_events enable row level security;
revoke all on public.ai_usage_events from public, anon, authenticated;
grant all on public.ai_usage_events to service_role;

-- ── HQ summary ──────────────────────────────────────────────────────────────
-- Days are UTC calendar days of the call. Active patients are distinct
-- patients with an app-presence day inside the range (their local days);
-- "AI patients" are distinct patients with at least one attributed call.
create or replace function public.ai_usage_summary(
  p_from date,
  p_to date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_from is null or p_to is null or p_from > p_to then raise exception 'invalid range'; end if;
  if p_to - p_from > 400 then raise exception 'range too long'; end if;
  v_start := p_from::timestamp at time zone 'UTC';
  v_end := (p_to + 1)::timestamp at time zone 'UTC';

  with ev as (
    select e.*, (e.occurred_at at time zone 'UTC')::date as day
    from ai_usage_events e
    where e.occurred_at >= v_start and e.occurred_at < v_end
  ), presence as (
    select a.patient_id, p.provider_id
    from patient_app_presence a
    join patients p on p.id = a.patient_id
    where a.day between p_from and p_to
    group by a.patient_id, p.provider_id
  ), totals as (
    select
      count(*)::bigint as calls,
      count(*) filter (where status = 'ok')::bigint as ok_calls,
      count(*) filter (where status = 'error')::bigint as error_calls,
      count(*) filter (where status = 'aborted')::bigint as aborted_calls,
      coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
      coalesce(sum(completion_tokens), 0)::bigint as completion_tokens,
      coalesce(sum(reasoning_tokens), 0)::bigint as reasoning_tokens,
      coalesce(sum(estimated_cost_micros), 0)::bigint as cost_micros,
      count(*) filter (where estimated_cost_micros is null and usage_reported)::bigint as unpriced_calls,
      count(distinct patient_id)::bigint as ai_patients,
      (select count(*) from presence)::bigint as active_patients
    from ev
  ), by_day as (
    select day,
      count(*)::bigint as calls,
      coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
      coalesce(sum(completion_tokens), 0)::bigint as completion_tokens,
      coalesce(sum(estimated_cost_micros), 0)::bigint as cost_micros,
      count(distinct patient_id)::bigint as ai_patients
    from ev group by day order by day
  ), office_ids as (
    select provider_id from ev where provider_id is not null
    union
    select provider_id from presence where provider_id is not null
  ), by_office as (
    select o.provider_id,
      pr.office_name, pr.provider_name,
      coalesce(u.calls, 0)::bigint as calls,
      coalesce(u.prompt_tokens, 0)::bigint as prompt_tokens,
      coalesce(u.cached_tokens, 0)::bigint as cached_tokens,
      coalesce(u.completion_tokens, 0)::bigint as completion_tokens,
      coalesce(u.cost_micros, 0)::bigint as cost_micros,
      coalesce(u.ai_patients, 0)::bigint as ai_patients,
      coalesce(a.active_patients, 0)::bigint as active_patients
    from office_ids o
    left join providers pr on pr.provider_id = o.provider_id
    left join (
      select provider_id,
        count(*) as calls, sum(prompt_tokens) as prompt_tokens, sum(cached_tokens) as cached_tokens,
        sum(completion_tokens) as completion_tokens, sum(estimated_cost_micros) as cost_micros,
        count(distinct patient_id) as ai_patients
      from ev where provider_id is not null group by provider_id
    ) u on u.provider_id = o.provider_id
    left join (
      select provider_id, count(*) as active_patients from presence group by provider_id
    ) a on a.provider_id = o.provider_id
    order by coalesce(u.cost_micros, 0) desc, o.provider_id
  ), by_surface as (
    select surface,
      count(*)::bigint as calls,
      count(*) filter (where status = 'error')::bigint as error_calls,
      coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
      coalesce(sum(completion_tokens), 0)::bigint as completion_tokens,
      coalesce(sum(reasoning_tokens), 0)::bigint as reasoning_tokens,
      coalesce(sum(estimated_cost_micros), 0)::bigint as cost_micros,
      round(avg(latency_ms))::bigint as avg_latency_ms,
      percentile_cont(0.95) within group (order by latency_ms)::bigint as p95_latency_ms
    from ev group by surface order by cost_micros desc, surface
  ), by_model as (
    select model,
      count(*)::bigint as calls,
      coalesce(sum(prompt_tokens), 0)::bigint as prompt_tokens,
      coalesce(sum(cached_tokens), 0)::bigint as cached_tokens,
      coalesce(sum(completion_tokens), 0)::bigint as completion_tokens,
      coalesce(sum(estimated_cost_micros), 0)::bigint as cost_micros,
      bool_or(estimated_cost_micros is null and usage_reported) as unpriced
    from ev group by model order by cost_micros desc, model
  ), unattributed as (
    select coalesce(sum(estimated_cost_micros), 0)::bigint as cost_micros, count(*)::bigint as calls
    from ev where provider_id is null
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', (select to_jsonb(t) from totals t),
    'unattributed', (select to_jsonb(u) from unattributed u),
    'by_day', coalesce((select jsonb_agg(to_jsonb(d) order by d.day) from by_day d), '[]'::jsonb),
    'by_office', coalesce((select jsonb_agg(to_jsonb(o) order by o.cost_micros desc, o.provider_id) from by_office o), '[]'::jsonb),
    'by_surface', coalesce((select jsonb_agg(to_jsonb(s) order by s.cost_micros desc, s.surface) from by_surface s), '[]'::jsonb),
    'by_model', coalesce((select jsonb_agg(to_jsonb(m) order by m.cost_micros desc, m.model) from by_model m), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.ai_usage_summary(date, date) from public, anon, authenticated;
grant execute on function public.ai_usage_summary(date, date) to service_role;
