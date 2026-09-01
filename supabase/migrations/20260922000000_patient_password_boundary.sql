-- Password credentials belong exclusively to GoTrue.  This trigger is kept
-- intentionally small and does not inspect, log, or count the removed value.
alter table public.claim_verifications
  drop constraint if exists claim_verifications_purpose_check;
alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array['claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text, 'recovery'::text]));

create or replace function private.strip_patient_flag_password()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.onboarding_answers is not null and jsonb_typeof(new.onboarding_answers) = 'object' then
    new.onboarding_answers := new.onboarding_answers - 'password';
  end if;
  return new;
end;
$$;

drop trigger if exists patient_flags_strip_password on public.patient_flags;
create trigger patient_flags_strip_password
before insert or update of onboarding_answers on public.patient_flags
for each row execute function private.strip_patient_flag_password();

update public.patient_flags
set onboarding_answers = onboarding_answers - 'password'
where jsonb_typeof(onboarding_answers) = 'object'
  and onboarding_answers ? 'password';

revoke all on function private.strip_patient_flag_password() from public;