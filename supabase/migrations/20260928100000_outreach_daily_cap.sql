-- Organization-wide outreach daily cap, reserved atomically.
--
-- The notification worker runs in more than one process (API instances plus
-- external scheduler ticks), so "count today's outreach rows, then insert"
-- inside each worker can overshoot the HQ daily cap when two ticks overlap.
-- This RPC couples the cap check to the deduped insert inside ONE
-- transaction, serialized by an advisory transaction lock: a second caller
-- blocks until the first commits, then counts the committed row. The count
-- is derived from the outbox itself (rows of the outreach kind created since
-- the day start the caller passes), so there is no separate counter to drift.

create or replace function public.enqueue_outreach_capped(
  p_patient_id uuid,
  p_kind text,
  p_category text,
  p_title text,
  p_body text,
  p_data jsonb,
  p_dedupe_key text,
  p_scheduled_at timestamptz,
  p_expires_at timestamptz,
  p_cap integer,
  p_since timestamptz
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_existing public.patient_notifications%rowtype;
  v_row public.patient_notifications%rowtype;
  v_sent integer;
begin
  if p_dedupe_key is null or char_length(p_dedupe_key) = 0 then
    raise exception 'dedupe key is required';
  end if;
  if p_cap is null or p_cap < 1 then
    raise exception 'daily cap must be at least 1';
  end if;
  if p_since is null then
    raise exception 'cap window start is required';
  end if;

  -- One reservation at a time across every worker process. The lock is held
  -- until this transaction commits, so the next caller's count sees our row.
  perform pg_advisory_xact_lock(hashtext('patient_notifications.outreach_daily_cap'));

  select * into v_existing from public.patient_notifications where dedupe_key = p_dedupe_key;
  if found then
    return jsonb_build_object('outcome', 'existing', 'row', to_jsonb(v_existing));
  end if;

  select count(*)::integer into v_sent
  from public.patient_notifications n
  where n.kind = p_kind and n.created_at >= p_since;
  if v_sent >= p_cap then
    return jsonb_build_object('outcome', 'capped', 'row', null, 'sent', v_sent);
  end if;

  insert into public.patient_notifications
    (patient_id, kind, category, title, body, data, dedupe_key, scheduled_at, next_attempt_at, expires_at)
  values
    (p_patient_id, p_kind, p_category, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key,
     coalesce(p_scheduled_at, now()), coalesce(p_scheduled_at, now()),
     coalesce(p_expires_at, now() + interval '3 days'))
  returning * into v_row;
  return jsonb_build_object('outcome', 'created', 'row', to_jsonb(v_row), 'sent', v_sent + 1);
end;
$$;

revoke all on function public.enqueue_outreach_capped(uuid, text, text, text, text, jsonb, text, timestamptz, timestamptz, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.enqueue_outreach_capped(uuid, text, text, text, text, jsonb, text, timestamptz, timestamptz, integer, timestamptz)
  to service_role;
