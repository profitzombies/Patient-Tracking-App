-- Organization policies: the HQ settings singleton grows from four contact
-- fields into the policy contract the notification sender, the staff inbox,
-- the coach route and (later) retention jobs obey. Offices may override only
-- the two HQ-designated office-local values (quiet hours, escalation
-- destination) in their own row. Both tables stay service-role only: every
-- read and write goes through the API, which audits field-level changes.

alter table public.hq_organization_settings
  add column if not exists version integer not null default 1 check (version >= 1),
  add column if not exists coach_available boolean not null default true,
  add column if not exists escalation_email text
    check (escalation_email is null or char_length(escalation_email) between 3 and 320),
  add column if not exists default_coach_outreach boolean not null default true,
  add column if not exists default_check_in_reminders boolean not null default true,
  add column if not exists default_office_reminders boolean not null default true,
  add column if not exists default_quiet_start text
    check (default_quiet_start is null or default_quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists default_quiet_end text
    check (default_quiet_end is null or default_quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists outreach_cooldown_days integer not null default 14
    check (outreach_cooldown_days between 1 and 90),
  add column if not exists outreach_daily_cap integer not null default 500
    check (outreach_daily_cap between 1 and 10000),
  add column if not exists conversation_auto_close_days integer not null default 14
    check (conversation_auto_close_days between 1 and 365),
  add column if not exists retention_chat_days integer not null default 730
    check (retention_chat_days between 30 and 3650),
  add column if not exists retention_photo_days integer not null default 730
    check (retention_photo_days between 30 and 3650),
  add column if not exists retention_notification_days integer not null default 180
    check (retention_notification_days between 7 and 3650),
  add column if not exists retention_audit_days integer not null default 2555
    check (retention_audit_days between 365 and 3650),
  add column if not exists export_link_hours integer not null default 24
    check (export_link_hours between 1 and 168),
  -- Per-section "who changed this last": { "<section>": { "at": iso, "by": uuid, "name": text } }
  add column if not exists section_changes jsonb not null default '{}'::jsonb
    check (jsonb_typeof(section_changes) = 'object');

alter table public.hq_organization_settings
  drop constraint if exists hq_organization_settings_quiet_pair_check;
alter table public.hq_organization_settings
  add constraint hq_organization_settings_quiet_pair_check check (
    (default_quiet_start is null) = (default_quiet_end is null)
    and (default_quiet_start is null or default_quiet_start <> default_quiet_end)
  );

-- Office-local overrides of the HQ-designated overridable values. A null
-- column means "inherit HQ"; quiet hours are one unit (both null or both set).
create table if not exists public.provider_policy_overrides (
  provider_id text primary key references public.providers(provider_id) on delete cascade,
  version integer not null default 1 check (version >= 1),
  quiet_hours_set boolean not null default false,
  quiet_start text check (quiet_start is null or quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text check (quiet_end is null or quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  escalation_email text
    check (escalation_email is null or char_length(escalation_email) between 3 and 320),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  updated_by_name text check (updated_by_name is null or char_length(updated_by_name) <= 160),
  constraint provider_policy_overrides_quiet_pair_check check (
    (quiet_start is null) = (quiet_end is null)
    and (quiet_start is null or quiet_start <> quiet_end)
    and (quiet_hours_set or quiet_start is null)
  )
);
alter table public.provider_policy_overrides enable row level security;
revoke all on public.provider_policy_overrides from public, anon, authenticated;
grant all on public.provider_policy_overrides to service_role;
