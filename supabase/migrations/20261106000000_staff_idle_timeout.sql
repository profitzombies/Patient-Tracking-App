-- Staff web idle timeout + fresh-code re-authentication.
--
-- HIPAA's automatic-logoff standard: an operations-web browser left open at
-- a front desk must sign itself out. HQ sets two windows (minutes with no
-- pointer/key/scroll/visibility activity before the countdown starts):
--   staff_idle_timeout_minutes  provider owners and office teammates
--   hq_idle_timeout_minutes     HQ department members
-- Both default to 15 and are bounded 5–120. An office may SHORTEN its own
-- value (never lengthen) through provider_policy_overrides.idle_timeout_minutes;
-- the API refuses an override above the HQ staff value and, should HQ later
-- lower the staff value under an existing override, the effective value is
-- the smaller of the two.
--
-- Re-authentication: the most sensitive staff actions (whole-office exports,
-- team role changes, deactivations, forced sign-outs) need a code proven
-- within the last 10 minutes. The proof time lives on the sign-in ledger row
-- that backs the caller's GoTrue session: set when the sign-in's code was
-- verified, refreshed when the staffer re-enters a code inline.

alter table public.hq_organization_settings
  add column if not exists staff_idle_timeout_minutes integer not null default 15
    check (staff_idle_timeout_minutes between 5 and 120),
  add column if not exists hq_idle_timeout_minutes integer not null default 15
    check (hq_idle_timeout_minutes between 5 and 120);

alter table public.provider_policy_overrides
  add column if not exists idle_timeout_minutes integer
    check (idle_timeout_minutes is null or idle_timeout_minutes between 5 and 120);

alter table public.auth_sign_ins
  add column if not exists code_verified_at timestamptz;

comment on column public.auth_sign_ins.code_verified_at is
  'When a one-time code was last proven for this session (sign-in or inline re-authentication). Null = never proven on this ledger row.';

create index if not exists auth_sign_ins_session_code_verified_idx
  on public.auth_sign_ins (session_id, code_verified_at desc)
  where session_id is not null;
