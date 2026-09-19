-- Retention floors and the clinical record retention setting.
--
-- HIPAA requires the organization to keep its own compliance documentation
-- and audit trail for at least six years (45 CFR 164.316(b)(2)), and the
-- offices must keep patient records for their state's window (up to seven
-- years). Two changes to the versioned HQ policy row:
--
--   retention_clinical_record_days   NEW. How long a patient's clinical
--                                    record is kept after the account is
--                                    closed or the office is offboarded.
--                                    Default 7 years (2,555 days), allowed
--                                    5–10 years. Nothing deletes on this
--                                    timer yet: the closure and offboarding
--                                    flows read it.
--   retention_audit_days             floor raised from 1 year to 6 years
--                                    (2,190 days). Any saved value below the
--                                    floor is raised in place; the CHECK is
--                                    recreated so a bypassing write cannot
--                                    lower it again.
--
-- No other retention window changes.

alter table public.hq_organization_settings
  add column if not exists retention_clinical_record_days integer not null default 2555
    check (retention_clinical_record_days between 1825 and 3650);

comment on column public.hq_organization_settings.retention_clinical_record_days is
  'Days a patient''s clinical record is kept after account closure or office offboarding (5–10 years). Read by closure/offboarding flows; HQ singleton only.';

-- Raise before tightening: the new CHECK must validate against every row.
update public.hq_organization_settings
set retention_audit_days = 2190
where retention_audit_days < 2190;

alter table public.hq_organization_settings
  drop constraint if exists hq_organization_settings_retention_audit_days_check;
alter table public.hq_organization_settings
  add constraint hq_organization_settings_retention_audit_days_check
    check (retention_audit_days between 2190 and 3650);

comment on column public.hq_organization_settings.retention_audit_days is
  'Days audit events are kept in detail before monthly summarization. Floor 6 years (2,190 days): the HIPAA documentation retention minimum.';
