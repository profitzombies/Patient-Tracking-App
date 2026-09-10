-- Post-review hardening for already-applied Coach storage/memory migrations.
-- Additive only: replaces service RPC implementations and adds queue-state
-- aggregation; it does not rewrite previously applied schema.

create or replace function private.coach_memory_secret_like(p_text text)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(p_text,'') ~* '\m(password|passcode|pw|verification[ ]*code|one[- ]?time[ ]*(pass)?code|otp|api[ _-]?key|access[ ]*token|auth[ ]*token|secret|cvv|cvc|credit[ ]*card|debit[ ]*card|bank[ ]*account|routing[ ]*number|social[ ]*security|ssn)\M'
    or coalesce(p_text,'') ~ '\m[A-Za-z0-9_-]{24,}\M'
    or coalesce(p_text,'') ~ '\m[0-9]{3}-[0-9]{2}-[0-9]{4}\M'
    or coalesce(p_text,'') ~ '[0-9][0-9 -]{11,}[0-9]'
$$;

create or replace function private.coach_memory_ordinary(p_category text,p_text text)
returns boolean language sql immutable set search_path='' as $$
  select (p_category='food_preference' and p_text ~* '^(i )?(really )?(like|love|prefer|enjoy|hate|dislike|avoid) (chicken|turkey|fish|salmon|eggs?|yogurt|fruit|vegetables?|salad|rice|beans?|oatmeal|coffee|tea|water)( (for|at) (breakfast|lunch|dinner|snacks?))?[.!]?$')
      or (p_category='routine' and p_text ~* '^(i )?(usually|always|often) (eat|have|cook|drink) (breakfast|lunch|dinner|water|coffee|tea)( at [0-9]{1,2}(:[0-9]{2})? (am|pm))?[.!]?$')
      or (p_category='coaching_preference' and p_text ~* '^(please )?(give|keep|make) (me )?(short|brief|simple|step-by-step|gentle) (answers?|guidance|instructions?)[.!]?$')
$$;

create or replace function private.coach_conversation_recompute_processing(p_conversation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare p_state text; t_state text;
begin
  select case when exists(select 1 from public.coach_conversation_work where conversation_id=p_conversation_id and state='failed') then 'failed'
    when exists(select 1 from public.coach_conversation_work where conversation_id=p_conversation_id and state in ('pending','running')) then 'pending'
    else 'ready' end into p_state;
  select case when exists(select 1 from public.coach_conversation_work where conversation_id=p_conversation_id and kind='title' and state='failed') then 'failed'
    when exists(select 1 from public.coach_conversation_work where conversation_id=p_conversation_id and kind='title' and state in ('pending','running')) then 'pending'
    when exists(select 1 from public.coach_conversation_work where conversation_id=p_conversation_id and kind='title' and state='ready') then 'ready'
    else 'pending' end into t_state;
  update public.patient_chat_conversations set processing_state=p_state,title_state=t_state
    where id=p_conversation_id and thread='coach';
end;
$$;
create or replace function private.coach_conversation_work_recompute()
returns trigger language plpgsql security definer set search_path='' as $$
begin perform private.coach_conversation_recompute_processing(new.conversation_id); return new; end $$;
drop trigger if exists coach_conversation_work_recompute on public.coach_conversation_work;
create trigger coach_conversation_work_recompute after insert or update of state on public.coach_conversation_work
for each row execute function private.coach_conversation_work_recompute();

-- A failed item is never silently re-claimed: retry is an explicit patient
-- operation. Expired running leases are eligible after a worker dies.
create or replace function public.coach_memory_claim_processing(p_lease_seconds integer default 300)
returns table(work_id uuid,conversation_id uuid,patient_id uuid,source_client_id text,claim_token text)
language plpgsql security definer set search_path='' as $$
declare w public.coach_conversation_work%rowtype;
begin
 select * into w from public.coach_conversation_work where kind='memory'
  and (state='pending' or (state='running' and lease_until<now())) order by created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.coach_conversation_work set state='running',lease_owner=gen_random_uuid()::text,
   lease_until=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,600))),attempts=attempts+1,updated_at=now(),last_error=null
   where id=w.id returning * into w;
 return query select w.id,w.conversation_id,w.patient_id,w.source_client_id,w.lease_owner;
end $$;
create or replace function public.coach_title_claim_processing(p_lease_seconds integer default 300)
returns table(work_id uuid,conversation_id uuid,patient_id uuid,text text,claim_token text)
language plpgsql security definer set search_path='' as $$
declare w public.coach_conversation_work%rowtype;
begin
 select * into w from public.coach_conversation_work where kind='title'
  and exists(select 1 from public.patient_chat_messages a where a.conversation_id=coach_conversation_work.conversation_id and a.role='assistant' and coalesce(a.hidden,false)=false)
  and (state='pending' or (state='running' and lease_until<now())) order by created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.coach_conversation_work set state='running',lease_owner=gen_random_uuid()::text,
   lease_until=now()+make_interval(secs=>greatest(30,least(p_lease_seconds,600))),attempts=attempts+1,updated_at=now(),last_error=null
   where id=w.id returning * into w;
 return query select w.id,w.conversation_id,w.patient_id,coalesce((select m.text from public.patient_chat_messages m where m.conversation_id=w.conversation_id and m.client_id=w.source_client_id),'') ,w.lease_owner;
end $$;

create or replace function public.coach_memory_due_count(p_kind text)
returns bigint language sql stable security definer set search_path='' as $$
 select count(*) from public.coach_conversation_work where kind=p_kind and (state='pending' or (state='running' and lease_until<now()))
$$;

-- The worker may only commit the exact user source. Apply the shared secret
-- detector before any pending row is inserted, not merely when it is approved.
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
     and not private.coach_memory_secret_like(txt)
     and c->>'category' in ('food_preference','routine','coaching_preference','patient_detail') and c->>'sensitivity' in ('ordinary','sensitive')
     and exists(select 1 from public.patient_chat_messages m where m.conversation_id=p_conversation_id and m.client_id=client and m.role='user' and m.text=txt)
     and (c->>'sensitivity'<>'ordinary' or private.coach_memory_ordinary(c->>'category',txt))
     and not exists(select 1 from public.coach_memory_source_suppressions s where s.patient_id=p_patient_id and (s.topic_key=key or (s.source_conversation_id=p_conversation_id and s.source_message_id=client))) then
     insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash,confirmed_at)
     select p_patient_id,txt,c->>'category',c->>'sensitivity',case when c->>'sensitivity'='ordinary' then 'active' else 'pending' end,
       p_conversation_id,client,m.created_at,key,private.coach_memory_topic_key(txt),case when c->>'sensitivity'='ordinary' then now() else null end
     from public.patient_chat_messages m where m.conversation_id=p_conversation_id and m.client_id=client on conflict do nothing;
   end if;
 end loop;
 update public.coach_conversation_work set state='ready',lease_owner=null,lease_until=null,updated_at=now() where id=p_work_id;
 return true;
end $$;

create or replace function public.coach_memory_mutate(p_patient_id uuid,p_memory_id uuid,p_action text,p_expected_version integer,p_text text default null)
returns public.coach_memories language plpgsql security definer set search_path='' as $$
declare m public.coach_memories%rowtype; outrow public.coach_memories%rowtype; k text; ordinary boolean;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_patient_id::text,40421001));
 select * into m from public.coach_memories where id=p_memory_id and patient_id=p_patient_id for update;
 if not found then raise sqlstate 'P0002'; end if; if m.version<>p_expected_version then raise sqlstate '40001'; end if;
 if p_action='approve' and m.state in('pending','declined','removed') and not private.coach_memory_secret_like(m.text) then
   update public.coach_memories set state='active',confirmed_at=now(),updated_at=now(),version=version+1 where id=m.id returning * into outrow;
 elsif p_action in('decline','forget') then
   update public.coach_memories set state=case when p_action='decline' then 'declined' else 'removed' end,updated_at=now(),version=version+1 where id=m.id returning * into outrow;
   insert into public.coach_memory_source_suppressions(patient_id,source_conversation_id,source_message_id,topic_key,reason)
    values(m.patient_id,m.source_conversation_id,m.source_message_id,m.topic_key,case when p_action='decline' then 'declined' else 'removed' end) on conflict do nothing;
 elsif p_action='correct' and p_text is not null and char_length(trim(p_text)) between 1 and 180 and not private.coach_memory_secret_like(p_text) then
   ordinary:=private.coach_memory_ordinary(m.category,trim(p_text)); k:=private.coach_memory_topic_key(trim(p_text));
   update public.coach_memories set state='superseded',updated_at=now(),version=version+1 where id=m.id returning * into outrow;
   insert into public.coach_memory_source_suppressions(patient_id,source_conversation_id,source_message_id,topic_key,reason)
    values(m.patient_id,m.source_conversation_id,m.source_message_id,m.topic_key,'corrected') on conflict do nothing;
   insert into public.coach_memories(patient_id,text,category,sensitivity,state,source_conversation_id,source_message_id,source_created_at,topic_key,source_text_hash,source_revision,confirmed_at)
    values(m.patient_id,trim(p_text),m.category,case when ordinary then 'ordinary' else 'sensitive' end,case when ordinary then 'active' else 'pending' end,m.source_conversation_id,m.source_message_id,m.source_created_at,k,m.source_text_hash,m.source_revision+1,case when ordinary then now() else null end)
    returning * into outrow;
 else raise sqlstate '22023'; end if;
 return outrow;
end $$;

-- Terms are normalized in the server and applied before the 24-row scan cap.
create or replace function public.coach_historical_excerpts_v2(p_patient_id uuid,p_conversation_id uuid,p_terms text[],p_limit integer)
returns table(conversation_id uuid,text text) language sql security definer set search_path='' as $$
 select m.conversation_id,m.text from public.patient_chat_messages m join public.patient_chat_conversations c on c.id=m.conversation_id
 where c.patient_id=p_patient_id and c.thread='coach' and c.id<>p_conversation_id and m.role='user' and not coalesce(m.hidden,false)
 and not private.coach_memory_secret_like(m.text)
 and not (m.text ~* '\m(pregnan[a-z]*|diagnos[a-z]*|disease[a-z]*|condition[a-z]*|medicat[a-z]*|prescri[a-z]*|treat[a-z]*|therap[a-z]*|allerg[a-z]*|disab[a-z]*|mental health|anxiety|depress[a-z]*|substance|sober|abuse|sexual|gender|race|religion|hiv|ozempic)\M')
 -- Before extraction there is no pending row to protect an unknown source;
 -- raw history therefore admits only the exact ordinary grammar, never an
 -- open-ended first-person statement.
 and (private.coach_memory_ordinary('food_preference',m.text)
   or private.coach_memory_ordinary('routine',m.text)
   or private.coach_memory_ordinary('coaching_preference',m.text))
 and not exists(select 1 from public.coach_memory_source_suppressions s where s.patient_id=p_patient_id and s.source_conversation_id=m.conversation_id and s.source_message_id=m.client_id)
 and not exists(select 1 from public.coach_memories cm where cm.patient_id=p_patient_id and cm.source_conversation_id=m.conversation_id and cm.source_message_id=m.client_id and (cm.state<>'active' or cm.sensitivity<>'ordinary'))
 and exists(select 1 from unnest(coalesce(p_terms,'{}'::text[])) t where m.text ~* ('\m'||regexp_replace(t,'[^a-z0-9]','','g')||'[a-z]*\M'))
 order by m.created_at desc limit greatest(1,least(p_limit,24))
$$;

revoke all on function public.coach_memory_claim_processing(integer),public.coach_title_claim_processing(integer),
 public.coach_memory_due_count(text),public.coach_memory_mutate(uuid,uuid,text,integer,text),
 public.coach_historical_excerpts_v2(uuid,uuid,text[],integer) from public,anon,authenticated;
grant execute on function public.coach_memory_claim_processing(integer),public.coach_title_claim_processing(integer),
 public.coach_memory_due_count(text),public.coach_memory_mutate(uuid,uuid,text,integer,text),
 public.coach_historical_excerpts_v2(uuid,uuid,text[],integer) to service_role;