-- Cover the composite patient/office foreign key in its declared order.
create index if not exists patient_operational_follow_ups_patient_provider_idx
  on public.patient_operational_follow_ups(patient_id, provider_id);