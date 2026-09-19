-- Legal holds for patients and offices.
--
-- When counsel, a regulator, or a lawsuit says "keep everything", nothing
-- about that patient (or every patient of that office) may be deleted, no
-- matter what the retention timers or a deletion request say. This
-- migration adds the hold ledger, ONE predicate every destructive path
-- reuses, and redefines every trim / claim so held rows are never selected
-- (the guard lives inside the same statement as the delete). A pending
-- patient deletion request parks in status 'held' while a hold is active
-- and resumes its remaining grace when the hold lifts.
--
-- Holds are HQ-only: the table is service-role only and every write goes
-- through the API, which records the audit event. Nothing here is visible
-- to the patient app.

-- ── Hold ledger ─────────────────────────────────────────────────────────────

create table if not exists public.legal_holds (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately NOT a foreign key: the hold must outlive nothing (a held
  -- patient cannot be purged) but must not block a later office offboarding
  -- design either.
  target_kind text not null check (target_kind in ('patient', 'provider')),
  target_id text not null check (char_length(target_id) between 1 and 120),
  reason text not null check (char_length(reason) between 3 and 500),
  placed_by uuid,
  placed_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by uuid,
  lift_reason text check (lift_reason is null or char_length(lift_reason) between 3 and 500),
  check ((lifted_at is null) = (lift_reason is null))
);
comment on table public.legal_holds is
  'HQ legal holds. An active row (lifted_at is null) blocks every deletion path for the patient, or for every patient of the office. No PII beyond the reason text HQ typed.';
create unique index if not exists legal_holds_active_target_idx
  on public.legal_holds (target_kind, target_id) where lifted_at is null;
create index if not exists legal_holds_placed_idx on public.legal_holds (placed_at desc);

alter table public.legal_holds enable row level security;
revoke all on table public.legal_holds from public, anon, authenticated;
grant select, insert, update on table public.legal_holds to service_role;

-- ── The predicate ───────────────────────────────────────────────────────────
-- `legal_hold_active(patient_id)` is true when the patient itself or the
-- patient's office carries an active hold. It resolves the office live
-- (patients.provider_id) so a hold placed on an office covers patients who
-- join later. `legal_hold_office_active(provider_id)` is the office half on
-- its own, for rows that carry only a provider_id.

create or replace function public.legal_hold_office_active(p_provider_id text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_provider_id is not null and exists (
    select 1 from public.legal_holds h
    where h.lifted_at is null and h.target_kind = 'provider' and h.target_id = p_provider_id
  );
$$;

create or replace function public.legal_hold_active(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_patient_id is not null and (
    exists (
      select 1 from public.legal_holds h
      where h.lifted_at is null and h.target_kind = 'patient' and h.target_id = p_patient_id::text
    )
    or exists (
      select 1
      from public.patients p
      join public.legal_holds h
        on h.lifted_at is null and h.target_kind = 'provider' and h.target_id = p.provider_id
      where p.id = p_patient_id
    )
  );
$$;

-- PostgREST computed column: `select=...,legal_hold` on public.patients.
create or replace function public.legal_hold(p public.patients)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select public.legal_hold_active(p.id); $$;

/** Every patient currently covered by a hold (directly or through the office). */
create or replace function public.legal_hold_patient_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id from public.patients p where public.legal_hold_active(p.id);
$$;

revoke all on function public.legal_hold_office_active(text) from public, anon, authenticated;
revoke all on function public.legal_hold_active(uuid) from public, anon, authenticated;
revoke all on function public.legal_hold(public.patients) from public, anon, authenticated;
revoke all on function public.legal_hold_patient_ids() from public, anon, authenticated;
grant execute on function public.legal_hold_office_active(text) to service_role;
grant execute on function public.legal_hold_active(uuid) to service_role;
grant execute on function public.legal_hold(public.patients) to service_role;
grant execute on function public.legal_hold_patient_ids() to service_role;

-- ── Deletion requests learn 'held' ──────────────────────────────────────────

alter table public.patient_deletion_requests drop constraint if exists patient_deletion_requests_status_check;
alter table public.patient_deletion_requests
  add constraint patient_deletion_requests_status_check
  check (status in ('pending', 'held', 'cancelled', 'purging', 'purged', 'failed'));
alter table public.patient_deletion_requests add column if not exists held_at timestamptz;
comment on column public.patient_deletion_requests.held_at is
  'Set while a legal hold parks this request (status held). The remaining grace is purge_after - held_at and is re-applied when the hold lifts.';
drop index if exists public.patient_deletion_requests_active_idx;
create unique index if not exists patient_deletion_requests_active_idx
  on public.patient_deletion_requests (patient_id)
  where status in ('pending', 'held', 'purging', 'failed');

-- Idempotent request: a held request is still the open one.
create or replace function public.patient_deletion_request(p_patient_id uuid, p_grace_seconds integer default 604800)
returns setof public.patient_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
  v_auth uuid;
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select p.provider_id, p.auth_user_id into v_provider, v_auth
  from patients p where p.id = p_patient_id and p.archived_at is null for update;
  if not found then raise exception 'unknown patient'; end if;
  select r.id into v_id from patient_deletion_requests r
  where r.patient_id = p_patient_id and r.status in ('pending', 'held', 'purging', 'failed');
  if v_id is null then
    insert into patient_deletion_requests (patient_id, provider_id, auth_user_id, purge_after, status, held_at)
    values (
      p_patient_id, v_provider, v_auth,
      now() + make_interval(secs => greatest(0, coalesce(p_grace_seconds, 604800))),
      case when public.legal_hold_active(p_patient_id) then 'held' else 'pending' end,
      case when public.legal_hold_active(p_patient_id) then now() else null end
    )
    returning id into v_id;
  end if;
  update patients set deletion_requested_at = coalesce(deletion_requested_at, now()) where id = p_patient_id;
  return query select * from patient_deletion_requests where id = v_id;
end;
$$;
revoke all on function public.patient_deletion_request(uuid, integer) from public, anon, authenticated;
grant execute on function public.patient_deletion_request(uuid, integer) to service_role;

-- Cancelling keeps data, so a held request may be cancelled too.
create or replace function public.patient_deletion_cancel(p_patient_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  update patient_deletion_requests
  set status = 'cancelled', cancelled_at = now(), held_at = null
  where patient_id = p_patient_id and status in ('pending', 'held');
  get diagnostics v_count = row_count;
  if v_count > 0 then
    update patients set deletion_requested_at = null where id = p_patient_id;
  end if;
  return v_count > 0;
end;
$$;
revoke all on function public.patient_deletion_cancel(uuid) from public, anon, authenticated;
grant execute on function public.patient_deletion_cancel(uuid) to service_role;

-- The claim never selects a held request, and never a request whose patient
-- is covered by a hold placed since (belt and braces: the predicate runs in
-- the same statement as the lease).
create or replace function public.claim_due_patient_deletions(
  p_owner text,
  p_limit integer default 5,
  p_lease_seconds integer default 600
)
returns setof public.patient_deletion_requests
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_owner is null or char_length(p_owner) = 0 then raise exception 'lease owner is required'; end if;
  return query
  with due as (
    select r.id
    from patient_deletion_requests r
    where ((r.status = 'pending' and r.purge_after <= now())
       or (r.status = 'failed' and r.next_attempt_at is not null and r.next_attempt_at <= now())
       or (r.status = 'purging' and (r.lease_until is null or r.lease_until < now())))
      and not public.legal_hold_active(r.patient_id)
    order by r.purge_after asc
    limit greatest(1, least(coalesce(p_limit, 5), 50))
    for update skip locked
  )
  update patient_deletion_requests r
  set status = 'purging',
      started_at = coalesce(r.started_at, now()),
      attempts = r.attempts + 1,
      lease_owner = p_owner,
      lease_until = now() + make_interval(secs => greatest(30, coalesce(p_lease_seconds, 600)))
  from due
  where r.id = due.id
  returning r.*;
end;
$$;
revoke all on function public.claim_due_patient_deletions(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_due_patient_deletions(text, integer, integer) to service_role;

-- ── Place / lift ────────────────────────────────────────────────────────────
-- Both are one transaction with the deletion-request transition so a request
-- can never purge between "hold row exists" and "request parked".

create or replace function public.legal_hold_place(
  p_target_kind text,
  p_target_id text,
  p_reason text,
  p_actor uuid default null
)
returns setof public.legal_holds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_target_kind not in ('patient', 'provider') then raise exception 'invalid hold target kind'; end if;
  if p_target_kind = 'patient' then
    if not exists (select 1 from patients p where p.id::text = p_target_id) then raise exception 'unknown patient'; end if;
  elsif not exists (select 1 from providers v where v.provider_id = p_target_id) then
    raise exception 'unknown office';
  end if;
  -- One active hold per target: a second request returns the existing hold.
  select h.id into v_id from legal_holds h
  where h.lifted_at is null and h.target_kind = p_target_kind and h.target_id = p_target_id
  for update;
  if v_id is null then
    insert into legal_holds (target_kind, target_id, reason, placed_by)
    values (p_target_kind, p_target_id, p_reason, p_actor)
    returning id into v_id;
  end if;
  -- Park every open deletion request the hold now covers.
  update patient_deletion_requests r
  set status = 'held', held_at = now(), next_attempt_at = null
  where r.status in ('pending', 'failed')
    and public.legal_hold_active(r.patient_id);
  return query select * from legal_holds where id = v_id;
end;
$$;
revoke all on function public.legal_hold_place(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.legal_hold_place(text, text, text, uuid) to service_role;

create or replace function public.legal_hold_lift(
  p_hold_id uuid,
  p_reason text,
  p_actor uuid default null
)
returns setof public.legal_holds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  update legal_holds h
  set lifted_at = now(), lifted_by = p_actor, lift_reason = p_reason
  where h.id = p_hold_id and h.lifted_at is null;
  get diagnostics v_count = row_count;
  if v_count = 0 then raise exception 'hold not active'; end if;
  -- Resume the grace clock: whatever was left when the hold landed is what
  -- remains now. A request that was already due resumes as due.
  update patient_deletion_requests r
  set status = 'pending',
      purge_after = now() + greatest(r.purge_after - coalesce(r.held_at, now()), interval '0'),
      held_at = null
  where r.status = 'held'
    and not public.legal_hold_active(r.patient_id);
  return query select * from legal_holds where id = p_hold_id;
end;
$$;
revoke all on function public.legal_hold_lift(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.legal_hold_lift(uuid, text, uuid) to service_role;

-- ── Trims and compaction become hold-aware ──────────────────────────────────
-- Each function below is the canonical definition copied verbatim from its
-- previous migration with the hold predicate added to the row selection.

-- retention_trim_chat_transcripts (from 20261008020000_coach_privacy.sql)
create or replace function public.retention_trim_chat_transcripts(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns table(messages_deleted integer, conversations_deleted integer, media_paths text[])
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_messages integer := 0;
  v_conversations integer := 0;
  v_paths text[] := array[]::text[];
begin
  if p_cutoff is null then
    raise exception 'cutoff is required';
  end if;
  create temp table if not exists retention_chat_candidates (
    conversation_id uuid, client_id text, photo_path text
  ) on commit drop;
  truncate retention_chat_candidates;

  insert into retention_chat_candidates (conversation_id, client_id, photo_path)
  select m.conversation_id, m.client_id, m.photo->>'path'
  from public.patient_chat_messages m
  join public.patient_chat_conversations c on c.id = m.conversation_id
  where m.created_at < p_cutoff
    and c.thread in ('coach', 'support')
    and not public.legal_hold_active(c.patient_id)
    and not exists (
      select 1 from public.patient_deletion_requests d
      where d.patient_id = c.patient_id
        and d.status in ('pending', 'purging', 'failed')
    )
  order by m.created_at
  limit greatest(coalesce(p_limit, 1000), 1);

  select count(*)::integer into v_messages from retention_chat_candidates;
  if p_dry_run then
    select coalesce(array_agg(distinct cand.photo_path), array[]::text[])
    into v_paths
    from retention_chat_candidates cand
    where cand.photo_path is not null
      and not exists (
        select 1 from public.patient_chat_messages m2
        where m2.photo->>'path' = cand.photo_path
          and not exists (
            select 1 from retention_chat_candidates c2
            where c2.conversation_id = m2.conversation_id
              and c2.client_id = m2.client_id
          )
      );
    select count(*)::integer into v_conversations
    from public.patient_chat_conversations c
    where c.thread in ('coach', 'support')
      and c.updated_at < p_cutoff
      and not public.legal_hold_active(c.patient_id)
      and not exists (
        select 1 from public.patient_chat_messages m
        where m.conversation_id = c.id
          and not exists (
            select 1 from retention_chat_candidates c2
            where c2.conversation_id = m.conversation_id
              and c2.client_id = m.client_id
          )
      );
    return query select v_messages, v_conversations, v_paths;
    return;
  end if;

  delete from public.patient_chat_messages m
  using retention_chat_candidates cand
  where m.conversation_id = cand.conversation_id
    and m.client_id = cand.client_id;

  with removed as (
    delete from public.patient_media pm
    where pm.kind = 'chat'
      and pm.object_path in (
        select cand.photo_path from retention_chat_candidates cand where cand.photo_path is not null
      )
      and not exists (
        select 1 from public.patient_chat_messages m where m.photo->>'path' = pm.object_path
      )
    returning pm.object_path
  )
  select coalesce(array_agg(object_path), array[]::text[]) into v_paths from removed;

  with gone as (
    delete from public.patient_chat_conversations c
    where c.thread in ('coach', 'support')
      and c.updated_at < p_cutoff
      and not public.legal_hold_active(c.patient_id)
      and not exists (
        select 1 from public.patient_chat_messages m where m.conversation_id = c.id
      )
      and not exists (
        select 1 from public.patient_deletion_requests d
        where d.patient_id = c.patient_id and d.status in ('pending', 'purging', 'failed')
      )
    returning 1
  )
  select count(*)::integer into v_conversations from gone;
  return query select v_messages, v_conversations, v_paths;
end;
$$;

revoke all on function public.retention_trim_chat_transcripts(timestamptz,integer,boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_chat_transcripts(timestamptz,integer,boolean) to service_role;
-- retention_trim_notifications (from 20260929000000_system_jobs_and_storage_hygiene.sql)
create or replace function public.retention_trim_notifications(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_count integer := 0;
begin
  if p_cutoff is null then
    raise exception 'cutoff is required';
  end if;
  select coalesce(array_agg(id), array[]::uuid[]) into v_ids
    from (
      select n.id
        from public.patient_notifications n
       where n.created_at < p_cutoff
         and n.status not in ('queued', 'sending')
         and not public.legal_hold_active(n.patient_id)
       order by n.created_at
       limit greatest(coalesce(p_limit, 1000), 1)
    ) due;
  v_count := cardinality(v_ids);
  if p_dry_run or v_count = 0 then
    return v_count;
  end if;
  delete from public.patient_notifications where id = any(v_ids);
  return v_count;
end;
$$;
revoke all on function public.retention_trim_notifications(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_notifications(timestamptz, integer, boolean) to service_role;

-- ── Retention: audit events → compact monthly archive ──────────────────────

-- retention_archive_audit_events (from 20260929000000_system_jobs_and_storage_hygiene.sql)
create or replace function public.retention_archive_audit_events(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns table(events_archived integer, summaries_touched integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_ids bigint[];
  v_events integer := 0;
  v_summaries integer := 0;
begin
  if p_cutoff is null then
    raise exception 'cutoff is required';
  end if;
  select coalesce(array_agg(id), array[]::bigint[]) into v_ids
    from (
      select e.id
        from public.admin_audit_events e
       where e.occurred_at < p_cutoff
         and not public.legal_hold_office_active(e.provider_id)
         and not (
           e.target_kind = 'patient' and e.target_id ~ '^[0-9a-f-]{36}$'
           and public.legal_hold_active(e.target_id::uuid)
         )
       order by e.occurred_at
       limit greatest(coalesce(p_limit, 5000), 1)
    ) due;
  v_events := cardinality(v_ids);
  if v_events = 0 then
    return query select 0, 0;
    return;
  end if;
  if p_dry_run then
    select count(*)::integer into v_summaries
      from (
        select 1
          from public.admin_audit_events e
         where e.id = any(v_ids)
         group by date_trunc('month', e.occurred_at), e.action, e.actor_kind, coalesce(e.target_kind, ''), coalesce(e.provider_id, '')
      ) g;
    return query select v_events, v_summaries;
    return;
  end if;

  with grouped as (
    select date_trunc('month', e.occurred_at)::date as period_start,
           e.action, e.actor_kind,
           coalesce(e.target_kind, '') as target_kind,
           coalesce(e.provider_id, '') as provider_id,
           count(*) as event_count,
           min(e.occurred_at) as first_at,
           max(e.occurred_at) as last_at
      from public.admin_audit_events e
     where e.id = any(v_ids)
     group by 1, 2, 3, 4, 5
  ), upserted as (
    insert into public.admin_audit_event_archives as a
      (period_start, action, actor_kind, target_kind, provider_id, event_count, first_at, last_at, archived_at)
    select period_start, action, actor_kind, target_kind, provider_id, event_count, first_at, last_at, now()
      from grouped
    on conflict (period_start, action, actor_kind, target_kind, provider_id) do update
      set event_count = a.event_count + excluded.event_count,
          first_at = least(a.first_at, excluded.first_at),
          last_at = greatest(a.last_at, excluded.last_at),
          archived_at = now()
    returning 1
  )
  select count(*)::integer into v_summaries from upserted;

  perform set_config('app.audit_retention_run', 'on', true);
  delete from public.admin_audit_events where id = any(v_ids);
  perform set_config('app.audit_retention_run', 'off', true);

  return query select v_events, v_summaries;
end;
$$;
revoke all on function public.retention_archive_audit_events(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_archive_audit_events(timestamptz, integer, boolean) to service_role;

-- retention_trim_staff_alerts (from 20261014000000_staff_attention_alerts_privacy.sql)
create or replace function public.retention_trim_staff_alerts(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_notification_ids uuid[];
  v_digest_ids uuid[];
  v_count integer := 0;
begin
  if p_cutoff is null then raise exception 'cutoff is required'; end if;

  with due as (
    select kind, id from (
      select 'notification'::text as kind, n.id, coalesce(n.finalized_at, n.scheduled_at) as due_at
      from public.staff_notifications n
      where n.status not in ('queued', 'sending')
        and coalesce(n.finalized_at, n.scheduled_at) < p_cutoff
        and not public.legal_hold_office_active(n.provider_id)
        and not exists (
          select 1 from public.legal_hold_patient_ids() held
          where position(held::text in n.data::text) > 0
        )
      union all
      select 'digest'::text, d.id, d.generated_at
      from public.office_attention_digests d
      where d.generated_at < p_cutoff
        and not public.legal_hold_office_active(d.provider_id)
        and not exists (
          select 1 from public.legal_hold_patient_ids() held
          where position(held::text in d.items::text) > 0
        )
    ) candidates
    order by due_at, id
    limit greatest(coalesce(p_limit, 1000), 1)
  )
  select
    coalesce(array_agg(id) filter (where kind = 'notification'), array[]::uuid[]),
    coalesce(array_agg(id) filter (where kind = 'digest'), array[]::uuid[])
  into v_notification_ids, v_digest_ids
  from due;

  v_count := cardinality(v_notification_ids) + cardinality(v_digest_ids);
  if p_dry_run or v_count = 0 then return v_count; end if;

  delete from public.staff_notifications where id = any(v_notification_ids);
  delete from public.office_attention_digests where id = any(v_digest_ids);
  return v_count;
end;
$$;
revoke all on function public.retention_trim_staff_alerts(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_staff_alerts(timestamptz, integer, boolean) to service_role;


-- job runs / sign-ins / webhook events (from 20261027000000_ledger_retention.sql)
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
         and not exists (
           select 1
             from public.system_job_item_failures f
            where f.run_id = ranked.id
              and (
                exists (select 1 from public.legal_hold_patient_ids() held where position(held::text in f.item) > 0)
                or exists (
                  select 1 from public.legal_holds h
                  where h.lifted_at is null and h.target_kind = 'provider' and position(h.target_id in f.item) > 0
                )
              )
         )
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
       and not exists (
         select 1 from public.patients hp
          where hp.auth_user_id = s.user_id and public.legal_hold_active(hp.id)
       )
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
         and not exists (
           select 1 from public.billing_connected_accounts a
            where a.stripe_account_id = e.account and public.legal_hold_office_active(a.provider_id)
         )
         and not exists (
           select 1 from public.billing_payers bp
            where bp.stripe_customer_id is not null
              and bp.stripe_customer_id = e.payload #>> '{data,object,customer}'
              and public.legal_hold_active(bp.patient_id)
         )
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

-- ── Proof ───────────────────────────────────────────────────────────────────
do $proof$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'legal_hold_active') then
    raise exception 'legal_hold_active missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'retention_trim_sign_ins' and p.prosecdef) then
    raise exception 'retention_trim_sign_ins lost security definer';
  end if;
end
$proof$;
