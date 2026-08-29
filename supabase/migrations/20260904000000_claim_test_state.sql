-- Owner-only claim handoff fixture reset. The API authenticates the owner;
-- these service-role-only functions re-check linkage and make the data reset
-- atomic before the API changes or removes the corresponding Auth user.

create or replace function public.claim_test_state_collision(
  p_patient_id uuid,
  p_owner_auth_user_id uuid,
  p_approved_phone text
) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  target public.patients%rowtype;
  email_value text;
  phone_digits text := right(regexp_replace(p_approved_phone, '\D', '', 'g'), 10);
begin
  select * into target
  from public.patients
  where id = p_patient_id and auth_user_id = p_owner_auth_user_id;
  if not found then
    raise exception 'claim test state owner mismatch' using errcode = '42501';
  end if;
  email_value := nullif(lower(trim(coalesce(target.email, ''))), '');

  return
    exists (
      select 1 from public.patients p
      where p.id <> p_patient_id and (
        (email_value is not null and lower(trim(coalesce(p.email, ''))) = email_value)
        or right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = phone_digits
      )
    )
    or exists (
      select 1 from public.providers p
      where email_value is not null and lower(trim(coalesce(p.email, ''))) = email_value
    )
    or exists (
      select 1 from public.team_members t
      where email_value is not null and lower(trim(coalesce(t.email, ''))) = email_value
    )
    or exists (
      select 1 from public.profiles p
      where p.id <> p_owner_auth_user_id and (
        (email_value is not null and lower(trim(coalesce(p.email, ''))) = email_value)
        or right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = phone_digits
      )
    )
    or exists (
      select 1 from public.staff_role_assignments a
      where email_value is not null and lower(trim(coalesce(a.email, ''))) = email_value
    )
    or exists (
      select 1 from public.role_assignments a
      where (email_value is not null and lower(trim(coalesce(a.email, ''))) = email_value)
         or right(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g'), 10) = phone_digits
    )
    or exists (
      select 1 from auth.users u
      where u.id <> p_owner_auth_user_id and (
        (email_value is not null and lower(trim(coalesce(u.email, ''))) = email_value)
        or right(regexp_replace(coalesce(u.phone, ''), '\D', '', 'g'), 10) = phone_digits
      )
    );
end;
$$;

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
  select jsonb_build_object(
    'collision',
    public.claim_test_state_collision(p_patient_id, p_owner_auth_user_id, p_approved_phone)
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
  if p_scenario not in ('claim_phone', 'recover_phone', 'claim_email', 'recover_email') then
    raise exception 'invalid claim test scenario' using errcode = '22023';
  end if;

  select * into target from public.patients
  where id = p_patient_id and auth_user_id = p_owner_auth_user_id
  for update;
  if not found then
    raise exception 'claim test state owner mismatch' using errcode = '42501';
  end if;
  if target.email is null or trim(target.email) = '' then
    raise exception 'claim test patient email missing' using errcode = '23514';
  end if;
  if public.claim_test_state_collision(p_patient_id, p_owner_auth_user_id, p_approved_phone) then
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
     or (
       identifier_kind = 'phone'
       and right(regexp_replace(identifier, '\D', '', 'g'), 10)
           = right(regexp_replace(p_approved_phone, '\D', '', 'g'), 10)
     );

  return jsonb_build_object(
    'prepared', true,
    'scenario', p_scenario,
    'identifier', chosen_identifier,
    'mode', chosen_mode
  );
end;
$$;

create or replace function public.claim_test_state_restore(
  p_patient_id uuid,
  p_owner_auth_user_id uuid,
  p_scenario text,
  p_prior_phone text,
  p_prior_auth_user_id uuid,
  p_prior_claimed_at timestamptz,
  p_approved_phone text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_phone text;
  expected_auth uuid;
begin
  if p_scenario not in ('claim_phone', 'recover_phone', 'claim_email', 'recover_email')
     or p_prior_auth_user_id is distinct from p_owner_auth_user_id then
    raise exception 'invalid claim test state restoration' using errcode = '22023';
  end if;
  expected_phone := case when p_scenario like '%_phone' then p_approved_phone else null end;
  expected_auth := case when p_scenario like 'claim_%' then null else p_owner_auth_user_id end;

  -- Restore only a state this API's prepare RPC could have produced. This
  -- prevents this narrowly scoped internal compensator from becoming a
  -- general patient-record editing primitive.
  if not exists (
    select 1 from public.patients
    where id = p_patient_id
      and auth_user_id is not distinct from expected_auth
      and phone is not distinct from expected_phone
  ) then
    raise exception 'claim test state no longer eligible for restoration' using errcode = '23505';
  end if;

  update public.patients
  set phone = p_prior_phone,
      auth_user_id = p_prior_auth_user_id,
      claimed_at = p_prior_claimed_at
  where id = p_patient_id;
  return jsonb_build_object('restored', true);
end;
$$;

revoke all on function public.claim_test_state_collision(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_test_state_inspect(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_test_state_prepare(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_test_state_restore(uuid, uuid, text, text, uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_test_state_inspect(uuid, uuid, text) to service_role;
grant execute on function public.claim_test_state_prepare(uuid, uuid, text, text) to service_role;
grant execute on function public.claim_test_state_restore(uuid, uuid, text, text, uuid, timestamptz, text) to service_role;