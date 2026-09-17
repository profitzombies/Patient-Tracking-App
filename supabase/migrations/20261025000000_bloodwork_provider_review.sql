alter table public.patient_bloodwork_reports
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid;

comment on column public.patient_bloodwork_reports.reviewed_at is
  'Set by an authorized staff member of the patient''s office. This marker does not imply clinical sign-off. Corrections do not set or clear it.';

comment on column public.patient_bloodwork_reports.reviewed_by is
  'The authorized staff member of the patient''s office who set reviewed_at. This marker does not imply clinical sign-off. Corrections do not set or clear it.';