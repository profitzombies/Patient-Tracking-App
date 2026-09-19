-- Staff second factor: an SMS step after the emailed sign-in code for HQ
-- users and office owners/admins (optional for everyone else).
--
-- * hq_organization_settings gains the "require phone verification at
--   sign-in" switches (HQ users + office owners/admins default ON).
-- * staff_second_factors holds one verified phone per staff identity,
--   keyed the same way the login directory resolves staff (hq membership id,
--   provider id, or team_members.id). Clearing = deleting the row.
-- * claim_verifications accepts the 'staff_sms' purpose (second-step and
--   enrolment codes) and auth_sign_ins accepts the 'email_sms_code' method.
--
-- Every object is service-role only: RLS on, no policies, client grants
-- revoked. The API is the sole writer.

alter table public.hq_organization_settings
  add column if not exists second_factor_hq_users boolean not null default true,
  add column if not exists second_factor_office_managers boolean not null default true,
  add column if not exists second_factor_all_staff boolean not null default false;

create table if not exists public.staff_second_factors (
  staff_kind text not null check (staff_kind in ('hq', 'provider', 'team_member')),
  staff_ref text not null check (char_length(staff_ref) between 1 and 80),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz not null default now(),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (staff_kind, staff_ref)
);

alter table public.staff_second_factors enable row level security;
revoke all on public.staff_second_factors from anon, authenticated;
grant all on public.staff_second_factors to service_role;

alter table public.claim_verifications
  drop constraint if exists claim_verifications_purpose_check;
alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array[
    'claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text, 'recovery'::text,
    'profile_email'::text, 'profile_phone'::text, 'password_change'::text, 'cart_pay'::text,
    'staff_sms'::text
  ]));

alter table public.auth_sign_ins
  drop constraint if exists auth_sign_ins_method_check;
alter table public.auth_sign_ins
  add constraint auth_sign_ins_method_check
  check (method in (
    'email_code', 'sms_code', 'password_sms_code', 'password_email_code', 'signup', 'claim', 'email_sms_code'
  ));
