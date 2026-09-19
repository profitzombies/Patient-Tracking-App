-- Patient record edit history: prior values survive every correction.
--
-- HIPAA amendments append, never overwrite. The admin audit ledger is
-- deliberately PII-free (it records WHICH field changed, not the values), so
-- until now the previous value of a corrected weight, medication, measurement,
-- status, or profile field was gone once the row was rewritten. This table is
-- the patient-scoped complement: one row per changed field, carrying the old
-- and new value, who made the change, when, and the audit event it pairs with.
--
-- Posture: patient-owned (cascade FK on patients), service-role only (RLS on,
-- no policies, client grants revoked), enrolled in the identity-reconciliation
-- write barrier, and covered by the dynamic patient_id purge enumeration. The
-- table is append-only like the audit ledger — a correction to a correction
-- is a new row, never an edit.

-- ── Audit RPC returns the event id ──────────────────────────────────────────
--
-- Changing the return type needs a drop + create. Security definer, the
-- service-role check, and the grants are re-applied verbatim.

drop function if exists public.record_admin_audit_event(text, uuid, text, text, text, text, text, jsonb);
create function public.record_admin_audit_event(
  p_action text, p_actor_user_id uuid, p_actor_kind text, p_provider_id text default null,
  p_target_kind text default null, p_target_id text default null, p_request_id text default null,
  p_metadata jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer set search_path = public as $$
declare event_id bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  insert into admin_audit_events(action, actor_user_id, actor_kind, provider_id, target_kind, target_id, request_id, metadata)
  values (p_action, p_actor_user_id, p_actor_kind, p_provider_id, p_target_kind, p_target_id, p_request_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into event_id;
  return event_id;
end;
$$;
revoke all on function public.record_admin_audit_event(text, uuid, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_admin_audit_event(text, uuid, text, text, text, text, text, jsonb) to service_role;

-- ── History table ───────────────────────────────────────────────────────────

create table if not exists public.patient_edit_history (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  provider_id text references public.providers(provider_id) on delete set null,
  -- Every field changed by one edit shares a change_id so the UI can show
  -- "Weight corrected: 182.4 → 181.6, note: … → …" as a single entry.
  change_id uuid not null,
  family text not null check (family in ('profile', 'status', 'weight', 'measurement', 'medication', 'note')),
  -- The edited row (weight id, visit id, medication id, note id) or the
  -- patient id for profile/status edits.
  record_id text not null check (char_length(record_id) between 1 and 240),
  field text not null check (char_length(field) between 1 and 120),
  old_value jsonb,
  new_value jsonb,
  change_kind text not null check (change_kind in ('create', 'update', 'delete')),
  actor_kind text not null check (actor_kind in ('provider', 'team_member', 'hq', 'patient', 'system')),
  actor_user_id uuid,
  actor_name text check (actor_name is null or char_length(actor_name) between 1 and 160),
  audit_event_id bigint references public.admin_audit_events(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists patient_edit_history_patient_created_idx
  on public.patient_edit_history (patient_id, created_at desc, change_id);
create index if not exists patient_edit_history_patient_family_idx
  on public.patient_edit_history (patient_id, family, created_at desc);
alter table public.patient_edit_history enable row level security;
revoke all on public.patient_edit_history from public, anon, authenticated;
grant all on public.patient_edit_history to service_role;
comment on table public.patient_edit_history is
  'Append-only prior/new values for every staff or patient edit to a patient record (profile, status, weights, measurements, medications, notes). Pairs with admin_audit_events by id. Service-role only.';

drop trigger if exists patient_edit_history_append_only on public.patient_edit_history;
create trigger patient_edit_history_append_only before update on public.patient_edit_history
  for each row execute function public.reject_operational_event_mutation();

-- Every new patient_id table joins the identity reconciliation write barrier.
select private.install_patient_identity_write_guards();

-- ── Write RPC ───────────────────────────────────────────────────────────────
--
-- One call per edit: p_fields is a JSON array of {field, old, new}. Every
-- element becomes a row under the same change_id. Returns the change_id.

create or replace function public.record_patient_edit_history(
  p_patient_id uuid, p_family text, p_record_id text, p_change_kind text,
  p_actor_kind text, p_actor_user_id uuid, p_actor_name text,
  p_audit_event_id bigint, p_fields jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_change_id uuid := gen_random_uuid();
  v_provider_id text;
  v_inserted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) = 0 then
    raise exception 'edit history needs at least one field';
  end if;
  select provider_id into v_provider_id from patients where id = p_patient_id;
  if not found then raise exception 'unknown patient'; end if;
  insert into patient_edit_history(
    patient_id, provider_id, change_id, family, record_id, field, old_value, new_value,
    change_kind, actor_kind, actor_user_id, actor_name, audit_event_id
  )
  select p_patient_id, v_provider_id, v_change_id, p_family, p_record_id,
         f.value->>'field', f.value->'old', f.value->'new',
         p_change_kind, p_actor_kind, p_actor_user_id, nullif(btrim(p_actor_name), ''), p_audit_event_id
  from jsonb_array_elements(p_fields) f
  where coalesce(f.value->>'field', '') <> '';
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then raise exception 'edit history needs at least one named field'; end if;
  return v_change_id;
end;
$$;
revoke all on function public.record_patient_edit_history(uuid, text, text, text, text, uuid, text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.record_patient_edit_history(uuid, text, text, text, text, uuid, text, bigint, jsonb) to service_role;

-- ── Read RPC ────────────────────────────────────────────────────────────────
--
-- Grouped by change (newest first), optional family filter, offset paging.
-- Every page also carries the total number of matching changes so the client
-- can render "showing 20 of 63" without a second call. Scoped by
-- (patient, provider) so an office can only ever read its own patient.

create or replace function public.office_patient_edit_history(
  p_provider_id text, p_patient_id uuid, p_family text default null,
  p_limit integer default 50, p_offset integer default 0
) returns table (
  change_id uuid, family text, record_id text, change_kind text,
  actor_kind text, actor_user_id uuid, actor_name text, audit_event_id bigint,
  created_at timestamptz, fields jsonb, total bigint
) language sql stable security definer set search_path = public as $$
  with scoped as (
    select h.* from patient_edit_history h
    join patients p on p.id = h.patient_id
    where h.patient_id = p_patient_id and p.provider_id = p_provider_id
      and (p_family is null or h.family = p_family)
  ), grouped as (
    select s.change_id, min(s.family) as family, min(s.record_id) as record_id, min(s.change_kind) as change_kind,
           min(s.actor_kind) as actor_kind, min(s.actor_user_id::text)::uuid as actor_user_id, min(s.actor_name) as actor_name,
           min(s.audit_event_id) as audit_event_id, min(s.created_at) as created_at,
           jsonb_agg(jsonb_build_object('field', s.field, 'old', s.old_value, 'new', s.new_value) order by s.field) as fields
    from scoped s group by s.change_id
  )
  select g.change_id, g.family, g.record_id, g.change_kind, g.actor_kind, g.actor_user_id, g.actor_name, g.audit_event_id,
         g.created_at, g.fields, (select count(*) from grouped)::bigint as total
  from grouped g
  order by g.created_at desc, g.change_id desc
  limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.office_patient_edit_history(text, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.office_patient_edit_history(text, uuid, text, integer, integer) to service_role;
