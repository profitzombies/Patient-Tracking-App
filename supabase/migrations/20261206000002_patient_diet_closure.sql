-- Account closure: diet activity levels and target snapshots are personal.
--
-- The diet programs tables (20261206000001_patient_diet.sql) split two ways.
-- Diet selections, protocol episodes, safety blocks, preference lists and
-- screening answers are part of the clinical record a provider acted on, so
-- they stay sealed until the retention window ends. Activity-level answers
-- and the daily target snapshots are engagement data with no clinical
-- reliance; they leave with the other personal families. This re-creates
-- patient_close_rows with the personal list extended; nothing else changes.
create or replace function public.patient_close_rows(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req patient_deletion_requests%rowtype;
  v_patient patients%rowtype;
  v_name text;
  v_count bigint;
  v_tables jsonb := '{}'::jsonb;
  v_paths text[] := '{}'::text[];
  v_closed_at timestamptz;
  v_retain_until timestamptz;
  v_days integer;
  v_already_closed boolean;
  v_personal constant text[] := array[
    'coach_conversation_work', 'coach_memories', 'coach_memory_source_suppressions',
    'patient_diary_entries', 'patient_water_days', 'patient_target_overrides',
    'patient_food_prefs', 'patient_custom_foods', 'patient_saved_recipes',
    'food_catalog_usage', 'patient_push_tokens', 'patient_notifications',
    'patient_notification_attempts', 'patient_outreach_state', 'patient_consents',
    'patient_app_events', 'patient_app_presence', 'patient_data_exports',
    'patient_write_receipts', 'billing_carts', 'patient_flags',
    -- Coach chat safety flags quote the patient's own words; they leave with
    -- the coach thread. Staff review stays in the audit trail.
    'coach_chat_flags',
    -- Rewards are an engagement ledger (XP, streaks, medals, the baseline
    -- weight they were measured against). Nothing clinical depends on them.
    'patient_reward_state', 'patient_reward_events', 'patient_reward_awards',
    -- Diet programs: activity answers and calculated-target snapshots are
    -- personal; the diet choice, episodes, blocks, lists and screening
    -- answers stay with the sealed clinical record.
    'patient_activity_levels', 'patient_target_snapshots'
  ];
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_req from patient_deletion_requests where id = p_request_id for update;
  if not found then raise exception 'unknown deletion request'; end if;
  if v_req.status <> 'closing' then raise exception 'deletion request is not being closed'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_req.patient_id::text, 40421001));
  select * into v_patient from patients where id = v_req.patient_id for update;
  if not found then raise exception 'unknown patient'; end if;

  v_already_closed := v_patient.closed_at is not null;
  v_closed_at := coalesce(v_patient.closed_at, now());
  select greatest(1825, coalesce(s.retention_clinical_record_days, 2555))
    into v_days
  from hq_organization_settings s
  where s.singleton = true;
  v_days := coalesce(v_days, 2555);
  v_retain_until := coalesce(v_patient.record_retain_until, v_closed_at + make_interval(days => v_days));

  if not v_already_closed then
    select coalesce(array_agg(path order by path), '{}'::text[])
      into v_paths
    from (
      select pm.object_path as path
      from patient_media pm
      where pm.patient_id = v_req.patient_id and pm.kind in ('food', 'recipe', 'chat')
      union
      select x.object_path
      from patient_data_exports x
      where x.patient_id = v_req.patient_id and x.object_path is not null
    ) objects;

    delete from patient_chat_conversations
    where patient_id = v_req.patient_id and thread in ('coach', 'support');
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('patient_chat_conversations', v_count);

    delete from patient_media
    where patient_id = v_req.patient_id and kind in ('food', 'recipe', 'chat');
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('patient_media', v_count);

    foreach v_name in array v_personal loop
      if to_regclass(format('public.%I', v_name)) is not null then
        execute format('delete from public.%I where patient_id = $1', v_name) using v_req.patient_id;
        get diagnostics v_count = row_count;
        v_tables := v_tables || jsonb_build_object(v_name, v_count);
      end if;
    end loop;

    -- Usage ledgers are append-only aggregate facts; closure only detaches the
    -- account reference. analytics_events remains attached until final purge.
    update ai_usage_events set patient_id = null where patient_id = v_req.patient_id;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('ai_usage_events_detached', v_count);

    delete from auth_sign_ins
    where user_id = v_patient.auth_user_id and realm = 'patient';
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('auth_sign_ins', v_count);
    delete from account_security_state where user_id = v_patient.auth_user_id;
    get diagnostics v_count = row_count;
    v_tables := v_tables || jsonb_build_object('account_security_state', v_count);

    update patients
    set closed_at = v_closed_at,
        archived_at = v_closed_at,
        record_retain_until = v_retain_until,
        auth_user_id = null,
        email = null,
        phone = null,
        deletion_requested_at = null,
        archived_into_patient_id = null
    where id = v_req.patient_id;
  end if;

  update patient_deletion_requests
  set closed_at = v_closed_at, retain_until = v_retain_until
  where id = p_request_id;

  return jsonb_build_object(
    'tables', v_tables,
    'mediaPaths', to_jsonb(v_paths),
    'authUserId', v_req.auth_user_id,
    'closedAt', v_closed_at,
    'retainUntil', v_retain_until,
    'alreadyClosed', v_already_closed
  );
end;
$$;
revoke all on function public.patient_close_rows(uuid) from public, anon, authenticated;
grant execute on function public.patient_close_rows(uuid) to service_role;
