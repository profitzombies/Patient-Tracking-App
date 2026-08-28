-- Atomic send registration for account claiming.
--
-- Identify previously counted recent sends (GET) and inserted the ledger row
-- (POST) as two separate requests, so concurrent requests could all observe
-- fewer than the cap and each trigger a delivery; add-phone had no
-- destination cap at all. This function serializes concurrent senders on
-- advisory locks and performs count + insert in ONE transaction, making the
-- hourly caps hold under concurrency. Counting is purpose-scoped so claim
-- sends and add-phone sends cannot be used to probe each other.

alter table public.claim_verifications
  add column if not exists scope_key text;

create index if not exists claim_verifications_scope_idx
  on public.claim_verifications (scope_key, created_at desc)
  where scope_key is not null;

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
  -- Serialize concurrent sends for the same destination (and same account
  -- scope) so the hourly caps cannot be raced past.
  perform pg_advisory_xact_lock(
    hashtextextended('claim_send:' || p_purpose || ':' || p_identifier, 42));
  if p_scope_key is not null then
    perform pg_advisory_xact_lock(
      hashtextextended('claim_scope:' || p_purpose || ':' || p_scope_key, 42));
  end if;

  select count(*) into v_count
    from public.claim_verifications
   where identifier = p_identifier
     and purpose = p_purpose
     and created_at > now() - interval '1 hour';
  if v_count >= p_max_per_hour then
    return; -- capped: no row, no delivery; the caller answers neutrally
  end if;

  if p_scope_key is not null and p_scope_max_per_hour is not null then
    select count(*) into v_count
      from public.claim_verifications
     where scope_key = p_scope_key
       and purpose = p_purpose
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

-- Ledger writes are the API server's job alone.
revoke all on function public.claim_register_send(
  text, text, text, text, jsonb, text, text, text, timestamptz, uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_register_send(
  text, text, text, text, jsonb, text, text, text, timestamptz, uuid, text, integer, integer)
  to service_role;
