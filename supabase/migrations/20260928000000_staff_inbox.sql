-- Staff inbox: conversation workflow state, care-team replies, read markers,
-- internal notes, and HQ escalations on top of the persisted patient chat.
--
-- Everything here is service-role only, like the chat tables it extends:
-- RLS enabled with no anon/authenticated policies, EXECUTE revoked from
-- anon/authenticated on every function. The API server enforces office scope
-- and the HQ clinical/support permission split before touching any of it.
--
-- Workflow rules (kept in ONE trigger so the mobile append path, the coach
-- outreach seeder, and the staff reply path all agree):
--   * a new patient ('user') message stamps last_patient_message_at and
--     last_patient_seq, opens an "awaiting reply" stretch if none is open,
--     and flips waiting_patient / closed back to open;
--   * a new care-team ('staff') message stamps last_staff_reply_at, closes
--     the awaiting stretch into the response-time accumulators, and moves
--     open / closed to waiting_patient;
--   * assistant (coach AI) messages never change workflow state.
-- Row-level INSERT triggers do not fire for the UPDATE half of an
-- ON CONFLICT DO UPDATE, so patient_chat_apply's re-upserts (card updates,
-- outbox retries) never double-count.
--
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / idempotent backfills.

-- ── Conversation workflow columns ───────────────────────────────────────────

alter table public.patient_chat_conversations
  add column if not exists status text not null default 'open',
  add column if not exists assignee_user_id uuid,
  add column if not exists assignee_label text,
  add column if not exists last_patient_message_at timestamptz,
  add column if not exists last_patient_seq bigint,
  add column if not exists last_staff_reply_at timestamptz,
  add column if not exists awaiting_since timestamptz,
  add column if not exists response_ms_total bigint not null default 0,
  add column if not exists response_count integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_chat_conversations'::regclass
      and conname = 'patient_chat_conversations_status_check'
  ) then
    alter table public.patient_chat_conversations
      add constraint patient_chat_conversations_status_check
      check (status in ('open', 'waiting_patient', 'closed'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_chat_conversations'::regclass
      and conname = 'patient_chat_conversations_assignee_label_check'
  ) then
    alter table public.patient_chat_conversations
      add constraint patient_chat_conversations_assignee_label_check
      check (assignee_label is null or char_length(assignee_label) <= 120);
  end if;
end $$;

comment on column public.patient_chat_conversations.status is
  'Staff workflow state: open (needs care-team attention), waiting_patient (care team replied, ball is with the patient), closed.';
comment on column public.patient_chat_conversations.awaiting_since is
  'Start of the current unanswered stretch (first patient message since the last care-team reply); null once staff reply.';

create index if not exists patient_chat_conversations_workflow_idx
  on public.patient_chat_conversations (status, updated_at desc);

-- ── Messages: care-team role + sender ───────────────────────────────────────

alter table public.patient_chat_messages
  add column if not exists sender_user_id uuid,
  add column if not exists sender_label text;

alter table public.patient_chat_messages
  drop constraint if exists patient_chat_messages_role_check;
alter table public.patient_chat_messages
  add constraint patient_chat_messages_role_check
  check (role in ('user', 'assistant', 'staff'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_chat_messages'::regclass
      and conname = 'patient_chat_messages_sender_label_check'
  ) then
    alter table public.patient_chat_messages
      add constraint patient_chat_messages_sender_label_check
      check (sender_label is null or char_length(sender_label) <= 120);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patient_chat_messages'::regclass
      and conname = 'patient_chat_messages_staff_sender_check'
  ) then
    alter table public.patient_chat_messages
      add constraint patient_chat_messages_staff_sender_check
      check (role <> 'staff' or (sender_user_id is not null and sender_label is not null));
  end if;
end $$;

comment on column public.patient_chat_messages.sender_label is
  'Staff messages only: the care-team display name shown to the patient (snapshot at send time).';

-- ── Read markers / notes / escalations ──────────────────────────────────────

create table if not exists public.patient_chat_read_markers (
  conversation_id uuid not null
    references public.patient_chat_conversations(id) on delete cascade,
  staff_user_id uuid not null,
  last_read_seq bigint not null default 0,
  read_at timestamptz not null default now(),
  primary key (conversation_id, staff_user_id)
);
comment on table public.patient_chat_read_markers is
  'Per-staff-member high-water mark of the transcript they have opened. Service-role only.';
alter table public.patient_chat_read_markers enable row level security;
revoke all on public.patient_chat_read_markers from anon, authenticated;

create table if not exists public.patient_chat_notes (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.patient_chat_conversations(id) on delete cascade,
  provider_id text not null references public.providers(provider_id) on delete cascade,
  author_user_id uuid not null,
  author_label text not null check (char_length(author_label) between 1 and 120),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
comment on table public.patient_chat_notes is
  'Internal care-team notes on a conversation. Never returned by any patient-facing route. Service-role only.';
create index if not exists patient_chat_notes_by_conversation
  on public.patient_chat_notes (conversation_id, created_at);
alter table public.patient_chat_notes enable row level security;
revoke all on public.patient_chat_notes from anon, authenticated;

create table if not exists public.patient_chat_escalations (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null
    references public.patient_chat_conversations(id) on delete cascade,
  provider_id text not null references public.providers(provider_id) on delete cascade,
  department text not null check (department in ('clinical', 'support')),
  reason text not null check (char_length(reason) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by uuid not null,
  created_by_label text not null check (char_length(created_by_label) between 1 and 120),
  created_at timestamptz not null default now(),
  resolved_by uuid,
  resolved_by_label text check (resolved_by_label is null or char_length(resolved_by_label) <= 120),
  resolved_at timestamptz,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 2000)
);
comment on table public.patient_chat_escalations is
  'Office → HQ escalations of a patient conversation, routed by department (clinical = coach thread permission, support = support permission). Service-role only.';
create unique index if not exists patient_chat_escalations_one_open
  on public.patient_chat_escalations (conversation_id) where status = 'open';
create index if not exists patient_chat_escalations_queue_idx
  on public.patient_chat_escalations (status, department, created_at desc);
alter table public.patient_chat_escalations enable row level security;
revoke all on public.patient_chat_escalations from anon, authenticated;

-- ── Workflow trigger ────────────────────────────────────────────────────────

create or replace function public.patient_chat_message_workflow()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.role = 'user' then
    update public.patient_chat_conversations set
      last_patient_message_at = new.created_at,
      last_patient_seq = greatest(coalesce(last_patient_seq, 0), new.seq),
      awaiting_since = coalesce(awaiting_since, new.created_at),
      status = case when status in ('waiting_patient', 'closed') then 'open' else status end,
      updated_at = greatest(updated_at, new.created_at)
    where id = new.conversation_id;
  elsif new.role = 'staff' then
    update public.patient_chat_conversations set
      last_staff_reply_at = new.created_at,
      response_ms_total = response_ms_total + case
        when awaiting_since is not null
          then greatest(0, floor(extract(epoch from (new.created_at - awaiting_since)) * 1000))::bigint
        else 0 end,
      response_count = response_count + case when awaiting_since is not null then 1 else 0 end,
      awaiting_since = null,
      status = case when status in ('open', 'closed') then 'waiting_patient' else status end,
      updated_at = greatest(updated_at, new.created_at)
    where id = new.conversation_id;
  end if;
  return null;
end;
$$;

drop trigger if exists patient_chat_message_workflow on public.patient_chat_messages;
create trigger patient_chat_message_workflow
  after insert on public.patient_chat_messages
  for each row execute function public.patient_chat_message_workflow();

-- Backfill workflow facts for transcripts persisted before this migration.
update public.patient_chat_conversations c set
  last_patient_message_at = s.last_at,
  last_patient_seq = s.last_seq,
  awaiting_since = coalesce(c.awaiting_since, s.last_at)
from (
  select conversation_id, max(created_at) last_at, max(seq) last_seq
  from public.patient_chat_messages where role = 'user'
  group by conversation_id
) s
where s.conversation_id = c.id and c.last_patient_seq is null;

-- ── Inbox list ──────────────────────────────────────────────────────────────
--
-- One query for the filtered, sorted, searched office inbox with per-caller
-- unread state and a window total; p_conversation_id narrows it to a single
-- thread so detail routes build the same summary shape (and inherit the
-- office scoping) without a second code path. Search matches the patient's name or any
-- message text (case-insensitive substring, scanned per office; office
-- transcripts are small enough that no trigram index is needed yet).

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
  p_conversation_id uuid default null
) returns table (
  id uuid, patient_id uuid, patient_name text, thread text, status text,
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
      c.thread, c.status, c.assignee_user_id, c.assignee_label,
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
      and (p_status is null or c.status = p_status)
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
  ), filtered as (
    select * from base b where not p_unread_only or b.unread
  )
  select f.id, f.patient_id, f.patient_name, f.thread, f.status,
    f.assignee_user_id, f.assignee_label,
    f.message_count, f.last_message_at, f.last_patient_message_at, f.last_staff_reply_at,
    coalesce(f.preview, ''), f.unread, f.note_count,
    f.open_escalation_id, f.open_escalation_department,
    f.created_at, count(*) over () as total
  from filtered f
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

revoke all on function public.patient_chat_inbox_list(text, uuid, text[], text, text, boolean, text, text, integer, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.patient_chat_inbox_list(text, uuid, text[], text, text, boolean, text, text, integer, integer, uuid)
  to service_role;

-- ── Inbox metrics ───────────────────────────────────────────────────────────
--
-- Office header strip and the operational rollups. NULL provider = every
-- enabled office (HQ). "Unanswered" = open threads whose latest patient
-- message has had no care-team reply; response time averages the closed
-- awaiting stretches accumulated by the trigger.

create or replace function public.patient_chat_inbox_metrics(
  p_provider_id text default null
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
    select c.status, c.awaiting_since, c.response_ms_total, c.response_count, c.id
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

revoke all on function public.patient_chat_inbox_metrics(text) from public, anon, authenticated;
grant execute on function public.patient_chat_inbox_metrics(text) to service_role;
