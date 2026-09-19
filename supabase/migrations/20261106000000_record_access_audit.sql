-- Record-access audit: staff and HQ reads of patient records write "viewed"
-- audit events, collapsed per actor + target inside a dedupe window so a
-- scrolling chart never floods the ledger. The window ledger is the
-- cross-instance source of truth (API processes only keep a short-circuit
-- cache); the audit row itself lands in admin_audit_events exactly like a
-- write event, so retention archival and compaction apply unchanged.

create table if not exists public.admin_audit_read_windows (
  actor_user_id uuid not null,
  dedupe_key text not null,
  window_started_at timestamptz not null default now(),
  primary key (actor_user_id, dedupe_key)
);
comment on table public.admin_audit_read_windows is
  'Open dedupe windows for record-access audit events (actor + target). Rows older than the window are inert and swept by the retention job.';
alter table public.admin_audit_read_windows enable row level security;
revoke all on table public.admin_audit_read_windows from public, anon, authenticated;
grant select, insert, update, delete on table public.admin_audit_read_windows to service_role;
create index if not exists admin_audit_read_windows_started_idx on public.admin_audit_read_windows (window_started_at);

-- One call = one atomic decision: open (or re-open) the actor's window for
-- this target and, only when it was opened, append the audit event. The
-- conditional upsert serialises concurrent first reads on the primary key,
-- so two API instances racing on the same target write one event.
create or replace function public.record_admin_audit_read_event(
  p_action text, p_actor_user_id uuid, p_actor_kind text, p_provider_id text,
  p_target_kind text, p_target_id text, p_request_id text, p_metadata jsonb,
  p_dedupe_key text, p_window_seconds integer default 900
) returns table(recorded boolean, window_started_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  v_window interval := make_interval(secs => greatest(coalesce(p_window_seconds, 900), 1));
  v_started timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_actor_user_id is null then raise exception 'record access needs an actor'; end if;
  if coalesce(p_dedupe_key, '') = '' then raise exception 'record access needs a dedupe key'; end if;
  if coalesce(p_action, '') = '' then raise exception 'record access needs an action'; end if;

  insert into admin_audit_read_windows as w (actor_user_id, dedupe_key, window_started_at)
  values (p_actor_user_id, p_dedupe_key, now())
  on conflict (actor_user_id, dedupe_key) do update
    set window_started_at = excluded.window_started_at
    where w.window_started_at <= excluded.window_started_at - v_window
  returning w.window_started_at into v_started;

  if v_started is null then
    select w.window_started_at into v_started
      from admin_audit_read_windows w
     where w.actor_user_id = p_actor_user_id and w.dedupe_key = p_dedupe_key;
    return query select false, v_started;
    return;
  end if;

  insert into admin_audit_events(action, actor_user_id, actor_kind, provider_id, target_kind, target_id, request_id, metadata)
  values (p_action, p_actor_user_id, p_actor_kind, p_provider_id, p_target_kind, p_target_id, p_request_id, coalesce(p_metadata, '{}'::jsonb));
  return query select true, v_started;
end;
$$;
revoke all on function public.record_admin_audit_read_event(text, uuid, text, text, text, text, text, jsonb, text, integer) from public, anon, authenticated;
grant execute on function public.record_admin_audit_read_event(text, uuid, text, text, text, text, text, jsonb, text, integer) to service_role;

-- Windows are only meaningful for their length; anything older is dead weight.
-- Ridden by the audit retention job after the archive pass.
create or replace function public.retention_trim_audit_read_windows(
  p_cutoff timestamptz, p_limit integer, p_dry_run boolean
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_dry_run then
    select count(*)::integer into v_count from (
      select 1 from admin_audit_read_windows where window_started_at < p_cutoff limit greatest(coalesce(p_limit, 1), 1)
    ) due;
    return v_count;
  end if;
  with victims as (
    select actor_user_id, dedupe_key from admin_audit_read_windows
     where window_started_at < p_cutoff
     order by window_started_at asc
     limit greatest(coalesce(p_limit, 1), 1)
     for update skip locked
  ), deleted as (
    delete from admin_audit_read_windows w
     using victims v
     where w.actor_user_id = v.actor_user_id and w.dedupe_key = v.dedupe_key
       and not p_dry_run
    returning 1
  )
  select count(*)::integer into v_count from deleted;
  return v_count;
end;
$$;
revoke all on function public.retention_trim_audit_read_windows(timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.retention_trim_audit_read_windows(timestamptz, integer, boolean) to service_role;
