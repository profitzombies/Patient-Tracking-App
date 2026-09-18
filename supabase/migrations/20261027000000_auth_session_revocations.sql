-- Server-side session revocation list.
--
-- Ordinary API requests verify Supabase access tokens locally (JWKS
-- signature, expiry, issuer, audience) instead of asking GoTrue on every
-- call. That leaves one gap: a session the server signed out ("sign out
-- everywhere", "sign out other devices", forced staff sign-outs, purge)
-- would keep working until its access token expired. So the API records
-- the revoked session ids here BEFORE calling GoTrue and refuses any
-- locally verified token whose session_id is on the list.
--
-- Rows carry their own expiry: the latest moment an access token for that
-- session could still be valid. Reads filter on it; a sweep job deletes
-- lapsed rows. No FK to auth.users on purpose — purge deletes the user and
-- the revocation must outlive that deletion until the token horizon.
--
-- Service-role only: RLS on, no policies, client grants revoked.

create table if not exists public.auth_session_revocations (
  session_id uuid primary key,
  user_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 40),
  revoked_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists auth_session_revocations_expires_at_idx
  on public.auth_session_revocations (expires_at);
create index if not exists auth_session_revocations_user_id_idx
  on public.auth_session_revocations (user_id);

alter table public.auth_session_revocations enable row level security;
revoke all on table public.auth_session_revocations from public, anon, authenticated;
grant select, insert, update, delete on table public.auth_session_revocations to service_role;

comment on table public.auth_session_revocations is
  'Session ids the API server signed out; locally verified access tokens carrying one of these session ids are refused until expires_at.';
comment on column public.auth_session_revocations.expires_at is
  'Latest moment an access token minted for this session could still be valid; rows past it are dead weight and are swept.';
