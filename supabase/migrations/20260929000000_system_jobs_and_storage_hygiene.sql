-- Scheduled retention and storage clean-up.
--
-- Three concerns share this migration because the API's job scheduler needs
-- all of them at once:
--
--   1. System job framework — one lease/state row per named job, one row per
--      run (start, finish, counts, error), and one row per item that failed
--      inside a run. The API's scheduler acquires the lease before running
--      so overlapping processes cannot double-delete; finishing a run folds
--      the outcome into the state row (consecutive failures, capped
--      exponential backoff, last success/failure) so the HQ System health
--      panel is a single read.
--   2. Storage hygiene — upload intents recorded when an upload URL is
--      minted (the only record an abandoned upload leaves), a cross-ledger
--      "is this path referenced anywhere?" function, a paged ledger listing
--      per prefix for two-way reconciliation, and object_missing_at flags so
--      a row whose bytes are gone renders as "file unavailable" instead of a
--      broken link.
--   3. Retention — transactional, dry-run capable trims for chat transcripts,
--      notification history and audit events (archived to a compact monthly
--      summary first; the append-only guard opens ONLY inside that function).
--
-- Every table is service-role only (RLS on, no policies), matching the rest
-- of the live foundation. Safe to re-run.

-- ── System job framework ───────────────────────────────────────────────────

create table if not exists public.system_job_leases (
  job_name text primary key check (job_name ~ '^[a-z0-9_-]{1,64}$'),
  lease_owner text check (lease_owner is null or char_length(lease_owner) <= 128),
  lease_until timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  -- Set after a failure: the scheduler skips the job until then (manual runs ignore it).
  next_eligible_at timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text check (last_status is null or last_status in ('succeeded', 'failed')),
  last_success_at timestamptz,
  last_success_counts jsonb check (last_success_counts is null or jsonb_typeof(last_success_counts) = 'object'),
  last_failure_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  updated_at timestamptz not null default now()
);
comment on table public.system_job_leases is
  'One row per named background job: the run lease plus rolled-up health state (consecutive failures, backoff, last success/failure). Service-role only.';
alter table public.system_job_leases enable row level security;
revoke all on public.system_job_leases from public, anon, authenticated;
grant all on public.system_job_leases to service_role;

create table if not exists public.system_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null check (job_name ~ '^[a-z0-9_-]{1,64}$'),
  trigger text not null check (trigger in ('schedule', 'manual', 'internal', 'user')),
  dry_run boolean not null default false,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  owner text check (owner is null or char_length(owner) <= 128),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  failure_count integer not null default 0 check (failure_count >= 0),
  error text check (error is null or char_length(error) <= 500)
);
comment on table public.system_job_runs is
  'One row per job execution (scheduled, manual, internal trigger, or user-initiated cleanup) with start/finish, counts, and the terminal error. Service-role only.';
create index if not exists system_job_runs_job_started_idx
  on public.system_job_runs (job_name, started_at desc);
alter table public.system_job_runs enable row level security;
revoke all on public.system_job_runs from public, anon, authenticated;
grant all on public.system_job_runs to service_role;

create table if not exists public.system_job_item_failures (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.system_job_runs(id) on delete cascade,
  job_name text not null,
  item text not null check (char_length(item) between 1 and 400),
  error text not null check (char_length(error) between 1 and 500),
  occurred_at timestamptz not null default now()
);
comment on table public.system_job_item_failures is
  'Per-item failures inside a job run (an object that would not delete, a row that would not update). Service-role only.';
create index if not exists system_job_item_failures_job_idx
  on public.system_job_item_failures (job_name, occurred_at desc);
alter table public.system_job_item_failures enable row level security;
revoke all on public.system_job_item_failures from public, anon, authenticated;
grant all on public.system_job_item_failures to service_role;
grant usage, select on sequence public.system_job_item_failures_id_seq to service_role;

-- Acquire (or renew) the lease for one job. Returns true when the caller
-- holds it afterwards; false when another live owner does. The row is
-- created on first sight so the health panel lists every registered job.
create or replace function public.acquire_system_job_lease(
  p_job_name text,
  p_owner text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_held boolean;
begin
  if p_job_name is null or p_owner is null then
    raise exception 'job name and owner are required';
  end if;
  insert into public.system_job_leases as l (job_name, lease_owner, lease_until, last_started_at, updated_at)
  values (p_job_name, p_owner, now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 5)), now(), now())
  on conflict (job_name) do update
    set lease_owner = excluded.lease_owner,
        lease_until = excluded.lease_until,
        last_started_at = now(),
        updated_at = now()
    where l.lease_until is null
       or l.lease_until < now()
       or l.lease_owner = excluded.lease_owner
  returning true into v_held;
  return coalesce(v_held, false);
end;
$$;
revoke all on function public.acquire_system_job_lease(text, text, integer) from public, anon, authenticated;
grant execute on function public.acquire_system_job_lease(text, text, integer) to service_role;

create or replace function public.release_system_job_lease(p_job_name text, p_owner text)
returns void
language sql
set search_path = public, pg_temp
as $$
  update public.system_job_leases
     set lease_owner = null, lease_until = null, updated_at = now()
   where job_name = p_job_name and lease_owner = p_owner;
$$;
revoke all on function public.release_system_job_lease(text, text) from public, anon, authenticated;
grant execute on function public.release_system_job_lease(text, text) to service_role;

-- Heartbeat: extend a lease the caller still holds. Never touches
-- last_started_at (that is the schedule anchor) and never revives a lease
-- that already lapsed or moved to another owner, so a run that stalled past
-- its lease learns it lost the job instead of silently continuing.
create or replace function public.renew_system_job_lease(
  p_job_name text,
  p_owner text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_renewed boolean;
begin
  update public.system_job_leases
     set lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 5)),
         updated_at = now()
   where job_name = p_job_name
     and lease_owner = p_owner
     and lease_until is not null
     and lease_until >= now()
  returning true into v_renewed;
  return coalesce(v_renewed, false);
end;
$$;
revoke all on function public.renew_system_job_lease(text, text, integer) from public, anon, authenticated;
grant execute on function public.renew_system_job_lease(text, text, integer) to service_role;

-- Close a run and fold its outcome into the job state. Dry runs are recorded
-- but never move the health state (they prove nothing about real deletes).
-- Backoff: base * 2^(failures so far), capped at six hours.
create or replace function public.finish_system_job_run(
  p_run_id uuid,
  p_status text,
  p_counts jsonb,
  p_failure_count integer,
  p_error text,
  p_backoff_seconds integer default 300
)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_run public.system_job_runs%rowtype;
  v_backoff double precision;
begin
  if p_status not in ('succeeded', 'failed') then
    raise exception 'status must be succeeded or failed';
  end if;
  update public.system_job_runs
     set status = p_status,
         finished_at = now(),
         counts = coalesce(p_counts, '{}'::jsonb),
         failure_count = coalesce(p_failure_count, 0),
         error = left(p_error, 500)
   where id = p_run_id
   returning * into v_run;
  if v_run.id is null then
    raise exception 'unknown job run %', p_run_id;
  end if;
  if v_run.dry_run then
    update public.system_job_leases
       set lease_owner = null, lease_until = null, updated_at = now()
     where job_name = v_run.job_name and lease_owner = v_run.owner;
    return;
  end if;
  update public.system_job_leases l
     set last_finished_at = now(),
         last_status = p_status,
         consecutive_failures = case when p_status = 'succeeded' then 0 else l.consecutive_failures + 1 end,
         next_eligible_at = case
           when p_status = 'succeeded' then null
           else now() + make_interval(secs => least(
             greatest(coalesce(p_backoff_seconds, 300), 1)::double precision * power(2, least(l.consecutive_failures, 12)),
             21600))
         end,
         last_success_at = case when p_status = 'succeeded' then now() else l.last_success_at end,
         last_success_counts = case when p_status = 'succeeded' then coalesce(p_counts, '{}'::jsonb) else l.last_success_counts end,
         last_failure_at = case when p_status = 'failed' then now() else l.last_failure_at end,
         last_error = case when p_status = 'failed' then left(p_error, 500) else l.last_error end,
         lease_owner = case when l.lease_owner = v_run.owner then null else l.lease_owner end,
         lease_until = case when l.lease_owner = v_run.owner then null else l.lease_until end,
         updated_at = now()
   where l.job_name = v_run.job_name;
  if not found then
    insert into public.system_job_leases (job_name, last_finished_at, last_status, consecutive_failures,
      last_success_at, last_success_counts, last_failure_at, last_error)
    values (v_run.job_name, now(), p_status, case when p_status = 'failed' then 1 else 0 end,
      case when p_status = 'succeeded' then now() end, case when p_status = 'succeeded' then coalesce(p_counts, '{}'::jsonb) end,
      case when p_status = 'failed' then now() end, case when p_status = 'failed' then left(p_error, 500) end);
  end if;
end;
$$;
revoke all on function public.finish_system_job_run(uuid, text, jsonb, integer, text, integer) from public, anon, authenticated;
grant execute on function public.finish_system_job_run(uuid, text, jsonb, integer, text, integer) to service_role;

-- ── Storage hygiene: upload intents ────────────────────────────────────────

create table if not exists public.storage_upload_intents (
  object_path text primary key check (object_path like '/objects/%' and char_length(object_path) <= 300),
  surface text not null check (surface in (
    'patient_media', 'hq_file', 'training_video', 'training_thumbnail', 'training_attachment', 'knowledge_document'
  )),
  owner_id text check (owner_id is null or char_length(owner_id) <= 128),
  issued_at timestamptz not null default now()
);
comment on table public.storage_upload_intents is
  'Every upload URL the API minted, keyed by object path. The abandoned-upload sweep resolves each intent after a grace window: referenced by a ledger → forget it; unreferenced → delete the bytes. Service-role only.';
create index if not exists storage_upload_intents_issued_idx
  on public.storage_upload_intents (issued_at);
alter table public.storage_upload_intents enable row level security;
revoke all on public.storage_upload_intents from public, anon, authenticated;
grant all on public.storage_upload_intents to service_role;

-- ── Storage hygiene: missing-object flags ──────────────────────────────────

alter table public.patient_media add column if not exists object_missing_at timestamptz;
alter table public.hq_private_files add column if not exists object_missing_at timestamptz;
alter table public.knowledge_documents add column if not exists object_missing_at timestamptz;
alter table public.data_exports add column if not exists object_missing_at timestamptz;
alter table public.patient_data_exports add column if not exists object_missing_at timestamptz;
alter table public.training_videos add column if not exists video_missing_at timestamptz;
alter table public.training_videos add column if not exists thumbnail_missing_at timestamptz;

-- Which of the given paths any ledger still references. Every table that can
-- point at an object path is listed here; add new media tables to this union
-- or the sweep will treat their objects as orphans.
create or replace function public.storage_referenced_paths(p_paths text[])
returns setof text
language sql
stable
set search_path = public, pg_temp
as $$
  select object_path from public.patient_media where object_path = any(p_paths)
  union
  select object_path from public.patient_progress_photos where object_path = any(p_paths)
  union
  select photo_path from public.patient_custom_foods where photo_path = any(p_paths)
  union
  select photo_path from public.patient_saved_recipes where photo_path = any(p_paths)
  union
  select photo->>'path' from public.patient_chat_messages where photo->>'path' = any(p_paths)
  union
  select object_path from public.hq_private_files where object_path = any(p_paths)
  union
  select object_path from public.knowledge_documents where object_path = any(p_paths)
  union
  select video_source from public.training_videos where video_source = any(p_paths)
  union
  select thumbnail_source from public.training_videos where thumbnail_source = any(p_paths)
  union
  select a->>'source'
    from public.training_videos v, jsonb_array_elements(case when jsonb_typeof(v.attachments) = 'array' then v.attachments else '[]'::jsonb end) a
   where a->>'source' = any(p_paths)
  union
  select object_path from public.data_exports where object_path = any(p_paths)
  union
  select object_path from public.patient_data_exports where object_path = any(p_paths)
  union
  select object_path from public.training_media_cleanup where object_path = any(p_paths)
$$;
revoke all on function public.storage_referenced_paths(text[]) from public, anon, authenticated;
grant execute on function public.storage_referenced_paths(text[]) to service_role;

-- Paged ledger listing for one prefix (object paths in ascending order after
-- p_after), with the source table and whether the row is currently flagged
-- missing. The reconciliation job walks this against the storage listing.
create or replace function public.storage_ledger_paths(p_prefix text, p_after text, p_limit integer)
returns table(object_path text, source text, missing boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select * from (
    select pm.object_path, 'patient_media'::text as source, pm.object_missing_at is not null as missing
      from public.patient_media pm
    union all
    select pp.object_path, 'patient_progress_photos', false from public.patient_progress_photos pp
    union all
    select cf.photo_path, 'patient_custom_foods', false from public.patient_custom_foods cf where cf.photo_path is not null
    union all
    select sr.photo_path, 'patient_saved_recipes', false from public.patient_saved_recipes sr where sr.photo_path is not null
    union all
    select m.photo->>'path', 'patient_chat_messages', false from public.patient_chat_messages m where m.photo->>'path' is not null
    union all
    select hf.object_path, 'hq_private_files', hf.object_missing_at is not null from public.hq_private_files hf
    union all
    select kd.object_path, 'knowledge_documents', kd.object_missing_at is not null from public.knowledge_documents kd
    union all
    select tv.video_source, 'training_video', tv.video_missing_at is not null from public.training_videos tv where tv.video_source is not null
    union all
    select tv.thumbnail_source, 'training_thumbnail', tv.thumbnail_missing_at is not null from public.training_videos tv where tv.thumbnail_source is not null
    union all
    select a->>'source', 'training_attachment', false
      from public.training_videos v, jsonb_array_elements(case when jsonb_typeof(v.attachments) = 'array' then v.attachments else '[]'::jsonb end) a
     where a->>'source' is not null
    union all
    select de.object_path, 'data_exports', de.object_missing_at is not null from public.data_exports de where de.object_path is not null
    union all
    select pe.object_path, 'patient_data_exports', pe.object_missing_at is not null from public.patient_data_exports pe where pe.object_path is not null
    union all
    select mc.object_path, 'training_media_cleanup', false from public.training_media_cleanup mc
  ) ledger
  where ledger.object_path like p_prefix || '%'
    and (p_after is null or ledger.object_path > p_after)
  order by ledger.object_path
  limit greatest(coalesce(p_limit, 500), 1)
$$;
revoke all on function public.storage_ledger_paths(text, text, integer) from public, anon, authenticated;
grant execute on function public.storage_ledger_paths(text, text, integer) to service_role;

-- Set (p_missing = true) or clear (false) the missing flag on every ledger row
-- that points at one of the paths. Idempotent; returns rows changed.
create or replace function public.storage_mark_object_missing(p_paths text[], p_missing boolean)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_total integer := 0;
  v_n integer;
begin
  if p_paths is null or cardinality(p_paths) = 0 then
    return 0;
  end if;
  update public.patient_media
     set object_missing_at = case when p_missing then coalesce(object_missing_at, now()) end
   where object_path = any(p_paths) and (object_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update public.hq_private_files
     set object_missing_at = case when p_missing then coalesce(object_missing_at, now()) end
   where object_path = any(p_paths) and (object_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update public.knowledge_documents
     set object_missing_at = case when p_missing then coalesce(object_missing_at, now()) end
   where object_path = any(p_paths) and (object_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update public.data_exports
     set object_missing_at = case when p_missing then coalesce(object_missing_at, now()) end
   where object_path = any(p_paths) and (object_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update public.patient_data_exports
     set object_missing_at = case when p_missing then coalesce(object_missing_at, now()) end
   where object_path = any(p_paths) and (object_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update public.training_videos
     set video_missing_at = case when p_missing then coalesce(video_missing_at, now()) end
   where video_source = any(p_paths) and (video_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  update public.training_videos
     set thumbnail_missing_at = case when p_missing then coalesce(thumbnail_missing_at, now()) end
   where thumbnail_source = any(p_paths) and (thumbnail_missing_at is null) = p_missing;
  get diagnostics v_n = row_count; v_total := v_total + v_n;
  return v_total;
end;
$$;
revoke all on function public.storage_mark_object_missing(text[], boolean) from public, anon, authenticated;
grant execute on function public.storage_mark_object_missing(text[], boolean) to service_role;

-- ── Retention: chat transcripts ────────────────────────────────────────────
--
-- Deletes messages older than the cutoff (oldest first, bounded by p_limit),
-- then the chat-kind media ledger rows no remaining message references
-- (their paths come back so the API can delete the bytes), then empty
-- conversations older than the cutoff. Patients with an active deletion
-- request are skipped: that flow owns their data.
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
     and not exists (
       select 1 from public.patient_deletion_requests d
        where d.patient_id = c.patient_id and d.status in ('pending', 'purging', 'failed')
     )
   order by m.created_at
   limit greatest(coalesce(p_limit, 1000), 1);

  select count(*)::integer into v_messages from retention_chat_candidates;

  if p_dry_run then
    select coalesce(array_agg(distinct cand.photo_path), array[]::text[]) into v_paths
      from retention_chat_candidates cand
     where cand.photo_path is not null
       and not exists (
         select 1 from public.patient_chat_messages m2
          where m2.photo->>'path' = cand.photo_path
            and not exists (select 1 from retention_chat_candidates c2
                             where c2.conversation_id = m2.conversation_id and c2.client_id = m2.client_id)
       );
    select count(*)::integer into v_conversations
      from public.patient_chat_conversations c
     where c.updated_at < p_cutoff
       and not exists (select 1 from public.patient_chat_messages m where m.conversation_id = c.id
                          and not exists (select 1 from retention_chat_candidates c2
                                           where c2.conversation_id = m.conversation_id and c2.client_id = m.client_id));
    return query select v_messages, v_conversations, v_paths;
    return;
  end if;

  delete from public.patient_chat_messages m
   using retention_chat_candidates cand
   where m.conversation_id = cand.conversation_id and m.client_id = cand.client_id;

  with removed as (
    delete from public.patient_media pm
     where pm.kind = 'chat'
       and pm.object_path in (select cand.photo_path from retention_chat_candidates cand where cand.photo_path is not null)
       and not exists (select 1 from public.patient_chat_messages m where m.photo->>'path' = pm.object_path)
     returning pm.object_path
  )
  select coalesce(array_agg(object_path), array[]::text[]) into v_paths from removed;

  with gone as (
    delete from public.patient_chat_conversations c
     where c.updated_at < p_cutoff
       and not exists (select 1 from public.patient_chat_messages m where m.conversation_id = c.id)
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
revoke all on function public.retention_trim_chat_transcripts(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_chat_transcripts(timestamptz, integer, boolean) to service_role;

-- ── Retention: notification history ────────────────────────────────────────
--
-- Terminal outbox rows older than the cutoff (attempts cascade). Queued and
-- in-flight rows are never touched regardless of age.
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

create table if not exists public.admin_audit_event_archives (
  period_start date not null,
  action text not null,
  actor_kind text not null,
  target_kind text not null default '',
  provider_id text not null default '',
  event_count bigint not null check (event_count >= 0),
  first_at timestamptz,
  last_at timestamptz,
  archived_at timestamptz not null default now(),
  primary key (period_start, action, actor_kind, target_kind, provider_id)
);
comment on table public.admin_audit_event_archives is
  'Compact monthly summary (count, first/last time) of audit events the retention job removed. Never holds actor ids, targets, request ids, or metadata.';
alter table public.admin_audit_event_archives enable row level security;
revoke all on public.admin_audit_event_archives from public, anon, authenticated;
grant all on public.admin_audit_event_archives to service_role;

-- The append-only guard keeps its analytics detach carve-out and gains one
-- more: deleting admin_audit_events while the retention function has set the
-- transaction-local switch below. Nothing else can update or delete.
create or replace function public.reject_operational_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Nested on purpose: SQL AND does not short-circuit, and old.patient_id
  -- does not exist on admin_audit_events rows.
  if tg_op = 'UPDATE' and tg_table_schema = 'public' and tg_table_name = 'analytics_events' then
    if old.patient_id is not null
       and new.patient_id is null
       and (to_jsonb(new) - 'patient_id') = (to_jsonb(old) - 'patient_id') then
      return new;
    end if;
  elsif tg_op = 'DELETE' and tg_table_schema = 'public' and tg_table_name = 'admin_audit_events' then
    if coalesce(current_setting('app.audit_retention_run', true), '') = 'on' then
      return old;
    end if;
  end if;
  raise exception 'operational event tables are append-only';
end;
$$;
revoke all on function public.reject_operational_event_mutation() from public, anon, authenticated;

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
