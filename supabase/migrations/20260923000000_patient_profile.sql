-- Canonical patient profile and verified contact-change transaction.
--
-- The patients row remains the one canonical clinical/directory record.  The
-- older name/height columns are retained for compatibility, but all new reads
-- use the typed columns below.  Contact changes are committed in the same
-- transaction as the matching GoTrue identifier so a failed uniqueness check
-- can never leave a patient unable to use the credential they had before.

alter table public.patients
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists height_inches numeric,
  add column if not exists gender text,
  add column if not exists height_unit text,
  add column if not exists height_cm numeric,
  add column if not exists email_verified_at timestamptz,
  add column if not exists phone_verified_at timestamptz,
  add column if not exists profile_completed_at timestamptz,
  add column if not exists profile_updated_at timestamptz;

update public.patients
set
  first_name = coalesce(
    nullif(btrim(first_name), ''),
    nullif(split_part(btrim(coalesce(name, '')), ' ', 1), '')
  ),
  last_name = coalesce(
    nullif(btrim(last_name), ''),
    nullif(btrim(regexp_replace(btrim(coalesce(name, '')), '^\S+\s*', '')), '')
  )
where first_name is null or last_name is null;

alter table public.patients
  drop constraint if exists patients_first_name_length_check,
  add constraint patients_first_name_length_check
    check (first_name is null or length(btrim(first_name)) between 1 and 80) not valid,
  drop constraint if exists patients_last_name_length_check,
  add constraint patients_last_name_length_check
    check (last_name is null or length(btrim(last_name)) between 1 and 80) not valid,
  drop constraint if exists patients_height_inches_check,
  add constraint patients_height_inches_check
    check (height_inches is null or height_inches between 24 and 96) not valid,
  drop constraint if exists patients_starting_weight_check,
  add constraint patients_starting_weight_check
    check (starting_weight is null or starting_weight between 40 and 1500) not valid,
  drop constraint if exists patients_current_weight_check,
  add constraint patients_current_weight_check
    check (current_weight is null or current_weight between 40 and 1500) not valid,
  drop constraint if exists patients_goal_weight_check,
  add constraint patients_goal_weight_check
    check (goal_weight is null or goal_weight between 40 and 1500) not valid,
  drop constraint if exists patients_gender_check,
  add constraint patients_gender_check
    check (gender is null or gender in ('male', 'female')) not valid,
  drop constraint if exists patients_height_unit_check,
  add constraint patients_height_unit_check
    check (height_unit is null or height_unit in ('imperial', 'metric')) not valid,
  drop constraint if exists patients_height_cm_check,
  add constraint patients_height_cm_check
    check (height_cm is null or height_cm between 60 and 245) not valid;

alter table public.claim_verifications
  drop constraint if exists claim_verifications_purpose_check;
alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array[
    'claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text,
    'recovery'::text, 'profile_email'::text, 'profile_phone'::text
  ]));

-- A patient changing their verified email must never inherit a staff
-- pre-approval for that address. This trigger is deferred, so it sees the
-- account's final claim metadata after the contact transaction commits.
create or replace function public.handle_new_thinnr_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  u auth.users%rowtype;
  assignment public.staff_role_assignments%rowtype;
  v_approved boolean;
  v_provisioned boolean;
  v_claim text;
begin
  select * into u from auth.users where id = new.id;
  if not found then return new; end if;

  v_claim := coalesce(u.raw_app_meta_data ->> 'thinnr_claim', '');
  if v_claim = 'patient' then
    return new;
  end if;
  if v_claim <> '' and not exists (
    select 1
    from public.staff_role_assignments a
    where lower(a.email) = lower(coalesce(u.email, ''))
      and a.role = 'hq_admin'::public.app_role
  ) then
    return new;
  end if;

  insert into public.profiles (id, role, display_name, email, phone)
  values (
    u.id,
    'patient'::public.app_role,
    nullif(coalesce(u.raw_user_meta_data ->> 'display_name', ''), ''),
    u.email,
    u.phone
  )
  on conflict (id) do update
    set display_name = coalesce(excluded.display_name, public.profiles.display_name),
        email = excluded.email,
        phone = excluded.phone;

  select *
  into assignment
  from public.staff_role_assignments
  where lower(email) = lower(coalesce(u.email, ''));
  v_approved := found;
  v_provisioned := coalesce(u.raw_app_meta_data ->> 'thinnr_provisioned', '') = 'true'
    or v_claim <> '';

  update public.profiles
  set role = case
        when v_approved and v_provisioned and u.email_confirmed_at is not null then assignment.role
        else 'patient'::public.app_role
      end,
      provider_account_code = case
        when v_approved and v_provisioned and u.email_confirmed_at is not null then assignment.provider_account_code
        else null
      end
  where id = u.id;

  if v_approved
    and v_provisioned
    and u.email_confirmed_at is not null
    and assignment.role = 'provider_staff'::public.app_role
  then
    perform private.link_staff_training_viewer(
      u.id,
      u.email,
      nullif(coalesce(u.raw_user_meta_data ->> 'display_name', ''), ''),
      assignment.provider_account_code
    );
  end if;

  return new;
end;
$$;

create or replace function public.patient_apply_verified_contact(
  p_patient_id uuid,
  p_auth_user_id uuid,
  p_verification_id uuid
)
returns public.patients
language plpgsql
security definer
set search_path = ''
as $$
declare
  patient public.patients%rowtype;
  verification public.claim_verifications%rowtype;
  auth_email text;
  auth_phone text;
  result public.patients%rowtype;
begin
  select * into patient
  from public.patients p
  where p.id = p_patient_id
    and p.auth_user_id = p_auth_user_id
    and p.archived_at is null
  for update;
  if not found then raise exception 'patient contact owner mismatch'; end if;

  select * into verification
  from public.claim_verifications v
  where v.id = p_verification_id
    and v.auth_user_id = p_auth_user_id
    and v.purpose in ('profile_email', 'profile_phone')
    and v.verified_at is null
    and v.consumed_at is null
    and v.code_expires_at >= clock_timestamp()
  for update;
  if not found then raise exception 'verification is not eligible'; end if;

  select u.email, u.phone into auth_email, auth_phone
  from auth.users u where u.id = p_auth_user_id
  for update;
  if not found then raise exception 'patient login no longer exists'; end if;

  if verification.purpose = 'profile_email' then
    -- Synthetic patient email is the stable password credential.  Only
    -- replace GoTrue email where this account actually used the old contact
    -- email as its login; otherwise preserving it is what prevents stranding.
    if auth_email is not distinct from patient.email then
      update auth.users
      set email = verification.identifier,
          email_confirmed_at = coalesce(email_confirmed_at, clock_timestamp()),
          updated_at = clock_timestamp()
      where id = p_auth_user_id;
      -- GoTrue's email-login identity has its own cached identity_data. Keep
      -- it synchronized inside this same transaction; otherwise password/OAuth
      -- identity lookup can retain a stale email even though auth.users changed.
      update auth.identities
      set identity_data = jsonb_set(
            coalesce(identity_data, '{}'::jsonb),
            '{email}',
            to_jsonb(verification.identifier),
            true
          ),
          updated_at = clock_timestamp()
      where user_id = p_auth_user_id and provider = 'email';
    end if;
    update public.patients
    set email = verification.identifier,
        email_verified_at = clock_timestamp(),
        profile_updated_at = clock_timestamp()
    where id = patient.id
    returning * into result;
  else
    -- A phone absent from GoTrue may be installed now.  A shared staff/patient
    -- phone can legitimately make this unique update fail; the whole
    -- transaction then rolls back, retaining both old identifiers.
    if auth_phone is null
      or right(regexp_replace(auth_phone, '\D', '', 'g'), 10)
         = right(regexp_replace(coalesce(patient.phone, ''), '\D', '', 'g'), 10)
      or right(regexp_replace(auth_phone, '\D', '', 'g'), 10)
         = right(regexp_replace(verification.identifier, '\D', '', 'g'), 10)
    then
      update auth.users
      set phone = verification.identifier,
          phone_confirmed_at = coalesce(phone_confirmed_at, clock_timestamp()),
          updated_at = clock_timestamp()
      where id = p_auth_user_id;
      -- The phone identity is likewise a GoTrue login lookup record, not just
      -- metadata. Synchronize it transactionally with auth.users and patients.
      update auth.identities
      set identity_data = jsonb_set(
            coalesce(identity_data, '{}'::jsonb),
            '{phone}',
            to_jsonb(verification.identifier),
            true
          ),
          updated_at = clock_timestamp()
      where user_id = p_auth_user_id and provider = 'phone';
    else
      raise exception 'patient login phone does not match canonical phone';
    end if;
    update public.patients
    set phone = verification.identifier,
        phone_verified_at = clock_timestamp(),
        profile_updated_at = clock_timestamp()
    where id = patient.id
    returning * into result;
  end if;

  update public.claim_verifications
  set verified_at = clock_timestamp(),
      consumed_at = clock_timestamp()
  where id = verification.id and consumed_at is null;
  if not found then raise exception 'verification was already consumed'; end if;
  return result;
end;
$$;

revoke all on function public.patient_apply_verified_contact(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.patient_apply_verified_contact(uuid, uuid, uuid)
  to service_role;

-- One transaction for onboarding/setup: patient profile and the account flags
-- are logically one state transition. The API validates and whitelists the
-- JSON keys before this function is called; this function owns atomicity.
create or replace function public.patient_apply_profile_setup(
  p_patient_id uuid,
  p_auth_user_id uuid,
  p_profile jsonb,
  p_onboarding_answers jsonb,
  p_notification_prefs jsonb default null,
  p_complete boolean default false
)
returns public.patients
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.patients%rowtype;
begin
  if jsonb_typeof(p_profile) <> 'object'
    or jsonb_typeof(p_onboarding_answers) <> 'object'
    or (p_notification_prefs is not null and jsonb_typeof(p_notification_prefs) <> 'object')
  then raise exception 'profile setup payload is invalid'; end if;

  update public.patients p
  set
    first_name = case when p_profile ? 'first_name' then nullif(btrim(p_profile ->> 'first_name'), '') else p.first_name end,
    last_name = case when p_profile ? 'last_name' then nullif(btrim(p_profile ->> 'last_name'), '') else p.last_name end,
    name = case when p_profile ? 'name' then p_profile ->> 'name' else p.name end,
    date_of_birth = case when p_profile ? 'date_of_birth' then (p_profile ->> 'date_of_birth')::date else p.date_of_birth end,
    gender = case when p_profile ? 'gender' then p_profile ->> 'gender' else p.gender end,
    height_unit = case when p_profile ? 'height_unit' then p_profile ->> 'height_unit' else p.height_unit end,
    height_cm = case when p_profile ? 'height_cm' then (p_profile ->> 'height_cm')::numeric else p.height_cm end,
    height_inches = case when p_profile ? 'height_inches' then (p_profile ->> 'height_inches')::numeric else p.height_inches end,
    starting_weight = case when p_profile ? 'starting_weight' then (p_profile ->> 'starting_weight')::numeric else p.starting_weight end,
    current_weight = case when p_profile ? 'current_weight' then (p_profile ->> 'current_weight')::numeric else p.current_weight end,
    goal_weight = case when p_profile ? 'goal_weight' then (p_profile ->> 'goal_weight')::numeric else p.goal_weight end,
    timezone = case when p_profile ? 'timezone' then p_profile ->> 'timezone' else p.timezone end,
    program_id = case when p_profile ? 'program_id' then p_profile ->> 'program_id' else p.program_id end,
    program_start_date = case when p_profile ? 'program_start_date' then (p_profile ->> 'program_start_date')::date else p.program_start_date end,
    profile_updated_at = clock_timestamp(),
    profile_completed_at = case when p_complete then clock_timestamp() else p.profile_completed_at end
  where p.id = p_patient_id and p.auth_user_id = p_auth_user_id and p.archived_at is null
  returning p.* into result;
  if not found then raise exception 'patient profile owner mismatch'; end if;

  if p_complete and (
    nullif(btrim(coalesce(result.first_name, '')), '') is null
    or nullif(btrim(coalesce(result.last_name, '')), '') is null
    or nullif(btrim(coalesce(result.email, '')), '') is null
    or nullif(btrim(coalesce(result.phone, '')), '') is null
    or result.date_of_birth is null
    or result.date_of_birth < current_date - interval '120 years'
    or result.date_of_birth > current_date - interval '18 years'
    or result.height_inches is null
    or result.starting_weight is null
    or result.current_weight is null
    or result.goal_weight is null
    or nullif(btrim(coalesce(result.timezone, '')), '') is null
    or result.program_id not in ('thinnr', 'glp1', 'none')
    or (result.program_id in ('thinnr', 'glp1') and result.program_start_date is null)
  ) then
    raise exception 'completed patient setup is missing required canonical fields';
  end if;

  insert into public.patient_flags (
    patient_id, onboarding_answers, notification_prefs, onboarding_complete, updated_at
  ) values (
    p_patient_id,
    p_onboarding_answers - 'password',
    p_notification_prefs,
    p_complete,
    clock_timestamp()
  )
  on conflict (patient_id) do update set
    onboarding_answers = excluded.onboarding_answers,
    notification_prefs = coalesce(excluded.notification_prefs, public.patient_flags.notification_prefs),
    onboarding_complete = case when p_complete then true else public.patient_flags.onboarding_complete end,
    updated_at = excluded.updated_at;
  return result;
end;
$$;

revoke all on function public.patient_apply_profile_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.patient_apply_profile_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean)
  to service_role;