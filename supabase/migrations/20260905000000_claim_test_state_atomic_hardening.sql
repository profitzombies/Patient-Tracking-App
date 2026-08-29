-- Harden the test handoff against cross-table contact races.  The locks are
-- deliberately explicit: every relation that can introduce a colliding
-- contact is held SHARE ROW EXCLUSIVE until this transaction commits.

drop function if exists public.claim_test_state_restore(uuid, uuid, text, text, uuid, timestamptz, text);

create or replace function public.claim_test_state_inspect(
  p_patient_id uuid,
  p_owner_auth_user_id uuid,
  p_approved_phone text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('collision',
    exists (select 1 from public.profiles where id = p_owner_auth_user_id)
    or public.claim_test_state_collision(p_patient_id, p_owner_auth_user_id, p_approved_phone)
  );
$$;

create or replace function public.claim_test_state_prepare(
  p_patient_id uuid,
  p_owner_auth_user_id uuid,
  p_approved_phone text,
  p_scenario text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.patients%rowtype;
  chosen_identifier text;
  chosen_mode text;
begin
  if p_patient_id <> '93c85218-e8c2-409a-966b-a8a5bd98cdbb'::uuid
     or p_scenario not in ('claim_phone', 'recover_phone', 'claim_email', 'recover_email') then
    raise exception 'invalid claim test state request' using errcode = '22023';
  end if;

  lock table public.patients, public.providers, public.team_members,
    public.profiles, public.staff_role_assignments, public.role_assignments,
    public.claim_verifications, auth.users in share row exclusive mode;

  select * into target from public.patients
  where id = p_patient_id and auth_user_id = p_owner_auth_user_id
  for update;
  if not found then
    raise exception 'claim test state owner mismatch' using errcode = '42501';
  end if;
  if target.email is null or trim(target.email) = '' then
    raise exception 'claim test patient email missing' using errcode = '23514';
  end if;
  -- An owner profile would cascade on auth.users deletion, so it is unsafe
  -- even if it contains no colliding email or phone.
  if exists (select 1 from public.profiles where id = p_owner_auth_user_id)
     or public.claim_test_state_collision(p_patient_id, p_owner_auth_user_id, p_approved_phone) then
    raise exception 'claim test state collision' using errcode = '23505';
  end if;

  chosen_identifier := case when p_scenario like '%_phone' then p_approved_phone else lower(trim(target.email)) end;
  chosen_mode := case when p_scenario like 'claim_%' then 'create' else 'reset' end;
  update public.patients
  set phone = case when p_scenario like '%_phone' then p_approved_phone else null end,
      auth_user_id = case when chosen_mode = 'create' then null else p_owner_auth_user_id end,
      claimed_at = case when chosen_mode = 'create' then null else coalesce(claimed_at, now()) end
  where id = p_patient_id;

  delete from public.claim_verifications
  where (identifier_kind = 'email' and lower(identifier) = lower(target.email))
     or (identifier_kind = 'phone' and right(regexp_replace(identifier, '\D', '', 'g'), 10)
           = right(regexp_replace(p_approved_phone, '\D', '', 'g'), 10));

  if chosen_mode = 'create' then
    delete from auth.users where id = p_owner_auth_user_id;
  end if;
  return jsonb_build_object('prepared', true, 'scenario', p_scenario,
    'identifier', chosen_identifier, 'mode', chosen_mode);
end;
$$;

revoke all on function public.claim_test_state_inspect(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_test_state_inspect(uuid, uuid, text) to service_role;
revoke all on function public.claim_test_state_prepare(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_test_state_prepare(uuid, uuid, text, text) to service_role;