-- Coach conversation titles: model-written names from the first message, and
-- patient renames that the title job must never overwrite.
--
-- title_source: 'system' (job-written, may be replaced by the job) or
-- 'patient' (chosen by the patient; the job leaves it alone).

alter table public.patient_chat_conversations
  add column if not exists title_source text not null default 'system';
alter table public.patient_chat_conversations
  drop constraint if exists patient_chat_conversations_title_source_check,
  add constraint patient_chat_conversations_title_source_check
    check (title_source in ('system', 'patient'));

-- Shared shape rule for any stored title: trimmed, single-spaced, 1..40
-- characters, no control characters. Returns null when the input is unusable.
create or replace function private.coach_clean_title(p_title text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_title is null then null
    when cleaned = '' or char_length(cleaned) > 40 or cleaned ~ '[\x00-\x1f\x7f]' then null
    else cleaned
  end
  from (select btrim(regexp_replace(p_title, '\s+', ' ', 'g')) as cleaned) t
$$;
revoke all on function private.coach_clean_title(text) from public, anon, authenticated;

-- The job now writes any well-formed title (the model composes it from the
-- first message); a patient-chosen title is never replaced.
create or replace function public.coach_title_complete_processing(
  p_work_id uuid, p_patient_id uuid, p_conversation_id uuid, p_claim_token text, p_title text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare w public.coach_conversation_work%rowtype; v_title text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_patient_id::text, 40421001));
  select * into w from public.coach_conversation_work where id = p_work_id for update;
  if not found or w.kind <> 'title' or w.patient_id <> p_patient_id or w.conversation_id <> p_conversation_id
    or w.state <> 'running' or w.lease_owner <> p_claim_token or w.lease_until < now() then return false; end if;
  if not exists (
    select 1 from public.patient_chat_conversations c join public.patients p on p.id = c.patient_id
    where c.id = p_conversation_id and c.patient_id = p_patient_id and c.thread = 'coach'
      and c.archived_at is null and p.archived_at is null
  ) then return false; end if;
  v_title := coalesce(private.coach_clean_title(p_title), 'Coach conversation');
  update public.patient_chat_conversations
  set title = case when title_source = 'patient' then title else v_title end,
      title_state = 'ready', processing_state = 'ready'
  where id = p_conversation_id and patient_id = p_patient_id;
  update public.coach_conversation_work
  set state = 'ready', lease_owner = null, lease_until = null, updated_at = now() where id = p_work_id;
  return true;
end $$;

create or replace function public.coach_conversation_rename(
  p_patient_id uuid, p_conversation_id uuid, p_title text, p_expected_version integer
) returns text language plpgsql security definer set search_path = '' as $$
declare c public.patient_chat_conversations%rowtype; v_title text;
begin
  perform private.assert_care_team_patient_writable(
    p_patient_id, (select p.provider_id from public.patients p where p.id = p_patient_id)
  );
  v_title := private.coach_clean_title(p_title);
  if v_title is null then return 'invalid'; end if;
  select * into c from public.patient_chat_conversations
  where id = p_conversation_id and patient_id = p_patient_id and thread = 'coach' for update;
  if not found then return 'missing'; end if;
  if c.version <> p_expected_version then return 'conflict'; end if;
  update public.patient_chat_conversations
  set title = v_title, title_source = 'patient', title_state = 'ready',
      version = version + 1, updated_at = clock_timestamp()
  where id = c.id;
  return 'ok';
end $$;

revoke all on function public.coach_conversation_rename(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.coach_conversation_rename(uuid, uuid, text, integer) to service_role;
