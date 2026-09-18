-- Retention for the three ledgers that never got cleaned: the system job
-- run ledger, the sign-in ledger, and processed billing webhook event rows.
--
-- Each rule is a batched SQL function the retention jobs call with the
-- cutoff they derived from organization policy. Every function honours dry
-- runs itself (count only, no delete) so the job framework's dry-run
-- neutrality holds all the way down.
--
--   retention_trim_job_runs        runs older than the cutoff, always keeping
--                                  the latest p_keep runs per job so the HQ
--                                  System health history stays meaningful;
--                                  item failures follow their runs (FK cascade)
--   retention_trim_sign_ins        sign-in rows older than the cutoff that are
--                                  NOT the account's latest active session, NOT
--                                  backing a still-live GoTrue session, and
--                                  whose "this wasn't me" token has expired.
--                                  ONE delete statement: the guards and the
--                                  delete share a snapshot, so a sign-in that
--                                  lands mid-run can never expose the row it
--                                  supersedes to a stale "latest" decision.
--   retention_trim_billing_webhook_events
--                                  processed (final) webhook event rows older
--                                  than the cutoff; unprocessed or failed rows
--                                  are always kept
--
-- The policy knobs live in the HQ retention section next to the existing
-- windows. Defaults: 90 days of job history, 180 days of sign-ins, 365 days
-- of webhook events.

alter table public.hq_organization_settings
  add column if not exists retention_job_run_days integer not null default 90
    check (retention_job_run_days between 7 and 3650),
  add column if not exists retention_sign_in_days integer not null default 180
    check (retention_sign_in_days between 30 and 3650),
  add column if not exists retention_webhook_event_days integer not null default 365
    check (retention_webhook_event_days between 30 and 3650);

-- ── Job run ledger ──────────────────────────────────────────────────────────

create or replace function public.retention_trim_job_runs(
  p_cutoff timestamptz,
  p_keep integer,
  p_limit integer,
  p_dry_run boolean
)
returns table (runs_deleted integer, item_failures_deleted integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_runs integer := 0;
  v_failures integer := 0;
begin
  if p_cutoff is null then
    raise exception 'cutoff is required';
  end if;
  -- Rank every run within its job (newest first); the first p_keep never
  -- qualify, however old they are. Oldest due rows go first so repeated
  -- batches walk the history forward.
  select coalesce(array_agg(id), array[]::uuid[]) into v_ids
    from (
      select ranked.id
        from (
          select r.id, r.started_at,
                 row_number() over (partition by r.job_name order by r.started_at desc, r.id desc) as rn
            from public.system_job_runs r
        ) ranked
       where ranked.rn > greatest(coalesce(p_keep, 0), 0)
         and ranked.started_at < p_cutoff
       order by ranked.started_at
       limit greatest(coalesce(p_limit, 1000), 1)
    ) due;
  v_runs := cardinality(v_ids);
  if v_runs = 0 then
    runs_deleted := 0;
    item_failures_deleted := 0;
    return next;
    return;
  end if;
  select count(*)::integer into v_failures
    from public.system_job_item_failures f
   where f.run_id = any(v_ids);
  if not p_dry_run then
    -- system_job_item_failures.run_id cascades on delete.
    delete from public.system_job_runs where id = any(v_ids);
  end if;
  runs_deleted := v_runs;
  item_failures_deleted := v_failures;
  return next;
end;
$$;
revoke all on function public.retention_trim_job_runs(timestamptz, integer, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_job_runs(timestamptz, integer, integer, boolean) to service_role;

-- ── Sign-in ledger ──────────────────────────────────────────────────────────
-- SECURITY DEFINER so the live-session guard can consult auth.sessions
-- without any client-facing grant on the auth schema (the same posture as
-- security_list_auth_sessions); the service-role check keeps it out of reach
-- even if execute leaked.

create or replace function public.retention_trim_sign_ins(
  p_cutoff timestamptz,
  p_now timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_cutoff is null or p_now is null then
    raise exception 'cutoff and now are required';
  end if;
  -- One statement for both modes: the "latest active session" and
  -- live-session guards are evaluated in the same snapshot as the delete,
  -- and a dry run simply gates the delete off while still counting `due`.
  with due as (
    select s.id
      from public.auth_sign_ins s
     where s.created_at < p_cutoff
       and (s.report_token_expires_at is null or s.report_token_expires_at < p_now)
       and not exists (select 1 from auth.sessions live where live.id = s.session_id)
       and s.id <> coalesce((
         select latest.id
           from public.auth_sign_ins latest
          where latest.user_id = s.user_id
            and latest.session_id is not null
            and latest.revoked_at is null
          order by latest.created_at desc, latest.id desc
          limit 1
       ), '00000000-0000-0000-0000-000000000000'::uuid)
     order by s.created_at
     limit greatest(coalesce(p_limit, 1000), 1)
  ),
  gone as (
    delete from public.auth_sign_ins s
     using due
     where s.id = due.id
       and not p_dry_run
    returning s.id
  )
  select count(*)::integer into v_count from due;
  return v_count;
end;
$$;
revoke all on function public.retention_trim_sign_ins(timestamptz, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_sign_ins(timestamptz, timestamptz, integer, boolean) to service_role;

-- ── Billing webhook event rows ──────────────────────────────────────────────

create or replace function public.retention_trim_billing_webhook_events(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids text[];
  v_count integer := 0;
begin
  if p_cutoff is null then
    raise exception 'cutoff is required';
  end if;
  -- Final = processed without a recorded error. Unprocessed rows (still
  -- retryable) and failed rows (error set) are never touched here.
  select coalesce(array_agg(stripe_event_id), array[]::text[]) into v_ids
    from (
      select e.stripe_event_id
        from public.billing_webhook_events e
       where e.processed_at is not null
         and e.error is null
         and e.processed_at < p_cutoff
       order by e.processed_at
       limit greatest(coalesce(p_limit, 1000), 1)
    ) due;
  v_count := cardinality(v_ids);
  if p_dry_run or v_count = 0 then
    return v_count;
  end if;
  delete from public.billing_webhook_events where stripe_event_id = any(v_ids);
  return v_count;
end;
$$;
revoke all on function public.retention_trim_billing_webhook_events(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_billing_webhook_events(timestamptz, integer, boolean) to service_role;

notify pgrst, 'reload schema';
