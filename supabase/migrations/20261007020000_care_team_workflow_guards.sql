-- Transactional lifecycle/actor barriers for every conversation workflow write.
-- API scope checks remain useful UX, but this function is the commit-time authority.

create or replace function public.patient_chat_workflow_mutate(
 p_conversation_id uuid,p_provider_id text,p_actor_user_id uuid,p_actor_kind text,
 p_action text,p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.patient_chat_conversations%rowtype; p public.patients%rowtype;
 v_label text; v_id uuid; v_department text;
begin
 select * into c from public.patient_chat_conversations where id=p_conversation_id for update;
 if not found then raise exception 'conversation unavailable'; end if;
 select * into p from public.patients where id=c.patient_id for update;
 if not found or p.archived_at is not null or p.deletion_requested_at is not null
    or p.activation_status='disabled' then raise exception 'patient unavailable'; end if;
 if (c.thread='care_team' and c.provider_id<>p_provider_id)
    or (c.thread<>'care_team' and p.provider_id<>p_provider_id)
 then raise exception 'conversation unavailable'; end if;
 if not exists(select 1 from public.patient_consents pc where pc.patient_id=p.id
   and pc.policy_version='2026-09-01' and pc.terms_accepted and pc.privacy_accepted
   and pc.health_data_accepted) then raise exception 'consent required'; end if;
 if not exists(select 1 from public.providers pr where pr.provider_id=p_provider_id
   and not coalesce(pr.access_disabled,false) for share)
   or private.provider_account_is_locked(p_provider_id) then raise exception 'office unavailable'; end if;

 if p_actor_kind='hq' then
   if c.thread='care_team' then raise exception 'HQ human workflow is read only'; end if;
   if not exists(select 1 from public.hq_memberships h where h.auth_user_id=p_actor_user_id
      and h.status='active' for share) then raise exception 'staff unavailable'; end if;
 elsif not (
   exists(select 1 from public.providers pr where pr.provider_id=p_provider_id
      and pr.auth_user_id=p_actor_user_id for share)
   or exists(select 1 from public.team_members tm where tm.provider_id=p_provider_id
      and tm.auth_user_id=p_actor_user_id and tm.activation_status is distinct from 'disabled' for share)
 ) then raise exception 'staff unavailable';
 end if;

 if p_action='assign' then
   if nullif(p_payload->>'assigneeUserId','') is not null and not (
    exists(select 1 from public.providers ap where ap.provider_id=p_provider_id
      and ap.auth_user_id=(p_payload->>'assigneeUserId')::uuid for share)
    or exists(select 1 from public.team_members am where am.provider_id=p_provider_id
      and am.auth_user_id=(p_payload->>'assigneeUserId')::uuid
      and am.activation_status is distinct from 'disabled' for share)
   ) then raise exception 'assignee unavailable'; end if;
   update public.patient_chat_conversations set
    assignee_user_id=nullif(p_payload->>'assigneeUserId','')::uuid,
    assignee_label=nullif(p_payload->>'assigneeLabel','')
   where id=c.id;
   return jsonb_build_object('ok',true);
 elsif p_action='status' then
   if p_payload->>'status' not in ('open','waiting_patient','closed') then raise exception 'invalid status'; end if;
   update public.patient_chat_conversations set status=p_payload->>'status',updated_at=clock_timestamp() where id=c.id;
   return jsonb_build_object('ok',true);
 elsif p_action='note' then
   if nullif(trim(p_payload->>'body'),'') is null then raise exception 'invalid note'; end if;
   insert into public.patient_chat_notes(conversation_id,provider_id,author_user_id,author_label,body)
    values(c.id,p_provider_id,p_actor_user_id,p_payload->>'authorLabel',trim(p_payload->>'body'))
    returning id into v_id;
   return jsonb_build_object('id',v_id);
 elsif p_action='escalate' then
   if c.thread='care_team' then raise exception 'care-team conversations cannot be escalated'; end if;
   v_department:=p_payload->>'department'; v_label:=p_payload->>'authorLabel';
   if v_department not in ('clinical','support') then raise exception 'invalid department'; end if;
   insert into public.patient_chat_escalations(conversation_id,provider_id,department,reason,created_by,created_by_label)
    values(c.id,p_provider_id,v_department,trim(p_payload->>'reason'),p_actor_user_id,v_label)
    returning id into v_id;
   return jsonb_build_object('id',v_id);
 end if;
 raise exception 'invalid workflow action';
end $$;
revoke all on function public.patient_chat_workflow_mutate(uuid,text,uuid,text,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.patient_chat_workflow_mutate(uuid,text,uuid,text,text,jsonb) to service_role;

-- AI transcript writes now share the patient/consent/office barrier. Care-team
-- traffic continues through care_team_send and can never enter this function.
create or replace function public.patient_chat_apply(
 p_patient_id uuid,p_thread text,p_messages jsonb default '[]'::jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare v_conversation_id uuid; v_provider_id text;
begin
 if p_thread not in ('coach','support') then raise exception 'invalid thread %',p_thread; end if;
 select provider_id into v_provider_id from public.patients where id=p_patient_id;
 perform private.assert_care_team_patient_writable(p_patient_id,v_provider_id);
 insert into public.patient_chat_conversations(patient_id,thread)
 values(p_patient_id,p_thread)
 on conflict(patient_id,thread) where thread in ('coach','support')
 do update set updated_at=clock_timestamp() returning id into v_conversation_id;
 insert into public.patient_chat_messages
  (conversation_id,client_id,role,text,stopped,hidden,card,quick_replies,reply_to_client_id,photo,created_at,updated_at)
 select v_conversation_id,r.client_id,r.role,coalesce(r.text,''),coalesce(r.stopped,false),
  coalesce(r.hidden,false),r.card,r.quick_replies,r.reply_to_client_id,r.photo,clock_timestamp(),clock_timestamp()
 from jsonb_to_recordset(coalesce(p_messages,'[]'::jsonb)) as r(
  client_id text,role text,text text,stopped boolean,hidden boolean,card jsonb,
  quick_replies jsonb,reply_to_client_id text,photo jsonb)
 on conflict(conversation_id,client_id) do update set text=excluded.text,stopped=excluded.stopped,
  hidden=excluded.hidden,card=excluded.card,quick_replies=excluded.quick_replies,
  reply_to_client_id=excluded.reply_to_client_id,photo=excluded.photo,updated_at=clock_timestamp();
end $$;
revoke all on function public.patient_chat_apply(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.patient_chat_apply(uuid,text,jsonb) to service_role;

-- Insert lifecycle predicates into the canonical paginated query itself, so
-- filtering happens before count/offset/limit (never as an API-side overlay).
do $$
declare v_signature regprocedure :=
 'public.patient_chat_inbox_list(text,uuid,text[],text,text,boolean,text,text,integer,integer,uuid,timestamptz,uuid)'::regprocedure;
 v_definition text; v_needle text := 'where not coalesce(scoped_pr.access_disabled,false) and (';
begin
 select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
 if pg_catalog.strpos(v_definition,v_needle)=0 then
   raise exception 'patient_chat_inbox_list lifecycle insertion point not found';
 end if;
 v_definition:=pg_catalog.replace(v_definition,v_needle,
  'where p.archived_at is null and p.deletion_requested_at is null
   and p.activation_status <> ''disabled''
   and exists(select 1 from public.patient_consents lifecycle_pc
    where lifecycle_pc.patient_id=p.id and lifecycle_pc.policy_version=''2026-09-01''
      and lifecycle_pc.terms_accepted and lifecycle_pc.privacy_accepted
      and lifecycle_pc.health_data_accepted)
   and not coalesce(scoped_pr.access_disabled,false) and (');
 execute v_definition;
end $$;

-- Wrapper filters lifecycle-unavailable patients before pagination results are
-- returned. Its signature mirrors the inbox RPC consumed by the API.
create or replace function public.patient_chat_inbox_list_guarded(
 p_provider_id text,p_staff_user_id uuid,p_threads text[],p_status text,p_assignee text,
 p_unread_only boolean,p_q text,p_sort text,p_limit integer,p_offset integer,
 p_conversation_id uuid,p_auto_close_before timestamptz,p_patient_id uuid
) returns table (
 id uuid,patient_id uuid,patient_name text,thread text,status text,auto_closed boolean,
 assignee_user_id uuid,assignee_label text,message_count bigint,last_message_at timestamptz,
 last_patient_message_at timestamptz,last_staff_reply_at timestamptz,preview text,unread boolean,
 note_count bigint,open_escalation_id uuid,open_escalation_department text,created_at timestamptz,total bigint
) language sql stable security definer set search_path='' as $$
 select l.* from public.patient_chat_inbox_list(p_provider_id,p_staff_user_id,p_threads,p_status,
  p_assignee,p_unread_only,p_q,p_sort,p_limit,p_offset,p_conversation_id,p_auto_close_before,p_patient_id) l
 join public.patients p on p.id=l.patient_id
 where p.archived_at is null and p.deletion_requested_at is null and p.activation_status<>'disabled'
   and exists(select 1 from public.patient_consents pc where pc.patient_id=p.id
    and pc.policy_version='2026-09-01' and pc.terms_accepted and pc.privacy_accepted and pc.health_data_accepted)
$$;
revoke all on function public.patient_chat_inbox_list_guarded(text,uuid,text[],text,text,boolean,text,text,integer,integer,uuid,timestamptz,uuid)
 from public,anon,authenticated;
grant execute on function public.patient_chat_inbox_list_guarded(text,uuid,text[],text,text,boolean,text,text,integer,integer,uuid,timestamptz,uuid)
 to service_role;