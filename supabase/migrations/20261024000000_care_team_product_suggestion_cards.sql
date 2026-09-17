drop function if exists public.care_team_send(uuid,uuid,text,text,text,text,uuid,text,boolean);

create or replace function public.care_team_send(
  p_conversation_id uuid, p_patient_id uuid, p_provider_id text,
  p_client_id text, p_text text, p_role text, p_sender_user_id uuid default null,
  p_sender_label text default null, p_enqueue_push boolean default false,
  p_card jsonb default null, p_push_body text default null
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
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
       or v_m.card is distinct from p_card
      then raise exception using errcode='23505', message='client id payload conflict'; end if;
  else
    insert into public.patient_chat_messages
      (conversation_id,client_id,role,text,sender_user_id,sender_label,card)
      values(p_conversation_id,p_client_id,p_role,p_text,p_sender_user_id,p_sender_label,p_card)
      returning * into v_m;
    v_created := true;
    if p_enqueue_push and p_role='staff' then
      insert into public.patient_notifications
        (patient_id,kind,category,title,body,data,dedupe_key)
      values (p_patient_id,'care_team_reply','office_reminders',
        'A message from your care team',coalesce(p_push_body,'You have a new care team message.'),
        jsonb_build_object('patientId',p_patient_id,'thread','care_team',
          'conversationId',p_conversation_id,'providerId',p_provider_id)
          || case when p_card is not null then jsonb_build_object('suggestion',true) else '{}'::jsonb end,
        'care_team_reply:'||p_conversation_id::text||':'||p_client_id)
      on conflict(dedupe_key) do nothing;
    end if;
  end if;
  return jsonb_build_object('created',v_created,'seq',v_m.seq,'clientId',v_m.client_id,
    'role',v_m.role,'text',v_m.text,'createdAt',v_m.created_at);
end $$;

revoke all on function public.care_team_send(uuid,uuid,text,text,text,text,uuid,text,boolean,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.care_team_send(uuid,uuid,text,text,text,text,uuid,text,boolean,jsonb,text)
  to service_role;