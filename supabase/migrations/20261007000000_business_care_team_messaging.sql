-- Business care-team messaging. Reuses patient_chat_* storage while keeping
-- human conversations distinct from AI and permanently bound to an office.

alter table public.patient_chat_conversations add column if not exists provider_id text
  references public.providers(provider_id) on delete restrict;

update public.patient_chat_conversations c
set provider_id = p.provider_id
from public.patients p
where p.id = c.patient_id and c.provider_id is null;

alter table public.patient_chat_conversations
  drop constraint if exists patient_chat_conversations_thread_check;
alter table public.patient_chat_conversations
  add constraint patient_chat_conversations_thread_check
  check (thread in ('coach', 'support', 'care_team'));
alter table public.patient_chat_conversations alter column provider_id set not null;

-- The old all-thread key would prevent retained care-team history after a
-- transfer. Preserve the exact AI invariant and add patient/business human uniqueness.
alter table public.patient_chat_conversations
  drop constraint if exists patient_chat_conversations_patient_id_thread_key;
create unique index if not exists patient_chat_conversations_ai_unique
  on public.patient_chat_conversations(patient_id, thread)
  where thread in ('coach', 'support');
create unique index if not exists patient_chat_conversations_care_team_unique
  on public.patient_chat_conversations(patient_id, provider_id)
  where thread = 'care_team';

create or replace function private.care_team_conversation_ownership_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.thread = 'care_team'
      and new.provider_id is distinct from old.provider_id then
    raise exception 'conversation provider ownership is immutable';
  end if;
  if new.provider_id is null then
    select p.provider_id into new.provider_id from public.patients p where p.id = new.patient_id;
  end if;
  if new.provider_id is null then raise exception 'conversation provider is required'; end if;
  if tg_op = 'INSERT' and new.thread = 'care_team' and not exists(select 1 from public.patients p
      where p.id=new.patient_id and p.provider_id=new.provider_id) then
    raise exception 'conversation provider must match patient office';
  end if;
  return new;
end $$;
revoke all on function private.care_team_conversation_ownership_guard()
  from public,anon,authenticated;
drop trigger if exists care_team_conversation_ownership_guard on public.patient_chat_conversations;
create trigger care_team_conversation_ownership_guard
  before insert or update of provider_id,patient_id on public.patient_chat_conversations
  for each row execute function private.care_team_conversation_ownership_guard();

-- Cross-table role enforcement belongs in a trigger (CHECK cannot query).
alter table public.patient_chat_messages
  drop constraint if exists patient_chat_messages_care_team_human_only;
create or replace function private.care_team_message_role_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_thread text;
begin
  select thread into v_thread from public.patient_chat_conversations where id = new.conversation_id;
  if v_thread = 'care_team' and new.role not in ('user', 'staff') then
    raise exception 'care-team conversations are human only';
  end if;
  return new;
end $$;
revoke all on function private.care_team_message_role_guard()
  from public,anon,authenticated;
drop trigger if exists care_team_message_role_guard on public.patient_chat_messages;
create trigger care_team_message_role_guard before insert or update of role, conversation_id
  on public.patient_chat_messages for each row execute function private.care_team_message_role_guard();

-- The original AI apply named the former full unique constraint. Point conflict
-- inference at the equivalent partial AI index; payload/update semantics stay unchanged.
create or replace function public.patient_chat_apply(
  p_patient_id uuid,p_thread text,p_messages jsonb default '[]'::jsonb
) returns void language plpgsql set search_path=public,pg_temp as $$
declare v_conversation_id uuid;
begin
 if p_thread not in ('coach','support') then raise exception 'invalid thread %',p_thread; end if;
 insert into public.patient_chat_conversations(patient_id,thread)
 values(p_patient_id,p_thread)
 on conflict(patient_id,thread) where thread in ('coach','support')
 do update set updated_at=clock_timestamp() returning id into v_conversation_id;
 insert into public.patient_chat_messages
  (conversation_id,client_id,role,text,stopped,hidden,card,quick_replies,
   reply_to_client_id,photo,created_at,updated_at)
 select v_conversation_id,r.client_id,r.role,coalesce(r.text,''),coalesce(r.stopped,false),
  coalesce(r.hidden,false),r.card,r.quick_replies,r.reply_to_client_id,r.photo,
  clock_timestamp(),clock_timestamp()
 from jsonb_to_recordset(coalesce(p_messages,'[]'::jsonb)) as r(
  client_id text,role text,text text,stopped boolean,hidden boolean,card jsonb,
  quick_replies jsonb,reply_to_client_id text,photo jsonb)
 on conflict(conversation_id,client_id) do update set text=excluded.text,
  stopped=excluded.stopped,hidden=excluded.hidden,card=excluded.card,
  quick_replies=excluded.quick_replies,reply_to_client_id=excluded.reply_to_client_id,
  photo=excluded.photo,updated_at=clock_timestamp();
end $$;
revoke all on function public.patient_chat_apply(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.patient_chat_apply(uuid,text,jsonb) to service_role;

create table if not exists public.patient_chat_patient_read_markers (
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  last_read_seq bigint not null default 0 check(last_read_seq >= 0),
  read_at timestamptz not null default now(),
  primary key(conversation_id, patient_id)
);
alter table public.patient_chat_patient_read_markers enable row level security;
revoke all on public.patient_chat_patient_read_markers from public, anon, authenticated;

create or replace function private.assert_care_team_patient_writable(p_patient_id uuid, p_provider_id text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare v_patient public.patients%rowtype; v_disabled boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_patient_id::text, 40421001));
  perform pg_advisory_xact_lock(hashtextextended('care-team-office:'||p_provider_id, 0));
  select * into v_patient from public.patients where id=p_patient_id for update;
  if not found or v_patient.archived_at is not null
     or v_patient.deletion_requested_at is not null
     or v_patient.activation_status = 'disabled' then
    raise exception 'patient unavailable';
  end if;
  if v_patient.provider_id is distinct from p_provider_id then raise exception 'patient office mismatch'; end if;
  select coalesce(access_disabled,false) into v_disabled from public.providers
    where provider_id=p_provider_id for share;
  if not found or v_disabled then raise exception 'office unavailable'; end if;
  if private.provider_account_is_locked(p_provider_id) then raise exception 'office locked'; end if;
  if not exists(select 1 from public.patient_consents
    where patient_id=p_patient_id and policy_version='2026-09-01'
      and terms_accepted and privacy_accepted and health_data_accepted)
    then raise exception 'consent required'; end if;
end $$;
revoke all on function private.assert_care_team_patient_writable(uuid,text)
  from public,anon,authenticated;

create or replace function private.care_team_office_lock_serialization()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('care-team-office:'||
   regexp_replace(case when tg_op='DELETE' then old.account_id else new.account_id end,'^acct-',''),0));
 return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function private.care_team_office_lock_serialization()
  from public,anon,authenticated;
drop trigger if exists care_team_office_lock_serialization on public.provider_account_locks;
create trigger care_team_office_lock_serialization before insert or delete
 on public.provider_account_locks for each row execute function private.care_team_office_lock_serialization();

create or replace function private.care_team_patient_marker_ownership()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from public.patient_chat_conversations c
   where c.id=new.conversation_id and c.patient_id=new.patient_id and c.thread='care_team')
 then raise exception 'patient read marker ownership mismatch'; end if;
 return new;
end $$;
revoke all on function private.care_team_patient_marker_ownership()
  from public,anon,authenticated;
drop trigger if exists care_team_patient_marker_ownership on public.patient_chat_patient_read_markers;
create trigger care_team_patient_marker_ownership before insert or update
 on public.patient_chat_patient_read_markers for each row
 execute function private.care_team_patient_marker_ownership();

create or replace function public.care_team_start(p_patient_id uuid, p_provider_id text)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_id uuid; v_created boolean;
begin
  perform private.assert_care_team_patient_writable(p_patient_id,p_provider_id);
  insert into public.patient_chat_conversations(patient_id,provider_id,thread)
    values(p_patient_id,p_provider_id,'care_team')
    on conflict (patient_id,provider_id) where thread='care_team'
    do nothing returning id into v_id;
  v_created := v_id is not null;
  if v_id is null then select id into v_id from public.patient_chat_conversations
    where patient_id=p_patient_id and provider_id=p_provider_id and thread='care_team'; end if;
  return jsonb_build_object('conversationId',v_id,'created',v_created);
end $$;

create or replace function public.care_team_send(
  p_conversation_id uuid, p_patient_id uuid, p_provider_id text,
  p_client_id text, p_text text, p_role text, p_sender_user_id uuid default null,
  p_sender_label text default null, p_enqueue_push boolean default false
) returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_c public.patient_chat_conversations%rowtype; v_m public.patient_chat_messages%rowtype;
  v_created boolean := false;
begin
  perform private.assert_care_team_patient_writable(p_patient_id,p_provider_id);
  select * into v_c from public.patient_chat_conversations where id=p_conversation_id for update;
  if not found or v_c.thread<>'care_team' or v_c.patient_id<>p_patient_id or v_c.provider_id<>p_provider_id
    then raise exception 'conversation unavailable'; end if;
  if p_role not in ('user','staff') or (p_role='user' and p_sender_user_id is not null)
     or (p_role='staff' and (p_sender_user_id is null or nullif(trim(p_sender_label),'') is null))
    then raise exception 'invalid sender'; end if;
  if p_role='staff' and not (
    exists(select 1 from public.providers pr where pr.provider_id=p_provider_id
      and pr.auth_user_id=p_sender_user_id for share)
    or exists(select 1 from public.team_members tm where tm.provider_id=p_provider_id
      and tm.auth_user_id=p_sender_user_id and tm.activation_status is distinct from 'disabled' for share)
  ) then raise exception 'staff unavailable'; end if;
  select * into v_m from public.patient_chat_messages
    where conversation_id=p_conversation_id and client_id=p_client_id;
  if found then
    if v_m.text is distinct from p_text or v_m.role is distinct from p_role
      then raise exception using errcode='23505', message='client id payload conflict'; end if;
  else
    insert into public.patient_chat_messages
      (conversation_id,client_id,role,text,sender_user_id,sender_label)
      values(p_conversation_id,p_client_id,p_role,p_text,p_sender_user_id,p_sender_label)
      returning * into v_m;
    v_created := true;
    if p_enqueue_push and p_role='staff' then
      insert into public.patient_notifications
        (patient_id,kind,category,title,body,data,dedupe_key)
      values (p_patient_id,'care_team_reply','office_reminders',
        'A message from your care team','You have a new care team message.',
        jsonb_build_object('patientId',p_patient_id,'thread','care_team',
          'conversationId',p_conversation_id,'providerId',p_provider_id),
        'care_team_reply:'||p_conversation_id::text||':'||p_client_id)
      on conflict(dedupe_key) do nothing;
    end if;
  end if;
  return jsonb_build_object('created',v_created,'seq',v_m.seq,'clientId',v_m.client_id,
    'role',v_m.role,'text',v_m.text,'createdAt',v_m.created_at);
end $$;

create or replace function public.care_team_patient_read(
 p_conversation_id uuid,p_patient_id uuid,p_through_seq bigint)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare v_old bigint; v_new bigint;
begin
 if not exists(select 1 from public.patient_chat_conversations
   where id=p_conversation_id and patient_id=p_patient_id and thread='care_team')
 then raise exception 'conversation unavailable'; end if;
 select last_read_seq into v_old from public.patient_chat_patient_read_markers
   where conversation_id=p_conversation_id and patient_id=p_patient_id for update;
 v_old:=coalesce(v_old,0);
 v_new:=greatest(v_old,p_through_seq);
 insert into public.patient_chat_patient_read_markers(conversation_id,patient_id,last_read_seq,read_at)
 values(p_conversation_id,p_patient_id,v_new,clock_timestamp())
 on conflict(conversation_id,patient_id) do update set last_read_seq=excluded.last_read_seq,
   read_at=case when excluded.last_read_seq>patient_chat_patient_read_markers.last_read_seq
     then excluded.read_at else patient_chat_patient_read_markers.read_at end;
 return jsonb_build_object('lastReadSeq',v_new,'changed',v_new>v_old);
end $$;

create or replace function public.care_team_patient_bootstrap(p_patient_id uuid)
returns table(id uuid,patient_id uuid,provider_id text,office_name text,status text,
 last_seq bigint,last_staff_seq bigint,last_read_seq bigint,unread_count bigint,
 office_available boolean,created_at timestamptz,updated_at timestamptz)
language sql stable set search_path=public,pg_temp as $$
 select c.id,c.patient_id,c.provider_id,
  coalesce(nullif(pr.office_name,''),nullif(pr.provider_name,''),'Care Team'),
  c.status,coalesce((select max(m.seq) from public.patient_chat_messages m where m.conversation_id=c.id),0),
  coalesce((select max(m.seq) from public.patient_chat_messages m where m.conversation_id=c.id and m.role='staff'),0),
  coalesce(r.last_read_seq,0),
  (select count(*) from public.patient_chat_messages m
    where m.conversation_id=c.id and m.role='staff' and m.seq>coalesce(r.last_read_seq,0)),
  (not coalesce(pr.access_disabled,false) and not private.provider_account_is_locked(c.provider_id)),
  c.created_at,c.updated_at
 from public.patient_chat_conversations c
 join public.providers pr on pr.provider_id=c.provider_id
 left join public.patient_chat_patient_read_markers r
   on r.conversation_id=c.id and r.patient_id=p_patient_id
 where c.patient_id=p_patient_id and c.thread='care_team'
 order by c.updated_at desc
$$;

create or replace function public.care_team_staff_read(
 p_conversation_id uuid,p_staff_user_id uuid,p_through_seq bigint)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare v_old bigint; v_new bigint;
begin
 select last_read_seq into v_old from public.patient_chat_read_markers
   where conversation_id=p_conversation_id and staff_user_id=p_staff_user_id for update;
 v_old:=coalesce(v_old,0); v_new:=greatest(v_old,p_through_seq);
 insert into public.patient_chat_read_markers(conversation_id,staff_user_id,last_read_seq,read_at)
 values(p_conversation_id,p_staff_user_id,v_new,clock_timestamp())
 on conflict(conversation_id,staff_user_id) do update set last_read_seq=excluded.last_read_seq,
   read_at=case when excluded.last_read_seq>patient_chat_read_markers.last_read_seq
     then excluded.read_at else patient_chat_read_markers.read_at end;
 return jsonb_build_object('lastReadSeq',v_new,'changed',v_new>v_old);
end $$;

revoke all on function public.care_team_start(uuid,text) from public,anon,authenticated;
revoke all on function public.care_team_send(uuid,uuid,text,text,text,text,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.care_team_patient_read(uuid,uuid,bigint) from public,anon,authenticated;
revoke all on function public.care_team_staff_read(uuid,uuid,bigint) from public,anon,authenticated;
revoke all on function public.care_team_patient_bootstrap(uuid) from public,anon,authenticated;
grant execute on function public.care_team_start(uuid,text) to service_role;
grant execute on function public.care_team_send(uuid,uuid,text,text,text,text,uuid,text,boolean) to service_role;
grant execute on function public.care_team_patient_read(uuid,uuid,bigint) to service_role;
grant execute on function public.care_team_staff_read(uuid,uuid,bigint) to service_role;
grant execute on function public.care_team_patient_bootstrap(uuid) to service_role;

select private.install_patient_identity_write_guards();

-- Scope retained human transcripts by their immutable owner. AI remains
-- scoped by the patient's current office exactly as before.
drop function if exists public.patient_chat_inbox_list(
  text,uuid,text[],text,text,boolean,text,text,integer,integer,uuid,timestamptz);
create function public.patient_chat_inbox_list(
  p_provider_id text, p_staff_user_id uuid,
  p_threads text[] default array['coach','support','care_team'],
  p_status text default null, p_assignee text default null,
  p_unread_only boolean default false, p_q text default null,
  p_sort text default 'newest', p_limit integer default 50,
  p_offset integer default 0, p_conversation_id uuid default null,
  p_auto_close_before timestamptz default null,p_patient_id uuid default null
) returns table (
  id uuid, patient_id uuid, patient_name text, thread text, status text,
  auto_closed boolean, assignee_user_id uuid, assignee_label text,
  message_count bigint, last_message_at timestamptz,
  last_patient_message_at timestamptz, last_staff_reply_at timestamptz,
  preview text, unread boolean, note_count bigint,
  open_escalation_id uuid, open_escalation_department text,
  created_at timestamptz, total bigint
) language plpgsql stable set search_path=public,pg_temp as $$
declare v_q text:=nullif(trim(coalesce(p_q,'')),''); v_like text;
begin
 if p_status is not null and p_status not in ('open','waiting_patient','closed')
   then raise exception 'invalid status %',p_status; end if;
 if v_q is not null then
   v_like:='%'||replace(replace(replace(v_q,'\','\\'),'%','\%'),'_','\_')||'%';
 end if;
 return query
 with base as (
  select c.id,c.patient_id,
   coalesce(nullif(trim(concat_ws(' ',p.first_name,p.last_name)),''),p.name,'Patient') patient_name,
   c.thread,c.status stored_status,c.assignee_user_id,c.assignee_label,
   c.last_patient_message_at,c.last_staff_reply_at,c.created_at,c.updated_at,c.awaiting_since,
   (select count(*) from public.patient_chat_messages m where m.conversation_id=c.id) message_count,
   (select m.created_at from public.patient_chat_messages m where m.conversation_id=c.id order by m.seq desc limit 1) last_message_at,
   (select left(regexp_replace(m.text,'\s+',' ','g'),160) from public.patient_chat_messages m
     where m.conversation_id=c.id and not m.hidden and m.text<>'' order by m.seq desc limit 1) preview,
   (coalesce(c.last_patient_seq,0)>coalesce(rm.last_read_seq,0)) unread,
   (select count(*) from public.patient_chat_notes n where n.conversation_id=c.id) note_count,
   e.id open_escalation_id,e.department open_escalation_department
  from public.patient_chat_conversations c join public.patients p on p.id=c.patient_id
  join public.providers scoped_pr on scoped_pr.provider_id =
    case when c.thread='care_team' then c.provider_id else p.provider_id end
  left join public.patient_chat_read_markers rm on rm.conversation_id=c.id and rm.staff_user_id=p_staff_user_id
  left join public.patient_chat_escalations e on e.conversation_id=c.id and e.status='open'
  where not coalesce(scoped_pr.access_disabled,false) and (p_provider_id is null or
      (c.thread='care_team' and c.provider_id=p_provider_id)
      or (c.thread<>'care_team' and p.provider_id=p_provider_id))
    and (p_conversation_id is null or c.id=p_conversation_id)
    and (p_patient_id is null or c.patient_id=p_patient_id)
    and c.thread=any(p_threads)
    and (p_assignee is null or (p_assignee='unassigned' and c.assignee_user_id is null)
      or (p_assignee<>'unassigned' and c.assignee_user_id::text=p_assignee))
    and (v_q is null or concat_ws(' ',p.first_name,p.last_name,p.name) ilike v_like escape '\'
      or exists(select 1 from public.patient_chat_messages m where m.conversation_id=c.id and m.text ilike v_like escape '\'))
 ), effective as (
  select b.*,(b.stored_status<>'closed' and p_auto_close_before is not null
    and greatest(coalesce(b.last_message_at,b.created_at),b.updated_at)<p_auto_close_before) auto_closed from base b
 ), filtered as (
  select x.*,case when x.auto_closed then 'closed' else x.stored_status end status
  from effective x where not p_unread_only or x.unread
 )
 select f.id,f.patient_id,f.patient_name,f.thread,f.status,f.auto_closed,
  f.assignee_user_id,f.assignee_label,f.message_count,f.last_message_at,
  f.last_patient_message_at,f.last_staff_reply_at,coalesce(f.preview,''),f.unread,
  f.note_count,f.open_escalation_id,f.open_escalation_department,f.created_at,count(*) over()
 from filtered f where p_status is null or f.status=p_status
 order by case when p_sort='unread_first' and f.unread then 0 else 1 end,
  case when p_sort='waiting_longest' then coalesce(f.awaiting_since,'infinity'::timestamptz) end,
  case when p_sort='oldest' then coalesce(f.last_message_at,f.created_at) end,
  coalesce(f.last_message_at,f.created_at) desc,f.id desc
 limit greatest(1,least(coalesce(p_limit,50),100)) offset greatest(0,coalesce(p_offset,0));
end $$;
revoke all on function public.patient_chat_inbox_list(
 text,uuid,text[],text,text,boolean,text,text,integer,integer,uuid,timestamptz,uuid)
 from public,anon,authenticated;
grant execute on function public.patient_chat_inbox_list(
 text,uuid,text[],text,text,boolean,text,text,integer,integer,uuid,timestamptz,uuid)
 to service_role;