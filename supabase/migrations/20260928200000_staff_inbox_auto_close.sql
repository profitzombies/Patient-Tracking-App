-- ============================================================================
-- Staff inbox: honor the organization's conversation auto-close window
-- ============================================================================
--
-- HQ settings carry `conversation_auto_close_days`. The inbox keeps its
-- persisted workflow status (open / waiting_patient / closed, driven by the
-- message trigger and staff actions) but a thread that has been idle past the
-- window is *reported* as closed: it lists under the closed filter, counts as
-- closed in the metrics, and carries `auto_closed = true` so the UI can say
-- why. Nothing is written to the row, so changing the window in HQ settings
-- reclassifies the inbox immediately, and the moment the patient writes again
-- the thread is simply open once more. Callers pass the cutoff instant
-- (now - window); NULL disables the derivation.
--
-- Idle time is measured from the later of the last message (any role) and the
-- row's updated_at, which an explicit staff status change bumps, so a thread a
-- staff member deliberately reopens stays open until the window elapses again.

drop function if exists public.patient_chat_inbox_list(text, uuid, text[], text, text, boolean, text, text, integer, integer, uuid);

create or replace function public.patient_chat_inbox_list(
  p_provider_id text,
  p_staff_user_id uuid,
  p_threads text[] default array['coach', 'support'],
  p_status text default null,
  p_assignee text default null,
  p_unread_only boolean default false,
  p_q text default null,
  p_sort text default 'newest',
  p_limit integer default 50,
  p_offset integer default 0,
  p_conversation_id uuid default null,
  p_auto_close_before timestamptz default null
) returns table (
  id uuid, patient_id uuid, patient_name text, thread text, status text,
  auto_closed boolean,
  assignee_user_id uuid, assignee_label text,
  message_count bigint, last_message_at timestamptz,
  last_patient_message_at timestamptz, last_staff_reply_at timestamptz,
  preview text, unread boolean, note_count bigint,
  open_escalation_id uuid, open_escalation_department text,
  created_at timestamptz, total bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_q text := nullif(trim(coalesce(p_q, '')), '');
  v_like text;
begin
  if p_status is not null and p_status not in ('open', 'waiting_patient', 'closed') then
    raise exception 'invalid status %', p_status;
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  return query
  with base as (
    select c.id, c.patient_id,
      coalesce(nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''), p.name, 'Patient') as patient_name,
      c.thread, c.status as stored_status, c.assignee_user_id, c.assignee_label,
      c.last_patient_message_at, c.last_staff_reply_at, c.created_at, c.updated_at,
      c.awaiting_since,
      (select count(*) from public.patient_chat_messages m where m.conversation_id = c.id) as message_count,
      (select m.created_at from public.patient_chat_messages m
         where m.conversation_id = c.id order by m.seq desc limit 1) as last_message_at,
      (select left(regexp_replace(m.text, '\s+', ' ', 'g'), 160) from public.patient_chat_messages m
         where m.conversation_id = c.id and m.hidden = false and m.text <> ''
         order by m.seq desc limit 1) as preview,
      (coalesce(c.last_patient_seq, 0) > coalesce(rm.last_read_seq, 0)) as unread,
      (select count(*) from public.patient_chat_notes n where n.conversation_id = c.id) as note_count,
      e.id as open_escalation_id, e.department as open_escalation_department
    from public.patient_chat_conversations c
    join public.patients p on p.id = c.patient_id
    left join public.patient_chat_read_markers rm
      on rm.conversation_id = c.id and rm.staff_user_id = p_staff_user_id
    left join public.patient_chat_escalations e
      on e.conversation_id = c.id and e.status = 'open'
    where p.provider_id = p_provider_id
      and (p_conversation_id is null or c.id = p_conversation_id)
      and c.thread = any (p_threads)
      and (
        p_assignee is null
        or (p_assignee = 'unassigned' and c.assignee_user_id is null)
        or (p_assignee <> 'unassigned' and c.assignee_user_id::text = p_assignee)
      )
      and (v_q is null
        or concat_ws(' ', p.first_name, p.last_name, p.name) ilike v_like escape '\'
        or exists (
          select 1 from public.patient_chat_messages m
          where m.conversation_id = c.id and m.text ilike v_like escape '\'
        ))
  ), effective as (
    select b.*,
      (b.stored_status <> 'closed'
        and p_auto_close_before is not null
        and greatest(coalesce(b.last_message_at, b.created_at), b.updated_at) < p_auto_close_before) as auto_closed
    from base b
  ), filtered as (
    select x.*,
      case when x.auto_closed then 'closed' else x.stored_status end as status
    from effective x
    where (not p_unread_only or x.unread)
  )
  select f.id, f.patient_id, f.patient_name, f.thread, f.status,
    f.auto_closed,
    f.assignee_user_id, f.assignee_label,
    f.message_count, f.last_message_at, f.last_patient_message_at, f.last_staff_reply_at,
    coalesce(f.preview, ''), f.unread, f.note_count,
    f.open_escalation_id, f.open_escalation_department,
    f.created_at, count(*) over () as total
  from filtered f
  where (p_status is null or f.status = p_status)
  order by
    case when p_sort = 'unread_first' and f.unread then 0 else 1 end,
    case when p_sort = 'waiting_longest' then coalesce(f.awaiting_since, 'infinity'::timestamptz) end asc,
    case when p_sort = 'oldest' then coalesce(f.last_message_at, f.created_at) end asc,
    coalesce(f.last_message_at, f.created_at) desc,
    f.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.patient_chat_inbox_list(text, uuid, text[], text, text, boolean, text, text, integer, integer, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.patient_chat_inbox_list(text, uuid, text[], text, text, boolean, text, text, integer, integer, uuid, timestamptz)
  to service_role;

-- ── Inbox metrics ───────────────────────────────────────────────────────────

drop function if exists public.patient_chat_inbox_metrics(text);

create or replace function public.patient_chat_inbox_metrics(
  p_provider_id text default null,
  p_auto_close_before timestamptz default null
) returns table (
  open_threads bigint, waiting_threads bigint, closed_threads bigint,
  unanswered_threads bigint, avg_response_minutes numeric, open_escalations bigint
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  return query
  with scoped as (
    select
      case
        when c.status <> 'closed'
          and p_auto_close_before is not null
          and greatest(
            coalesce(
              (select max(m.created_at) from public.patient_chat_messages m where m.conversation_id = c.id),
              c.created_at),
            c.updated_at) < p_auto_close_before
        then 'closed' else c.status end as status,
      c.awaiting_since, c.response_ms_total, c.response_count, c.id
    from public.patient_chat_conversations c
    join public.patients p on p.id = c.patient_id
    join public.providers pr on pr.provider_id = p.provider_id
    where coalesce(pr.access_disabled, false) = false
      and (p_provider_id is null or p.provider_id = p_provider_id)
  )
  select
    count(*) filter (where s.status = 'open'),
    count(*) filter (where s.status = 'waiting_patient'),
    count(*) filter (where s.status = 'closed'),
    count(*) filter (where s.status = 'open' and s.awaiting_since is not null),
    case when coalesce(sum(s.response_count), 0) = 0 then null
      else round(sum(s.response_ms_total)::numeric / sum(s.response_count) / 60000.0, 1) end,
    (select count(*) from public.patient_chat_escalations e
       join scoped sc on sc.id = e.conversation_id where e.status = 'open')
  from scoped s;
end;
$$;

revoke all on function public.patient_chat_inbox_metrics(text, timestamptz) from public, anon, authenticated;
grant execute on function public.patient_chat_inbox_metrics(text, timestamptz) to service_role;
