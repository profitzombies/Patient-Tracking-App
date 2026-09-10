-- Separate, patient-owned Coach conversations.
--
-- We deliberately extend patient_chat_* rather than resurrecting the archived
-- coach_conversations shape.  Support remains one AI thread per patient and
-- Care Team remains one human thread per patient/business.  The previous
-- singleton Coach row becomes the deterministic compatibility conversation.

alter table public.patient_chat_conversations
  add column if not exists client_key text,
  add column if not exists legacy_compat boolean not null default false,
  add column if not exists title text not null default 'New conversation',
  add column if not exists title_state text not null default 'pending',
  add column if not exists archived_at timestamptz,
  add column if not exists version integer not null default 1,
  add column if not exists processing_state text not null default 'pending';

alter table public.patient_chat_conversations
  drop constraint if exists patient_chat_conversations_title_state_check,
  add constraint patient_chat_conversations_title_state_check
    check (title_state in ('pending', 'ready', 'failed')),
  drop constraint if exists patient_chat_conversations_processing_state_check,
  add constraint patient_chat_conversations_processing_state_check
    check (processing_state in ('pending', 'ready', 'failed'));

-- Preserve the old row exactly: no message movement, no regenerated UUID,
-- client ids, seqs, created_at, or updated_at.  New clients can never infer a
-- current conversation from this row; only the legacy no-id path uses it.
update public.patient_chat_conversations
set legacy_compat = true,
    client_key = coalesce(client_key, 'legacy'),
    title = 'Earlier conversation',
    title_state = 'ready',
    processing_state = 'ready'
-- Only pre-extension rows lack a client key.  Never reclassify a newer chat
-- when a checksum runner deliberately replays this idempotent migration.
where thread = 'coach' and client_key is null;

alter table public.patient_chat_conversations
  drop constraint if exists patient_chat_conversations_coach_identity_check,
  add constraint patient_chat_conversations_coach_identity_check check (
    (thread = 'coach' and client_key is not null and char_length(client_key) between 1 and 128)
    or (thread <> 'coach' and client_key is null)
  );

-- AI support stays singleton.  Coach creation is keyed by an opaque client key,
-- while exactly one per-patient compatibility row remains available to old
-- mobile clients.  Care Team's patient/business index is untouched.
drop index if exists public.patient_chat_conversations_ai_unique;
create unique index if not exists patient_chat_conversations_support_unique
  on public.patient_chat_conversations(patient_id)
  where thread = 'support';
create unique index if not exists patient_chat_conversations_coach_client_key_unique
  on public.patient_chat_conversations(patient_id, client_key)
  where thread = 'coach';
create unique index if not exists patient_chat_conversations_coach_legacy_unique
  on public.patient_chat_conversations(patient_id)
  where thread = 'coach' and legacy_compat;
create index if not exists patient_chat_conversations_coach_activity_idx
  on public.patient_chat_conversations(patient_id, archived_at, updated_at desc, id desc)
  where thread = 'coach';

-- A durable, idempotent hand-off.  Workers claim this table through the job
-- ledger; append never starts an untracked process. source_client_id preserves
-- the existing client-message identity (messages are keyed by it, not UUID).
create table if not exists public.coach_conversation_work (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  kind text not null check (kind in ('title', 'memory')),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 180),
  source_client_id text,
  state text not null default 'pending' check (state in ('pending', 'running', 'ready', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_owner text,
  lease_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversation_id, dedupe_key)
);
alter table public.coach_conversation_work enable row level security;
revoke all on public.coach_conversation_work from public, anon, authenticated;
grant all on public.coach_conversation_work to service_role;
create index if not exists coach_conversation_work_claim_idx
  on public.coach_conversation_work(state, created_at)
  where state in ('pending', 'failed');

create or replace function public.coach_legacy_conversation_id(p_patient_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  -- This is the same patient/consent/office barrier used by existing AI
  -- persistence and serializes with identity reconciliation.
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  insert into public.patient_chat_conversations
    (patient_id, thread, legacy_compat, client_key, title, title_state, processing_state)
  values (p_patient_id, 'coach', true, 'legacy', 'Earlier conversation', 'ready', 'ready')
  on conflict (patient_id) where thread = 'coach' and legacy_compat
  do update set updated_at = public.patient_chat_conversations.updated_at
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.coach_conversation_create(p_patient_id uuid, p_client_key text)
returns table (
  id uuid, title text, title_state text, archived_at timestamptz,
  created_at timestamptz, updated_at timestamptz, version integer, processing_state text
) language plpgsql security definer set search_path = '' as $$
begin
  if p_client_key is null or char_length(trim(p_client_key)) not between 1 and 128 then
    raise exception 'invalid client key';
  end if;
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  insert into public.patient_chat_conversations
    (patient_id, thread, legacy_compat, client_key)
  values (p_patient_id, 'coach', false, trim(p_client_key))
  on conflict (patient_id, client_key) where thread = 'coach'
  do update set updated_at = public.patient_chat_conversations.updated_at
  returning patient_chat_conversations.id, patient_chat_conversations.title,
    patient_chat_conversations.title_state, patient_chat_conversations.archived_at,
    patient_chat_conversations.created_at, patient_chat_conversations.updated_at,
    patient_chat_conversations.version, patient_chat_conversations.processing_state
  into id, title, title_state, archived_at, created_at, updated_at, version, processing_state;
  return next;
end $$;

create or replace function public.coach_conversation_list(
  p_patient_id uuid, p_archived boolean default false, p_limit integer default 20, p_offset integer default 0
) returns table (
  id uuid, title text, title_state text, archived_at timestamptz,
  created_at timestamptz, updated_at timestamptz, version integer, processing_state text, total bigint
) language sql stable security definer set search_path = '' as $$
  select c.id, c.title, c.title_state, c.archived_at, c.created_at, c.updated_at,
    c.version, c.processing_state, count(*) over()
  from public.patient_chat_conversations c
  where c.patient_id = p_patient_id and c.thread = 'coach'
    and (case when coalesce(p_archived, false) then c.archived_at is not null else c.archived_at is null end)
  order by c.updated_at desc, c.id desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset greatest(0, coalesce(p_offset, 0))
$$;

create or replace function public.coach_conversation_get(p_patient_id uuid, p_conversation_id uuid)
returns table (
  id uuid, title text, title_state text, archived_at timestamptz,
  created_at timestamptz, updated_at timestamptz, version integer, processing_state text
) language sql stable security definer set search_path = '' as $$
  select c.id, c.title, c.title_state, c.archived_at, c.created_at, c.updated_at,
    c.version, c.processing_state
  from public.patient_chat_conversations c
  where c.id = p_conversation_id and c.patient_id = p_patient_id and c.thread = 'coach'
$$;

create or replace function public.coach_conversation_append(
  p_patient_id uuid, p_conversation_id uuid, p_messages jsonb
) returns text language plpgsql security definer set search_path = '' as $$
declare c public.patient_chat_conversations%rowtype; r record; v_new boolean;
begin
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  select * into c from public.patient_chat_conversations
  where id = p_conversation_id and patient_id = p_patient_id and thread = 'coach' for update;
  if not found then return 'missing'; end if;
  if c.archived_at is not null then return 'archived'; end if;
  for r in select * from jsonb_to_recordset(coalesce(p_messages, '[]'::jsonb)) as x(
    client_id text, role text, text text, stopped boolean, hidden boolean, card jsonb,
    quick_replies jsonb, reply_to_client_id text, photo jsonb
  ) loop
    -- This is the patient-facing Coach writer (also used by legacy Coach).
    -- Staff roles remain valid only for Care Team/support paths.
    if r.role not in ('user', 'assistant') then
      raise exception 'invalid coach message role';
    end if;
    v_new := false;
    if not exists(select 1 from public.patient_chat_messages m
      where m.conversation_id = c.id and m.client_id = r.client_id) then
      insert into public.patient_chat_messages
        (conversation_id, client_id, role, text, stopped, hidden, card, quick_replies, reply_to_client_id, photo)
      values (c.id, r.client_id, r.role, coalesce(r.text, ''), coalesce(r.stopped, false),
        coalesce(r.hidden, false), r.card, r.quick_replies, r.reply_to_client_id, r.photo);
      v_new := true;
    else
      update public.patient_chat_messages set text = coalesce(r.text, ''), stopped = coalesce(r.stopped, false),
        hidden = coalesce(r.hidden, false), card = r.card, quick_replies = r.quick_replies,
        reply_to_client_id = r.reply_to_client_id, photo = r.photo, updated_at = clock_timestamp()
      where conversation_id = c.id and client_id = r.client_id;
    end if;
    if v_new and r.role = 'user' and nullif(trim(coalesce(r.text, '')), '') is not null then
      insert into public.coach_conversation_work(patient_id, conversation_id, kind, dedupe_key, source_client_id)
      values (p_patient_id, c.id, 'title', 'title', r.client_id),
        (p_patient_id, c.id, 'memory', 'memory:' || r.client_id, r.client_id)
      on conflict (conversation_id, dedupe_key) do nothing;
      update public.patient_chat_conversations
        set processing_state = 'pending', title_state = case when title_state = 'ready' then title_state else 'pending' end
      where id = c.id;
    end if;
  end loop;
  update public.patient_chat_conversations set updated_at = clock_timestamp() where id = c.id;
  return 'ok';
end $$;

create or replace function public.coach_conversation_archive(
  p_patient_id uuid, p_conversation_id uuid, p_archived boolean, p_expected_version integer
) returns text language plpgsql security definer set search_path = '' as $$
declare c public.patient_chat_conversations%rowtype;
begin
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  select * into c from public.patient_chat_conversations
  where id = p_conversation_id and patient_id = p_patient_id and thread = 'coach' for update;
  if not found then return 'missing'; end if;
  if c.version <> p_expected_version then return 'conflict'; end if;
  update public.patient_chat_conversations
  set archived_at = case when p_archived then coalesce(archived_at, clock_timestamp()) else null end,
      version = version + 1, updated_at = clock_timestamp()
  where id = c.id;
  return 'ok';
end $$;

-- Legacy app endpoints have no conversation id. They always use this one
-- deterministic compatibility row, never the newest user-created chat.
create or replace function public.patient_chat_apply(
  p_patient_id uuid, p_thread text, p_messages jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare v_conversation_id uuid; v_result text;
begin
  if p_thread = 'coach' then
    v_conversation_id := public.coach_legacy_conversation_id(p_patient_id);
    v_result := public.coach_conversation_append(p_patient_id, v_conversation_id, p_messages);
    if v_result <> 'ok' then raise exception 'legacy coach append failed'; end if;
    return;
  end if;
  if p_thread <> 'support' then raise exception 'invalid thread %', p_thread; end if;
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  insert into public.patient_chat_conversations(patient_id, thread)
  values(p_patient_id, p_thread)
  on conflict(patient_id) where thread = 'support'
  do update set updated_at = clock_timestamp() returning id into v_conversation_id;
  insert into public.patient_chat_messages
    (conversation_id,client_id,role,text,stopped,hidden,card,quick_replies,reply_to_client_id,photo)
  select v_conversation_id,r.client_id,r.role,coalesce(r.text,''),coalesce(r.stopped,false),
    coalesce(r.hidden,false),r.card,r.quick_replies,r.reply_to_client_id,r.photo
  from jsonb_to_recordset(coalesce(p_messages,'[]'::jsonb)) as r(
    client_id text,role text,text text,stopped boolean,hidden boolean,card jsonb,
    quick_replies jsonb,reply_to_client_id text,photo jsonb)
  on conflict(conversation_id,client_id) do update set text=excluded.text,stopped=excluded.stopped,
    hidden=excluded.hidden,card=excluded.card,quick_replies=excluded.quick_replies,
    reply_to_client_id=excluded.reply_to_client_id,photo=excluded.photo,updated_at=clock_timestamp();
end $$;

revoke all on function public.coach_legacy_conversation_id(uuid),
  public.coach_conversation_create(uuid,text), public.coach_conversation_list(uuid,boolean,integer,integer),
  public.coach_conversation_get(uuid,uuid), public.coach_conversation_append(uuid,uuid,jsonb),
  public.coach_conversation_archive(uuid,uuid,boolean,integer), public.patient_chat_apply(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.coach_legacy_conversation_id(uuid),
  public.coach_conversation_create(uuid,text), public.coach_conversation_list(uuid,boolean,integer,integer),
  public.coach_conversation_get(uuid,uuid), public.coach_conversation_append(uuid,uuid,jsonb),
  public.coach_conversation_archive(uuid,uuid,boolean,integer), public.patient_chat_apply(uuid,text,jsonb)
  to service_role;

-- coach_conversation_work is patient-owned and must participate in the same
-- reconciliation lock/read barrier as every other patient_id table.
select private.install_patient_identity_write_guards();