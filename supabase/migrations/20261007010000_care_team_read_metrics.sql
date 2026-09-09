-- Serialize first-read creation, not only updates of an already-present marker.
-- Use the patient identity lock before the conversation lock, matching send/purge.
create or replace function public.care_team_patient_read(
  p_conversation_id uuid, p_patient_id uuid, p_through_seq bigint
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old bigint; v_new bigint; v_max bigint;
begin
  if p_through_seq is null or p_through_seq < 1 then
    raise exception 'invalid read position';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_patient_id::text, 40421001));
  perform 1 from public.patient_chat_conversations c
    join public.patients p on p.id = c.patient_id
    where c.id = p_conversation_id and c.patient_id = p_patient_id
      and c.thread = 'care_team' and p.archived_at is null
      and p.deletion_requested_at is null
      and p.activation_status is distinct from 'disabled'
    for update of c;
  if not found then raise exception 'conversation unavailable'; end if;
  select coalesce(max(m.seq), 0) into v_max
    from public.patient_chat_messages m where m.conversation_id = p_conversation_id;
  select r.last_read_seq into v_old from public.patient_chat_patient_read_markers r
    where r.conversation_id = p_conversation_id and r.patient_id = p_patient_id;
  v_old := coalesce(v_old, 0);
  v_new := greatest(v_old, least(p_through_seq, v_max));
  if v_new > v_old then
    insert into public.patient_chat_patient_read_markers
      (conversation_id, patient_id, last_read_seq, read_at)
    values (p_conversation_id, p_patient_id, v_new, clock_timestamp())
    on conflict (conversation_id, patient_id) do update
      set last_read_seq = excluded.last_read_seq, read_at = excluded.read_at;
  end if;
  return jsonb_build_object('lastReadSeq', v_new, 'changed', v_new > v_old);
end $$;

create or replace function public.care_team_staff_read(
  p_conversation_id uuid, p_staff_user_id uuid, p_through_seq bigint
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_patient_id uuid; v_old bigint; v_new bigint; v_max bigint;
begin
  if p_through_seq is null or p_through_seq < 1 or p_staff_user_id is null then
    raise exception 'invalid read position';
  end if;
  select c.patient_id into v_patient_id from public.patient_chat_conversations c
    where c.id = p_conversation_id;
  if not found then raise exception 'conversation unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_patient_id::text, 40421001));
  perform 1 from public.patient_chat_conversations c
    join public.patients p on p.id = c.patient_id
    where c.id = p_conversation_id and c.patient_id = v_patient_id
      and p.archived_at is null and p.deletion_requested_at is null
      and p.activation_status is distinct from 'disabled'
    for update of c;
  if not found then raise exception 'conversation unavailable'; end if;
  select coalesce(max(m.seq), 0) into v_max
    from public.patient_chat_messages m where m.conversation_id = p_conversation_id;
  select r.last_read_seq into v_old from public.patient_chat_read_markers r
    where r.conversation_id = p_conversation_id and r.staff_user_id = p_staff_user_id;
  v_old := coalesce(v_old, 0);
  v_new := greatest(v_old, least(p_through_seq, v_max));
  if v_new > v_old then
    insert into public.patient_chat_read_markers
      (conversation_id, staff_user_id, last_read_seq, read_at)
    values (p_conversation_id, p_staff_user_id, v_new, clock_timestamp())
    on conflict (conversation_id, staff_user_id) do update
      set last_read_seq = excluded.last_read_seq, read_at = excluded.read_at;
  end if;
  return jsonb_build_object('lastReadSeq', v_new, 'changed', v_new > v_old);
end $$;

revoke all on function public.care_team_patient_read(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.care_team_staff_read(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.care_team_patient_read(uuid, uuid, bigint) to service_role;
grant execute on function public.care_team_staff_read(uuid, uuid, bigint) to service_role;

-- The same ownership rule must drive the list and its counts/response times.
-- The default retains overview callers; permission-scoped inbox callers pass threads.
drop function if exists public.patient_chat_inbox_metrics(text, timestamptz);
create or replace function public.patient_chat_inbox_metrics(
  p_provider_id text default null,
  p_auto_close_before timestamptz default null,
  p_threads text[] default array['coach', 'support', 'care_team']
) returns table (
  open_threads bigint, waiting_threads bigint, closed_threads bigint,
  unanswered_threads bigint, avg_response_minutes numeric, open_escalations bigint
) language sql stable security definer set search_path = public, pg_temp as $$
  with scoped as (
    select
      case when c.status <> 'closed' and p_auto_close_before is not null
        and greatest(coalesce(
          (select max(m.created_at) from public.patient_chat_messages m
            where m.conversation_id = c.id), c.created_at), c.updated_at) < p_auto_close_before
        then 'closed' else c.status end as status,
      c.awaiting_since, c.response_ms_total, c.response_count, c.id, c.thread
    from public.patient_chat_conversations c
    join public.patients p on p.id = c.patient_id
    join public.providers pr on pr.provider_id =
      case when c.thread = 'care_team' then c.provider_id else p.provider_id end
    where not coalesce(pr.access_disabled, false)
      and not private.provider_account_is_locked(pr.provider_id)
      and p.archived_at is null and p.deletion_requested_at is null
      and p.activation_status is distinct from 'disabled'
      and c.thread = any(p_threads)
      and (p_provider_id is null or pr.provider_id = p_provider_id)
  )
  select
    count(*) filter (where s.status = 'open'),
    count(*) filter (where s.status = 'waiting_patient'),
    count(*) filter (where s.status = 'closed'),
    count(*) filter (where s.status = 'open' and s.awaiting_since is not null),
    case when coalesce(sum(s.response_count), 0) = 0 then null
      else round(sum(s.response_ms_total)::numeric / sum(s.response_count) / 60000.0, 1) end,
    (select count(*) from public.patient_chat_escalations e
      join scoped sc on sc.id = e.conversation_id
      where e.status = 'open' and sc.thread <> 'care_team')
  from scoped s;
$$;

revoke all on function public.patient_chat_inbox_metrics(text, timestamptz, text[])
  from public, anon, authenticated;
grant execute on function public.patient_chat_inbox_metrics(text, timestamptz, text[])
  to service_role;

-- These entry points call private helpers. Definer execution preserves the
-- private schema boundary without granting service_role direct helper access.
-- Their fixed search_path and service-only grants are set by the base migration.
alter function public.care_team_start(uuid, text) security definer;
alter function public.care_team_send(uuid, uuid, text, text, text, text, uuid, text, boolean)
  security definer;
alter function public.care_team_patient_bootstrap(uuid) security definer;
alter function public.patient_chat_inbox_list(
  text, uuid, text[], text, text, boolean, text, text, integer, integer, uuid, timestamptz, uuid
) security definer;