-- Coach lifecycle privacy completion.
--
-- The shared work ledger's state/lease protocol is storage-owned.  Archiving
-- invalidates all outstanding work using that existing protocol; it does not
-- alter memory rows (including approved memory).  The generic chat-retention
-- sweep is narrowed so it cannot erase office-owned Care Team history.

create or replace function public.coach_conversation_archive(
  p_patient_id uuid,
  p_conversation_id uuid,
  p_archived boolean,
  p_expected_version integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.patient_chat_conversations%rowtype;
begin
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  select * into c
  from public.patient_chat_conversations
  where id = p_conversation_id
    and patient_id = p_patient_id
    and thread = 'coach'
  for update;
  if not found then
    return 'missing';
  end if;
  if c.version <> p_expected_version then
    return 'conflict';
  end if;

  update public.patient_chat_conversations
  set archived_at = case
        when p_archived then coalesce(archived_at, clock_timestamp())
        else null
      end,
      version = version + 1,
      updated_at = clock_timestamp()
  where id = c.id;

  if p_archived then
    -- `ready` is the storage-owned terminal state. A claimant must present a
    -- running lease to complete, so clearing it makes an in-flight worker
    -- harmless without widening the shared state enum.
    update public.coach_conversation_work
    set state = 'ready',
        lease_owner = null,
        lease_until = null,
        updated_at = clock_timestamp()
    where conversation_id = c.id
      and state in ('pending', 'running', 'failed');
  end if;
  return 'ok';
end;
$$;

create or replace function public.retention_trim_chat_transcripts(
  p_cutoff timestamptz,
  p_limit integer,
  p_dry_run boolean
)
returns table(messages_deleted integer, conversations_deleted integer, media_paths text[])
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_messages integer := 0;
  v_conversations integer := 0;
  v_paths text[] := array[]::text[];
begin
  if p_cutoff is null then
    raise exception 'cutoff is required';
  end if;
  create temp table if not exists retention_chat_candidates (
    conversation_id uuid, client_id text, photo_path text
  ) on commit drop;
  truncate retention_chat_candidates;

  insert into retention_chat_candidates (conversation_id, client_id, photo_path)
  select m.conversation_id, m.client_id, m.photo->>'path'
  from public.patient_chat_messages m
  join public.patient_chat_conversations c on c.id = m.conversation_id
  where m.created_at < p_cutoff
    and c.thread in ('coach', 'support')
    and not exists (
      select 1 from public.patient_deletion_requests d
      where d.patient_id = c.patient_id
        and d.status in ('pending', 'purging', 'failed')
    )
  order by m.created_at
  limit greatest(coalesce(p_limit, 1000), 1);

  select count(*)::integer into v_messages from retention_chat_candidates;
  if p_dry_run then
    select coalesce(array_agg(distinct cand.photo_path), array[]::text[])
    into v_paths
    from retention_chat_candidates cand
    where cand.photo_path is not null
      and not exists (
        select 1 from public.patient_chat_messages m2
        where m2.photo->>'path' = cand.photo_path
          and not exists (
            select 1 from retention_chat_candidates c2
            where c2.conversation_id = m2.conversation_id
              and c2.client_id = m2.client_id
          )
      );
    select count(*)::integer into v_conversations
    from public.patient_chat_conversations c
    where c.thread in ('coach', 'support')
      and c.updated_at < p_cutoff
      and not exists (
        select 1 from public.patient_chat_messages m
        where m.conversation_id = c.id
          and not exists (
            select 1 from retention_chat_candidates c2
            where c2.conversation_id = m.conversation_id
              and c2.client_id = m.client_id
          )
      );
    return query select v_messages, v_conversations, v_paths;
    return;
  end if;

  delete from public.patient_chat_messages m
  using retention_chat_candidates cand
  where m.conversation_id = cand.conversation_id
    and m.client_id = cand.client_id;

  with removed as (
    delete from public.patient_media pm
    where pm.kind = 'chat'
      and pm.object_path in (
        select cand.photo_path from retention_chat_candidates cand where cand.photo_path is not null
      )
      and not exists (
        select 1 from public.patient_chat_messages m where m.photo->>'path' = pm.object_path
      )
    returning pm.object_path
  )
  select coalesce(array_agg(object_path), array[]::text[]) into v_paths from removed;

  with gone as (
    delete from public.patient_chat_conversations c
    where c.thread in ('coach', 'support')
      and c.updated_at < p_cutoff
      and not exists (
        select 1 from public.patient_chat_messages m where m.conversation_id = c.id
      )
      and not exists (
        select 1 from public.patient_deletion_requests d
        where d.patient_id = c.patient_id and d.status in ('pending', 'purging', 'failed')
      )
    returning 1
  )
  select count(*)::integer into v_conversations from gone;
  return query select v_messages, v_conversations, v_paths;
end;
$$;

revoke all on function public.coach_conversation_archive(uuid,uuid,boolean,integer),
  public.retention_trim_chat_transcripts(timestamptz,integer,boolean)
  from public, anon, authenticated;
grant execute on function public.coach_conversation_archive(uuid,uuid,boolean,integer),
  public.retention_trim_chat_transcripts(timestamptz,integer,boolean)
  to service_role;

select private.install_patient_identity_write_guards();