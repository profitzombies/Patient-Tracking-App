-- patient_chat_apply returns the conversation it wrote into.
--
-- The legacy thread endpoint (/patient-chat/coach/messages) has no
-- conversation id of its own: the RPC resolves the patient's deterministic
-- legacy coach conversation. HQ Insights now keys coach_message events on
-- <conversation_id>:<client_id> so a replayed transcript inserts nothing, and
-- the route needs that id back to build the key. Returning it changes the
-- signature (void -> uuid), hence the drop. Body is otherwise identical.

drop function if exists public.patient_chat_apply(uuid, text, jsonb);

create function public.patient_chat_apply(
  p_patient_id uuid, p_thread text, p_messages jsonb default '[]'::jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_conversation_id uuid; v_result text;
begin
  if p_thread = 'coach' then
    v_conversation_id := public.coach_legacy_conversation_id(p_patient_id);
    v_result := public.coach_conversation_append(p_patient_id, v_conversation_id, p_messages);
    if v_result <> 'ok' then raise exception 'legacy coach append failed'; end if;
    return v_conversation_id;
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
  return v_conversation_id;
end $$;
comment on function public.patient_chat_apply(uuid, text, jsonb) is
  'Legacy thread upsert (coach = deterministic legacy conversation, support = the support thread). Returns the conversation id written.';
revoke all on function public.patient_chat_apply(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.patient_chat_apply(uuid, text, jsonb) to service_role;
