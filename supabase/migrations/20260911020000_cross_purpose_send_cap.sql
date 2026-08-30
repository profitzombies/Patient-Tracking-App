-- One shared per-target send budget across ALL code purposes.
--
-- claim_register_send counted recent sends per (identifier, purpose), so a
-- single phone/email could receive 3 login + 3 signup + 3 claim + 3 add-phone
-- codes in the same hour — a 4x bypass of the intended 3/hr delivery cap, and
-- an SMS-bombing vector via the public signup endpoint (any phone can be
-- targeted with a well-known provider code). Counting is now
-- destination-scoped across purposes: at most p_max_per_hour ledger rows per
-- identifier per hour, whatever mix of rails produced them. The advisory
-- locks drop the purpose component for the same reason, so concurrent
-- different-purpose senders serialize instead of racing the shared budget.
-- Responses stay neutral: a capped call still returns zero rows and the
-- caller answers exactly like a real send.
--
-- The scope-key count (per-office signup budget) keeps its own dimension;
-- scope keys are namespaced by construction ("signup:<provider_id>").

create or replace function public.claim_register_send(
  p_purpose text,
  p_identifier_kind text,
  p_identifier text,
  p_account_type text,
  p_candidates jsonb,
  p_delivery text,
  p_code_salt text,
  p_code_hash text,
  p_code_expires_at timestamptz,
  p_auth_user_id uuid,
  p_scope_key text,
  p_max_per_hour integer,
  p_scope_max_per_hour integer
) returns setof public.claim_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- Serialize concurrent sends for the same destination — across purposes —
  -- and for the same account scope, so the hourly caps cannot be raced past.
  perform pg_advisory_xact_lock(
    hashtextextended('claim_send:' || p_identifier, 42));
  if p_scope_key is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('claim_scope:' || p_scope_key, 42));
  end if;

  -- Destination cap: every code purpose draws from one shared hourly pot.
  select count(*) into v_count
    from public.claim_verifications
   where identifier = p_identifier
     and created_at > now() - interval '1 hour';
  if v_count >= p_max_per_hour then
    return; -- capped: no row, no delivery; the caller answers neutrally
  end if;

  if p_scope_key is not null and p_scope_max_per_hour is not null then
    select count(*) into v_count
      from public.claim_verifications
     where scope_key = p_scope_key
       and created_at > now() - interval '1 hour';
    if v_count >= p_scope_max_per_hour then
      return;
    end if;
  end if;

  return query
    insert into public.claim_verifications
      (purpose, identifier_kind, identifier, account_type, candidates, delivery,
       code_salt, code_hash, code_expires_at, auth_user_id, scope_key)
    values
      (p_purpose, p_identifier_kind, p_identifier, p_account_type, p_candidates,
       p_delivery, p_code_salt, p_code_hash, p_code_expires_at, p_auth_user_id,
       p_scope_key)
    returning *;
end;
$$;

-- Ledger writes stay the API server's job alone: CREATE OR REPLACE preserves
-- the existing ACLs from 20260903000000 (revoked from public/anon/
-- authenticated, granted to service_role only), so no grant changes here.
