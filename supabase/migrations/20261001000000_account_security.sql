-- Account security: sign-in ledger, forced-reset state, and a service-only
-- window onto GoTrue's live session table.
--
-- auth_sign_ins records every successful sign-in the API mints (login code,
-- password + code, signup) with the facts a person needs to recognise it:
-- method, platform, a short user-agent, an approximate region derived from
-- the IP, and a device fingerprint. The client attaches the GoTrue session
-- id once it has exchanged the token hash, so the row can later be shown as
-- an active session and marked when that session is revoked. Rows are keyed
-- by auth user id (patients AND staff) and disappear with the auth user.
--
-- account_security_state holds the per-user "must reset password on next
-- sign-in" flag raised by a "this wasn't me" report. Recovery completion
-- clears it.
--
-- security_list_auth_sessions lets the API read the live auth.sessions rows
-- for ONE user without exposing the auth schema through PostgREST. It
-- returns session ids, timestamps, user agent and ip only — never tokens.
--
-- Every object is service-role only: RLS on, no policies, client grants
-- revoked, execute revoked from anon/authenticated.

create table if not exists public.auth_sign_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  realm text not null check (realm in ('patient', 'staff')),
  method text not null check (method in ('email_code', 'sms_code', 'password_sms_code', 'password_email_code', 'signup', 'claim')),
  platform text not null default 'unknown' check (platform in ('ios', 'android', 'web', 'unknown')),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  ip_region text check (ip_region is null or char_length(ip_region) <= 120),
  device_fingerprint text not null check (char_length(device_fingerprint) between 8 and 64),
  device_label text check (device_label is null or char_length(device_label) <= 120),
  new_device boolean not null default false,
  session_id uuid,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or char_length(revoked_reason) <= 40),
  reported_at timestamptz,
  report_token_hash text check (report_token_hash is null or char_length(report_token_hash) = 64),
  report_token_expires_at timestamptz
);
create index if not exists auth_sign_ins_user_created_idx
  on public.auth_sign_ins(user_id, created_at desc);
create index if not exists auth_sign_ins_user_fingerprint_idx
  on public.auth_sign_ins(user_id, device_fingerprint);
create unique index if not exists auth_sign_ins_session_key
  on public.auth_sign_ins(session_id) where session_id is not null;
create unique index if not exists auth_sign_ins_report_token_key
  on public.auth_sign_ins(report_token_hash) where report_token_hash is not null;
alter table public.auth_sign_ins enable row level security;
revoke all on public.auth_sign_ins from public, anon, authenticated;
grant all on public.auth_sign_ins to service_role;
comment on table public.auth_sign_ins is
  'Sign-in ledger for patients and staff: one row per successful sign-in the API minted, linked to its GoTrue session once the client attached it. Service-role only; never holds tokens.';

create table if not exists public.account_security_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  force_password_reset boolean not null default false,
  forced_reason text check (forced_reason is null or char_length(forced_reason) <= 40),
  forced_at timestamptz,
  password_changed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.account_security_state enable row level security;
revoke all on public.account_security_state from public, anon, authenticated;
grant all on public.account_security_state to service_role;
comment on table public.account_security_state is
  'Per-auth-user security flags: forced password reset after a "this wasn''t me" report, last password change. Service-role only.';

-- Live GoTrue sessions for one user. SECURITY DEFINER so the API can read
-- auth.sessions without any client-facing grant on the auth schema; the
-- service-role check keeps it out of reach even if execute leaked.
create or replace function public.security_list_auth_sessions(p_user_id uuid)
returns table (
  session_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  refreshed_at timestamptz,
  not_after timestamptz,
  user_agent text,
  ip text
) language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
    select s.id, s.created_at, s.updated_at, s.refreshed_at::timestamptz, s.not_after, s.user_agent, s.ip::text
    from auth.sessions s
    where s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
    order by coalesce(s.refreshed_at, s.updated_at, s.created_at) desc
    limit 100;
end;
$$;
revoke all on function public.security_list_auth_sessions(uuid) from public, anon, authenticated;
grant execute on function public.security_list_auth_sessions(uuid) to service_role;
comment on function public.security_list_auth_sessions(uuid) is
  'Service-role window onto auth.sessions for one user: ids, timestamps, user agent, ip. Never returns tokens.';

-- Authenticated password change rides the same verification ledger as
-- login and recovery, under its own purpose.
alter table public.claim_verifications
  drop constraint if exists claim_verifications_purpose_check;
alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array[
    'claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text, 'recovery'::text,
    'profile_email'::text, 'profile_phone'::text, 'password_change'::text
  ]));
