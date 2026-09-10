-- Controlled Coach memory. Conversation storage is owned by
-- 20261008000000_coach_conversations.sql: do not introduce another transcript
-- or work queue here.

create table public.coach_memories (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  text text not null check (char_length(text) between 1 and 180),
  category text not null check (category in ('food_preference','routine','coaching_preference','patient_detail')),
  sensitivity text not null check (sensitivity in ('ordinary','sensitive')),
  state text not null check (state in ('active','pending','declined','removed','superseded')),
  source_conversation_id uuid not null references public.patient_chat_conversations(id) on delete cascade,
  source_message_id text not null,
  source_created_at timestamptz not null,
  topic_key text not null,
  source_text_hash text not null,
  source_revision integer not null default 1 check(source_revision > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  confirmed_at timestamptz, version integer not null default 1 check (version > 0),
  unique(patient_id,source_conversation_id,source_message_id,source_revision),
  foreign key(source_conversation_id,source_message_id)
    references public.patient_chat_messages(conversation_id,client_id) on delete cascade
);
create index coach_memories_recall_idx on public.coach_memories(patient_id,state,updated_at desc);
create unique index coach_memories_active_topic_unique on public.coach_memories(patient_id,topic_key)
  where state in ('active','pending');

-- A durable topic/source tombstone is required because a queued pre-forget
-- message may otherwise be processed after the patient has forgotten it.
create table public.coach_memory_source_suppressions (
  patient_id uuid not null references public.patients(id) on delete cascade,
  source_conversation_id uuid,
  source_message_id text,
  topic_key text not null,
  reason text not null check(reason in ('declined','removed','corrected','superseded')),
  created_at timestamptz not null default now(),
  primary key(patient_id,source_conversation_id,source_message_id),
  unique(patient_id,topic_key)
);
create index coach_memory_suppressions_source_idx
  on public.coach_memory_source_suppressions(patient_id,source_conversation_id,source_message_id);

alter table public.coach_memories enable row level security;
alter table public.coach_memory_source_suppressions enable row level security;
revoke all on public.coach_memories,public.coach_memory_source_suppressions from public,anon,authenticated;

create or replace function private.coach_memory_topic_key(p_text text) returns text
language sql immutable set search_path='' as $$
  select md5(lower(regexp_replace(trim(p_text),'\s+',' ','g')))
$$;

-- `coach_conversation_work` is storage-owned. It has one durable item per
-- conversation/kind and is inserted transactionally by append. Memory claims
-- scan only that queue and are lease-checked before the atomic completion.
create or replace function public.coach_memory_claim_processing(p_lease_seconds integer default 300)
returns table(work_id uuid,conversation_id uuid,patient_id uuid,source_client_id text,claim_token text)
language plpgsql security definer set search_path='' as $$
declare w public.coach_conversation_work%rowtype;
begin
  select * into w from public.coach_conversation_work
   where kind='memory' and (state in ('pending','failed') or (state='running' and lease_until<now()))
   order by created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.coach_conversation_work set state='running',lease_owner=gen_random_uuid()::text,
    lease_until=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,600))),attempts=attempts+1,
    updated_at=now(),last_error=null where id=w.id returning * into w;
  if not exists(select 1 from public.patient_chat_conversations c join public.patients p on p.id=c.patient_id
    where c.id=w.conversation_id and c.patient_id=w.patient_id and c.thread='coach' and c.archived_at is null and p.archived_at is null) then
    update public.coach_conversation_work set state='ready',lease_owner=null,lease_until=null,updated_at=now() where id=w.id;
    return;
  end if;
  return query select w.id,w.conversation_id,w.patient_id,w.source_client_id,w.lease_owner;
end;
$$;

-- The worker supplies only deterministic candidates derived from each listed
-- user message. SQL validates source ownership, queue claim, suppression and
-- credential prohibition in the same transaction.
create or replace function public.coach_memory_complete_processing(
  p_work_id uuid,p_patient_id uuid,p_conversation_id uuid,p_claim_token text,p_candidates jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare w public.coach_conversation_work%rowtype; c jsonb; txt text; key text; client text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_patient_id::text,40421001));
  select * into w from public.coach_conversation_work where id=p_work_id for update;
  if not found or w.patient_id<>p_patient_id or w.conversation_id<>p_conversation_id or w.kind<>'memory'
    or w.state<>'running' or w.lease_owner<>p_claim_token or w.lease_until<now() then return false; end if;
  if not exists(select 1 from public.patient_chat_conversations c0 join public.patients p on p.id=c0.patient_id
    where c0.id=p_conversation_id and c0.patient_id=p_patient_id and c0.thread='coach' and c0.archived_at is null and p.archived_at is null) then
    update public.coach_conversation_work set state='ready',lease_owner=null,lease_until=null,updated_at=now() where id=p_work_id; return false;
  end if;
  for c in select value from jsonb_array_elements(coalesce(p_candidates,'[]'::jsonb)) loop
    client:=c->>'sourceMessageId'; txt:=c->>'text'; key:=coalesce(nullif(c->>'topicKey',''),private.coach_memory_topic_key(coalesce(txt,'')));
    if client is not null and txt is not null and char_length(txt) between 1 and 180
      and c->>'category' in ('food_preference','routine','coaching_preference','patient_detail') and c->>'sensitivity' in ('ordinary','sensitive')
      and txt !~* '\m(password|passcode|pw|verification code|one[- ]time code|otp|api[ _-]?key|access token|secret|cvv|cvc|credit card|debit card|bank account|routing number|social security|ssn)\M'
      and txt !~ '[0-9][0-9 -]{11,}[0-9]'
      and exists(select 1 from public.patient_chat_messages m where m.conversation_id=p_conversation_id and m.client_id=client and m.role='user' and m.text=txt)
      and (c->>'sensitivity'<>'ordinary' or (
        (c->>'category'='food_preference' and txt ~* '^(i )?(really )?(like|love|prefer|enjoy|hate|dislike|avoid) (chicken|turkey|fish|salmon|eggs?|yogurt|fruit|vegetables?|salad|rice|beans?|oatmeal|coffee|tea|water)( (for|at) (breakfast|lunch|dinner|snacks?))?[.!]?$')
        or (c->>'category'='routine' and txt ~* '^(i )?(usually|always|often) (eat|have|cook|drink) (breakfast|lunch|dinner|water|coffee|tea)( at [0-9]{1,2}(:[0-9]{2})? (am|pm))?[.!]?$')
        or (c->>'category'='coaching_preference' and txt ~* '^(please )?(give|keep|make) (me )?(short|brief|simple|step-by-step|gentle) (answers?|guidance|instructions?)[.!]?$')
      ))
      and not exists(select 1 from public.coach_memory_source_suppressions s where s.patient_id=p_patient_id and (s.topic_key=key or (s.source_conversation_id=p_conversation_id and s.source_message_id=client))) then
      insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash,confirmed_at)
      select p_patient_id,txt,c->>'category',c->>'sensitivity',case when c->>'sensitivity'='ordinary' then 'active' else 'pending' end,
        p_conversation_id,client,m.created_at,key,private.coach_memory_topic_key(txt),case when c->>'sensitivity'='ordinary' then now() else null end
      from public.patient_chat_messages m where m.conversation_id=p_conversation_id and m.client_id=client
      on conflict do nothing;
    end if;
  end loop;
  update public.coach_conversation_work set state='ready',lease_owner=null,lease_until=null,updated_at=now() where id=p_work_id;
  return true;
end;
$$;
create or replace function public.coach_memory_fail_processing(p_work_id uuid,p_patient_id uuid,p_conversation_id uuid,p_claim_token text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.coach_conversation_work set state='failed',lease_owner=null,lease_until=null,last_error='processing_failed',updated_at=now()
 where id=p_work_id and patient_id=p_patient_id and conversation_id=p_conversation_id and kind='memory' and state='running' and lease_owner=p_claim_token;
 if not found then return false; end if;
 update public.patient_chat_conversations set processing_state='failed'
   where id=p_conversation_id and patient_id=p_patient_id and thread='coach';
 return true;
end
$$;
create or replace function public.coach_memory_retry_processing(p_patient_id uuid,p_conversation_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.patient_chat_conversations where id=p_conversation_id and patient_id=p_patient_id and thread='coach') then return false; end if;
  update public.coach_conversation_work set state='pending',lease_owner=null,lease_until=null,last_error=null,updated_at=now()
    where patient_id=p_patient_id and conversation_id=p_conversation_id and state='failed' and kind in ('memory','title');
  if found then update public.patient_chat_conversations set processing_state='pending' where id=p_conversation_id; end if;
  return true;
end;
$$;

create or replace function public.coach_memory_mutate(p_patient_id uuid,p_memory_id uuid,p_action text,p_expected_version integer,p_text text default null)
returns public.coach_memories language plpgsql security definer set search_path='' as $$
declare m public.coach_memories%rowtype; outrow public.coach_memories%rowtype; k text; sens boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_patient_id::text,40421001));
  select * into m from public.coach_memories where id=p_memory_id and patient_id=p_patient_id for update;
  if not found then raise sqlstate 'P0002'; end if; if m.version<>p_expected_version then raise sqlstate '40001'; end if;
  if p_action='approve' and m.state in ('pending','declined','removed') and m.text !~* '\m(password|passcode|pw|verification code|one[- ]time code|otp|api[ _-]?key|access token|secret|cvv|cvc|credit card|debit card|bank account|routing number|social security|ssn)\M' and m.text !~ '[0-9][0-9 -]{11,}[0-9]' then
    update public.coach_memories set state='active',confirmed_at=now(),updated_at=now(),version=version+1 where id=m.id returning * into outrow;
  elsif p_action in ('decline','forget') then
    update public.coach_memories set state=case when p_action='decline' then 'declined' else 'removed' end,updated_at=now(),version=version+1 where id=m.id returning * into outrow;
    insert into public.coach_memory_source_suppressions values(m.patient_id,m.source_conversation_id,m.source_message_id,m.topic_key,case when p_action='decline' then 'declined' else 'removed' end) on conflict do nothing;
  elsif p_action='correct' and p_text is not null and char_length(trim(p_text)) between 1 and 180 and p_text !~* '\m(password|passcode|pw|verification code|one[- ]time code|otp|api[ _-]?key|access token|secret|cvv|cvc|credit card|debit card|bank account|routing number|social security|ssn)\M' and p_text !~ '[0-9][0-9 -]{11,}[0-9]' then
    update public.coach_memories set state='superseded',updated_at=now(),version=version+1 where id=m.id returning * into outrow;
    insert into public.coach_memory_source_suppressions values(m.patient_id,m.source_conversation_id,m.source_message_id,m.topic_key,'corrected') on conflict do nothing;
    k:=private.coach_memory_topic_key(trim(p_text)); sens:=trim(p_text)~*'\m(pregnan|diagnos|disease|condition|medicat|prescription|treatment|therapy|allerg|disab|mental health|anxiety|depress|substance|sober|abuse|sexual|gender|race|religion)';
    insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash,source_revision,confirmed_at)
      values(m.patient_id,trim(p_text),m.category,case when sens then 'sensitive' else 'ordinary' end,case when sens then 'pending' else 'active' end,m.source_conversation_id,m.source_message_id,m.source_created_at,k,m.source_text_hash,m.source_revision+1,case when sens then null else now() end);
  else raise sqlstate '22023'; end if; return outrow;
end;
$$;

create or replace function public.coach_memory_list_patient(p_patient_id uuid,p_limit integer,p_offset integer)
returns table(id uuid,text text,category text,sensitivity text,state text,source_conversation_id uuid,source_message_id text,source_created_at timestamptz,created_at timestamptz,updated_at timestamptz,confirmed_at timestamptz,version integer,total bigint)
language sql security definer set search_path='' as $$
 select m.id,m.text,m.category,m.sensitivity,m.state,m.source_conversation_id,m.source_message_id,m.source_created_at,m.created_at,m.updated_at,m.confirmed_at,m.version,count(*)over()
 from public.coach_memories m where m.patient_id=p_patient_id order by m.updated_at desc limit greatest(1,least(p_limit,50)) offset greatest(0,p_offset)
$$;
create or replace function public.coach_memory_list_provider(p_patient_id uuid,p_provider_id text,p_limit integer,p_offset integer)
returns table(id uuid,text text,category text,sensitivity text,state text,source_conversation_id uuid,source_message_id text,source_created_at timestamptz,created_at timestamptz,updated_at timestamptz,confirmed_at timestamptz,version integer,total bigint)
language sql security definer set search_path='' as $$
 select m.id,m.text,m.category,m.sensitivity,m.state,m.source_conversation_id,m.source_message_id,m.source_created_at,m.created_at,m.updated_at,m.confirmed_at,m.version,count(*)over()
 from public.coach_memories m join public.patients p on p.id=m.patient_id where m.patient_id=p_patient_id and p.provider_id=p_provider_id and p.archived_at is null and m.state='active'
 and exists(select 1 from public.patient_chat_messages sm where sm.conversation_id=m.source_conversation_id and sm.client_id=m.source_message_id and private.coach_memory_topic_key(sm.text)=m.source_text_hash)
 order by m.updated_at desc limit greatest(1,least(p_limit,50)) offset greatest(0,p_offset)
$$;
create or replace function public.coach_memory_recall(p_patient_id uuid,p_conversation_id uuid,p_limit integer)
returns table(id uuid,text text,category text) language sql security definer set search_path='' as $$
 select m.id,m.text,m.category from public.coach_memories m where m.patient_id=p_patient_id and m.state='active'
 and exists(select 1 from public.patient_chat_conversations c where c.id=p_conversation_id and c.patient_id=p_patient_id and c.thread='coach' and c.archived_at is null)
 and exists(select 1 from public.patient_chat_messages sm where sm.conversation_id=m.source_conversation_id and sm.client_id=m.source_message_id and private.coach_memory_topic_key(sm.text)=m.source_text_hash)
 order by m.updated_at desc limit greatest(1,least(p_limit,24))
$$;
create or replace function public.coach_generation_conversation(p_patient_id uuid,p_conversation_id uuid) returns text language sql security definer set search_path='' as $$
 select case when exists(select 1 from public.patient_chat_conversations where id=p_conversation_id and patient_id=p_patient_id and thread='coach' and archived_at is null) then 'ok'
 when exists(select 1 from public.patient_chat_conversations where id=p_conversation_id and patient_id=p_patient_id and thread='coach') then 'archived' else 'missing' end
$$;
-- Excerpts are only called after the request parser detects an explicit
-- earlier-chat question. Sensitive/credential text and every suppressed
-- source/topic are excluded before text reaches application memory.
create or replace function public.coach_historical_excerpts(p_patient_id uuid,p_conversation_id uuid,p_limit integer)
returns table(conversation_id uuid,text text) language sql security definer set search_path='' as $$
 select m.conversation_id,m.text from public.patient_chat_messages m
 join public.patient_chat_conversations c on c.id=m.conversation_id
 where c.patient_id=p_patient_id and c.thread='coach' and c.id<>p_conversation_id and m.role='user' and coalesce(m.hidden,false)=false
 and m.text !~* '\m(password|passcode|verification code|one[- ]time code|otp|api[ _-]?key|access token|secret|cvv|cvc|credit card|debit card|bank account|routing number|pregnan[a-z]*|diagnos[a-z]*|disease[a-z]*|condition[a-z]*|medicat[a-z]*|prescri[a-z]*|treat[a-z]*|therap[a-z]*|allerg[a-z]*|disab[a-z]*|mental health|anxiety|depress[a-z]*|substance|sober|abuse|sexual|gender|race|religion)\M'
 and not exists(select 1 from public.coach_memory_source_suppressions s where s.patient_id=p_patient_id and
   (s.source_conversation_id=m.conversation_id and s.source_message_id=m.client_id or s.topic_key=private.coach_memory_topic_key(m.text)))
 order by m.created_at desc limit greatest(1,least(p_limit,24))
$$;

-- Titles share the storage-owned work ledger; their value is an allowlisted
-- generic label, never a model-generated echo of private message content.
create or replace function public.coach_title_claim_processing(p_lease_seconds integer default 300)
returns table(work_id uuid,conversation_id uuid,patient_id uuid,text text,claim_token text)
language plpgsql security definer set search_path='' as $$
declare w public.coach_conversation_work%rowtype;
begin
 select * into w from public.coach_conversation_work where kind='title'
   and exists(select 1 from public.patient_chat_messages a where a.conversation_id=coach_conversation_work.conversation_id and a.role='assistant' and coalesce(a.hidden,false)=false)
   and (state in('pending','failed') or(state='running' and lease_until<now())) order by created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.coach_conversation_work set state='running',lease_owner=gen_random_uuid()::text,lease_until=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,600))),attempts=attempts+1,updated_at=now(),last_error=null where id=w.id returning * into w;
 return query select w.id,w.conversation_id,w.patient_id,coalesce((select m.text from public.patient_chat_messages m where m.conversation_id=w.conversation_id and m.client_id=w.source_client_id and m.role='user'),''),w.lease_owner;
end;
$$;
create or replace function public.coach_title_complete_processing(p_work_id uuid,p_patient_id uuid,p_conversation_id uuid,p_claim_token text,p_title text)
returns boolean language plpgsql security definer set search_path='' as $$
declare w public.coach_conversation_work%rowtype;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_patient_id::text,40421001));
 select * into w from public.coach_conversation_work where id=p_work_id for update;
 if not found or w.kind<>'title' or w.patient_id<>p_patient_id or w.conversation_id<>p_conversation_id or w.state<>'running' or w.lease_owner<>p_claim_token or w.lease_until<now() then return false; end if;
 if not exists(select 1 from public.patient_chat_conversations c join public.patients p on p.id=c.patient_id where c.id=p_conversation_id and c.patient_id=p_patient_id and c.thread='coach' and c.archived_at is null and p.archived_at is null) then return false; end if;
 update public.patient_chat_conversations set title=case when p_title in('Meal ideas','Grocery planning','Snack support','Coaching plan','Coach conversation') then p_title else 'New conversation' end,title_state='ready',processing_state='ready' where id=p_conversation_id and patient_id=p_patient_id;
 update public.coach_conversation_work set state='ready',lease_owner=null,lease_until=null,updated_at=now() where id=p_work_id; return true;
end;
$$;
create or replace function public.coach_title_fail_processing(p_work_id uuid,p_patient_id uuid,p_conversation_id uuid,p_claim_token text)
returns boolean language sql security definer set search_path='' as $$
 update public.coach_conversation_work set state='failed',lease_owner=null,lease_until=null,last_error='processing_failed',updated_at=now()
 where id=p_work_id and patient_id=p_patient_id and conversation_id=p_conversation_id and kind='title' and state='running' and lease_owner=p_claim_token returning true
$$;

revoke all on function public.coach_memory_claim_processing(integer),public.coach_memory_complete_processing(uuid,uuid,uuid,text,jsonb),public.coach_memory_fail_processing(uuid,uuid,uuid,text),public.coach_memory_retry_processing(uuid,uuid),public.coach_memory_mutate(uuid,uuid,text,integer,text),public.coach_memory_list_patient(uuid,integer,integer),public.coach_memory_list_provider(uuid,text,integer,integer),public.coach_memory_recall(uuid,uuid,integer),public.coach_generation_conversation(uuid,uuid) from public,anon,authenticated;
revoke all on function public.coach_historical_excerpts(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.coach_title_claim_processing(integer),public.coach_title_complete_processing(uuid,uuid,uuid,text,text),public.coach_title_fail_processing(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.coach_memory_claim_processing(integer),
  public.coach_memory_complete_processing(uuid,uuid,uuid,text,jsonb),
  public.coach_memory_fail_processing(uuid,uuid,uuid,text),
  public.coach_memory_retry_processing(uuid,uuid),
  public.coach_memory_mutate(uuid,uuid,text,integer,text),
  public.coach_memory_list_patient(uuid,integer,integer),
  public.coach_memory_list_provider(uuid,text,integer,integer),
  public.coach_memory_recall(uuid,uuid,integer),
  public.coach_generation_conversation(uuid,uuid),
  public.coach_historical_excerpts(uuid,uuid,integer),
  public.coach_title_claim_processing(integer),
  public.coach_title_complete_processing(uuid,uuid,uuid,text,text),
  public.coach_title_fail_processing(uuid,uuid,uuid,text)
to service_role;
grant select on public.coach_conversation_work, public.patient_chat_messages to service_role;
select private.install_patient_identity_write_guards();