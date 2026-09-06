-- Keep office scope true at the persistence boundary, not only in API checks.
create unique index if not exists patients_id_provider_unique_idx
  on public.patients(id, provider_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.patient_operational_follow_ups'::regclass
      and conname = 'patient_operational_follow_ups_patient_provider_fk'
  ) then
    alter table public.patient_operational_follow_ups
      add constraint patient_operational_follow_ups_patient_provider_fk
      foreign key (patient_id, provider_id)
      references public.patients(id, provider_id)
      on delete cascade;
  end if;
end;
$$;

create index if not exists patient_operational_follow_ups_patient_provider_idx
  on public.patient_operational_follow_ups(patient_id, provider_id);