-- Replay-safe replacement: align workflow writes with the global
-- patient -> office -> row lock order and preserve retained-thread ownership.
create or replace function public.patient_chat_workflow_mutate(
 p_conversation_id uuid,p_provider_id text,p_actor_user_id uuid,p_actor_kind text,
 p_action text,p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.patient_chat_conversations%rowtype;
 p public.patients%rowtype;
 v_patient_id uuid; v_thread text; v_retained_provider text; v_current_provider text;
 v_owner_provider text; v_label text; v_id uuid; v_department text;
begin
 -- Metadata reads deliberately take no row locks. Immutable conversation
 -- ownership lets us choose the canonical advisory locks before row locking.
 select pc.patient_id,pc.thread,pc.provider_id,p0.provider_id
 into v_patient_id,v_thread,v_retained_provider,v_current_provider
 from public.patient_chat_conversations pc
 join public.patients p0 on p0.id=pc.patient_id
 where pc.id=p_conversation_id;
 if not found then raise exception 'conversation unavailable'; end if;
 v_owner_provider:=case when v_thread='care_team' then v_retained_provider else v_current_provider end;
 if v_owner_provider is distinct from p_provider_id then raise exception 'conversation unavailable'; end if;

 perform pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended(v_patient_id::text,40421001));
 perform pg_catalog.pg_advisory_xact_lock(
   pg_catalog.hashtextextended('care-team-office:'||p_provider_id,0));

 -- All row locks happen only after both advisory locks.
 select * into p from public.patients where id=v_patient_id for update;
 if not found or p.archived_at is not null or p.deletion_requested_at is not null
    or p.activation_status='disabled' then raise exception 'patient unavailable'; end if;
 if v_thread<>'care_team' and p.provider_id is distinct from p_provider_id
 then raise exception 'conversation unavailable'; end if;
 if not exists(select 1 from public.providers pr where pr.provider_id=p_provider_id
   and not coalesce(pr.access_disabled,false) for share)
   or private.provider_account_is_locked(p_provider_id) then raise exception 'office unavailable'; end if;
 select * into c from public.patient_chat_conversations
 where id=p_conversation_id and patient_id=v_patient_id
   and thread=v_thread and (thread<>'care_team' or provider_id=p_provider_id)
 for update;
 if not found then raise exception 'conversation unavailable'; end if;
 if not exists(select 1 from public.patient_consents pc where pc.patient_id=p.id
   and pc.policy_version='2026-09-01' and pc.terms_accepted and pc.privacy_accepted
   and pc.health_data_accepted) then raise exception 'consent required'; end if;

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
    (p_actor_kind='hq' and c.thread<>'care_team'
      and (p_payload->>'assigneeUserId')::uuid=p_actor_user_id)
    or exists(select 1 from public.providers ap where ap.provider_id=p_provider_id
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
   update public.patient_chat_conversations set status=p_payload->>'status',
    updated_at=clock_timestamp() where id=c.id;
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
   insert into public.patient_chat_escalations
    (conversation_id,provider_id,department,reason,created_by,created_by_label)
   values(c.id,p_provider_id,v_department,trim(p_payload->>'reason'),p_actor_user_id,v_label)
   returning id into v_id;
   return jsonb_build_object('id',v_id);
 end if;
 raise exception 'invalid workflow action';
end $$;
revoke all on function public.patient_chat_workflow_mutate(uuid,text,uuid,text,text,jsonb)
 from public,anon,authenticated;
grant execute on function public.patient_chat_workflow_mutate(uuid,text,uuid,text,text,jsonb)
 to service_role;