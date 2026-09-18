-- Atomic server-side session revocation: list + revoke + end in one statement.
--
-- The API's "sign out everywhere" (HQ / office forced sign-outs, recovery
-- sweeps, "this wasn't me"), "sign out other devices", and purge used to
-- POST /auth/v1/admin/users/{id}/logout, a route this project's GoTrue
-- (v2.197) does not serve — it answers "404 page not found", so the
-- sessions stayed alive. GoTrue's own global logout is a delete of the
-- user's auth.sessions rows (refresh tokens cascade), which is what this
-- function does — but FIRST it records every targeted session id on
-- public.auth_session_revocations, in the same transaction and from the
-- same row set, so:
--   * no cap: every session is covered, however many the user has;
--   * no race: a session cannot be ended without also being listed, and a
--     session opened after this statement's snapshot is neither (it is a
--     new login, and stays valid);
--   * fail closed: if the list cannot be written the sessions are not
--     ended and the caller reports failure.
--
-- expires_at is the latest moment an access token minted for the session
-- could still be valid: the session's most recent (re)issue plus the token
-- horizon the API passes in (its AUTH_REVOCATION_ROW_TTL_SECONDS knob),
-- capped by the session's own hard end (not_after) and floored at one
-- minute from now.
--
-- Returns the number of sessions revoked and ended. Service-role only.

drop function if exists public.security_end_auth_sessions(uuid, uuid);

create or replace function public.security_revoke_auth_sessions(
  p_user_id uuid,
  p_reason text,
  p_ttl_seconds integer,
  p_except_session_id uuid default null
)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_ttl interval;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  if p_reason is null or char_length(p_reason) not between 1 and 40 then
    raise exception 'reason must be 1-40 characters';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'ttl must be positive';
  end if;
  v_ttl := make_interval(secs => p_ttl_seconds);

  with targeted as (
    delete from auth.sessions s
    where s.user_id = p_user_id
      and (p_except_session_id is null or s.id <> p_except_session_id)
    returning s.id, s.created_at, s.updated_at, s.refreshed_at, s.not_after
  ),
  listed as (
    insert into public.auth_session_revocations (session_id, user_id, reason, revoked_at, expires_at)
    select
      t.id,
      p_user_id,
      p_reason,
      now(),
      greatest(
        least(
          greatest(coalesce(t.refreshed_at::timestamptz, t.updated_at, t.created_at, now()), now()) + v_ttl,
          coalesce(t.not_after, 'infinity'::timestamptz)
        ),
        now() + interval '60 seconds'
      )
    from targeted t
    on conflict (session_id) do update
      set reason = excluded.reason,
          revoked_at = excluded.revoked_at,
          expires_at = greatest(public.auth_session_revocations.expires_at, excluded.expires_at)
    returning 1
  )
  select count(*) into v_count from listed;
  return v_count;
end;
$$;
revoke all on function public.security_revoke_auth_sessions(uuid, text, integer, uuid) from public, anon, authenticated;
grant execute on function public.security_revoke_auth_sessions(uuid, text, integer, uuid) to service_role;
comment on function public.security_revoke_auth_sessions(uuid, text, integer, uuid) is
  'Service-role sign-out: atomically lists every targeted auth.sessions row on auth_session_revocations (with its token-horizon expiry) and deletes it (refresh tokens cascade). Optionally spares one session. Returns the number revoked.';
