-- Patient diet programs: per-patient diet choice, protocol episodes, the four
-- preference lists, safety screening answers, pending blocks with provider
-- overrides, activity-level history and calculated-target snapshots.
--
-- Conventions (same as medications / groups): service-role only, RLS on with
-- no policies, every table carries patient_id so patient_purge_rows
-- enumerates it and the identity write barrier (installed at the end) refuses
-- late writes against unknown or archived patients.
--
-- Closure classification: selections, episodes, blocks, preference items and
-- screening answers are part of the clinical record (sealed at closure,
-- purged with it); activity levels and target snapshots are personal and
-- leave at closure (see 20261206000002_patient_diet_closure.sql).

-- ── Protocol episodes: the explicit phase model ─────────────────────────────
--
-- Day N of the program is counted from the CURRENT episode's start date. A
-- provider restart closes the open episode and opens the next one from day
-- one; nothing is deleted. patients.program_start_date stays as a mirror of
-- the open episode's start so every existing program-day reader keeps
-- working; the trigger below keeps the two in step in both directions.
create table if not exists public.patient_protocol_episodes (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  episode_number integer not null check (episode_number >= 1),
  started_on date not null,
  -- Set when the episode is superseded by a restart; null = current.
  ended_on date check (ended_on is null or ended_on >= started_on - 1),
  reason text not null check (reason in ('enrollment', 'provider_restart', 'backfill')),
  started_by uuid,
  started_by_role text not null default 'system' check (started_by_role in ('patient', 'staff', 'system')),
  note text check (note is null or char_length(note) <= 300),
  created_at timestamptz not null default now(),
  constraint patient_protocol_episodes_number_unique unique (patient_id, episode_number)
);
create unique index if not exists patient_protocol_episodes_open_idx
  on public.patient_protocol_episodes (patient_id) where ended_on is null;
comment on table public.patient_protocol_episodes is
  'One row per run of the 42-day protocol. The open row (ended_on null) defines program day and phase; a provider restart closes it and opens the next from day one. Service-role only.';
alter table public.patient_protocol_episodes enable row level security;
revoke all on public.patient_protocol_episodes from public, anon, authenticated;
grant all on public.patient_protocol_episodes to service_role;

-- Backfill: every patient with a program start gets episode 1 from it.
insert into public.patient_protocol_episodes (patient_id, episode_number, started_on, reason, started_by_role)
select p.id, 1, p.program_start_date, 'backfill', 'system'
from public.patients p
where p.program_start_date is not null
  and not exists (select 1 from public.patient_protocol_episodes e where e.patient_id = p.id)
on conflict do nothing;

-- Keep patients.program_start_date and the open episode in step.
create or replace function public.patient_program_start_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_open public.patient_protocol_episodes%rowtype;
begin
  if new.program_start_date is null then return new; end if;
  if tg_op = 'UPDATE' and new.program_start_date is not distinct from old.program_start_date then return new; end if;
  select * into v_open from public.patient_protocol_episodes e where e.patient_id = new.id and e.ended_on is null;
  if not found then
    insert into public.patient_protocol_episodes (patient_id, episode_number, started_on, reason, started_by_role)
    values (
      new.id,
      coalesce((select max(e.episode_number) from public.patient_protocol_episodes e where e.patient_id = new.id), 0) + 1,
      new.program_start_date, 'enrollment', 'system'
    );
  elsif v_open.started_on is distinct from new.program_start_date then
    -- A start-date correction moves the current episode; history rows stay.
    update public.patient_protocol_episodes set started_on = new.program_start_date where id = v_open.id;
  end if;
  return new;
end; $$;
drop trigger if exists patient_program_start_sync on public.patients;
create trigger patient_program_start_sync
  after insert or update of program_start_date on public.patients
  for each row execute function public.patient_program_start_sync();

-- Provider restart: close the open episode, open the next from p_started_on,
-- mirror the date onto the clinical row. Returns the new episode.
create or replace function public.patient_protocol_restart(
  p_patient_id uuid, p_started_on date, p_actor uuid, p_note text default null
)
returns public.patient_protocol_episodes
language plpgsql security definer set search_path = '' as $$
declare
  v_patient public.patients%rowtype;
  v_next integer;
  v_row public.patient_protocol_episodes%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service role required'; end if;
  select * into v_patient from public.patients p where p.id = p_patient_id for update;
  if not found then raise exception 'unknown patient'; end if;
  if v_patient.archived_at is not null then raise exception 'cannot restart an archived patient'; end if;
  update public.patient_protocol_episodes
     set ended_on = greatest(started_on - 1, p_started_on - 1)
   where patient_id = p_patient_id and ended_on is null;
  select coalesce(max(e.episode_number), 0) + 1 into v_next
    from public.patient_protocol_episodes e where e.patient_id = p_patient_id;
  insert into public.patient_protocol_episodes (patient_id, episode_number, started_on, reason, started_by, started_by_role, note)
  values (p_patient_id, v_next, p_started_on, 'provider_restart', p_actor, 'staff', p_note)
  returning * into v_row;
  -- A tracking-only patient put on the protocol joins it; GLP-1 patients keep
  -- their program (their picker never locks).
  update public.patients
     set program_start_date = p_started_on,
         program_id = case when program_id = 'none' then 'thinnr' else program_id end
   where id = p_patient_id;
  return v_row;
end; $$;
revoke all on function public.patient_protocol_restart(uuid, date, uuid, text) from public, anon, authenticated;
grant execute on function public.patient_protocol_restart(uuid, date, uuid, text) to service_role;

-- ── Diet selections (current + history) ─────────────────────────────────────
create table if not exists public.patient_diet_selections (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Library slug; "just_tracking" is a real entry. Never null: "no diet" is
  -- the absence of an active row.
  diet_slug text not null references public.diet_library_entries(slug) on update cascade,
  -- active: current diet. pending_review: parked behind a safety block.
  -- superseded: replaced by a later choice. rejected: provider declined the
  -- block. withdrawn: patient changed their mind before review.
  status text not null check (status in ('active', 'pending_review', 'superseded', 'rejected', 'withdrawn')),
  selected_by uuid,
  selected_by_role text not null check (selected_by_role in ('patient', 'staff', 'system')),
  -- Per-diet settings the patient controls (fasting window, Whole30 start day).
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- Screening answers as they stood when this choice was made (PHI).
  screening_snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(screening_snapshot) = 'object'),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists patient_diet_selections_active_idx
  on public.patient_diet_selections (patient_id) where status = 'active';
create unique index if not exists patient_diet_selections_pending_idx
  on public.patient_diet_selections (patient_id) where status = 'pending_review';
create index if not exists patient_diet_selections_patient_created_idx
  on public.patient_diet_selections (patient_id, created_at desc);
comment on table public.patient_diet_selections is
  'Every diet a patient (or their provider) chose, with status. At most one active and one pending row per patient; superseded rows are the history. Service-role only.';
alter table public.patient_diet_selections enable row level security;
revoke all on public.patient_diet_selections from public, anon, authenticated;
grant all on public.patient_diet_selections to service_role;

-- ── Safety blocks and the two-step provider override ────────────────────────
create table if not exists public.patient_diet_blocks (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  selection_id uuid not null references public.patient_diet_selections(id) on delete cascade,
  diet_slug text not null,
  -- The screening questions answered "yes" that parked the pick.
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  status text not null default 'pending' check (status in ('pending', 'overridden', 'rejected', 'withdrawn')),
  -- Step one of the override hands out a short-lived challenge; step two
  -- must echo it. Both steps are audited.
  override_challenge text,
  override_challenged_at timestamptz,
  override_challenged_by uuid,
  reviewed_by uuid,
  reviewed_by_name text check (reviewed_by_name is null or char_length(reviewed_by_name) <= 160),
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 500),
  created_at timestamptz not null default now(),
  constraint patient_diet_blocks_review_consistent check (
    (status = 'pending' and reviewed_at is null)
    or (status <> 'pending' and reviewed_at is not null)
  )
);
create index if not exists patient_diet_blocks_patient_status_idx
  on public.patient_diet_blocks (patient_id, status, created_at desc);
comment on table public.patient_diet_blocks is
  'Diet picks parked by a safety screening "yes", awaiting provider review. An override records who confirmed it and when. Service-role only.';
alter table public.patient_diet_blocks enable row level security;
revoke all on public.patient_diet_blocks from public, anon, authenticated;
grant all on public.patient_diet_blocks to service_role;

-- ── Preference lists: allergies, sensitivities, restrictions, dislikes ──────
create table if not exists public.patient_preference_items (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  list text not null check (list in ('allergy', 'sensitivity', 'restriction', 'dislike')),
  -- Catalog key (allergen / sensitivity / restriction key) or custom:<slug>.
  item_key text not null check (item_key ~ '^[a-z0-9_:.-]{1,80}$'),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  is_custom boolean not null default false,
  -- Allergies only: mild counts direct ingredients, severe also "may contain".
  severity text check (severity is null or severity in ('mild', 'severe')),
  entered_by uuid,
  entered_by_role text not null check (entered_by_role in ('patient', 'staff', 'migration')),
  entered_by_name text check (entered_by_name is null or char_length(entered_by_name) <= 160),
  removed_at timestamptz,
  removed_by uuid,
  removed_by_role text check (removed_by_role is null or removed_by_role in ('patient', 'staff')),
  created_at timestamptz not null default now(),
  constraint patient_preference_items_severity_list_check check (
    (list = 'allergy' and severity is not null) or (list <> 'allergy' and severity is null)
  ),
  constraint patient_preference_items_custom_key_check check (is_custom = (item_key like 'custom:%'))
);
create unique index if not exists patient_preference_items_live_idx
  on public.patient_preference_items (patient_id, list, item_key) where removed_at is null;
create index if not exists patient_preference_items_patient_idx
  on public.patient_preference_items (patient_id, list, created_at desc);
comment on table public.patient_preference_items is
  'The four per-patient food lists. Removal is a timestamp (history kept); custom free-text items are flagged and keyed custom:<slug>. Service-role only.';
alter table public.patient_preference_items enable row level security;
revoke all on public.patient_preference_items from public, anon, authenticated;
grant all on public.patient_preference_items to service_role;

-- Legacy onboarding answers: vegan / vegetarian / gluten-free were ticked in
-- a JSON blob nobody read. They become restrictions (kept, not dropped).
insert into public.patient_preference_items (patient_id, list, item_key, label, is_custom, entered_by_role)
select f.patient_id, 'restriction',
       case d.value when 'gluten-free' then 'gluten_free' else d.value end,
       case d.value when 'vegan' then 'Vegan' when 'vegetarian' then 'Vegetarian' else 'Gluten-free' end,
       false, 'migration'
from public.patient_flags f
cross join lateral jsonb_array_elements_text(
  case when jsonb_typeof(f.onboarding_answers -> 'diets') = 'array' then f.onboarding_answers -> 'diets' else '[]'::jsonb end
) as d(value)
join public.patients p on p.id = f.patient_id and p.archived_at is null
where d.value in ('vegan', 'vegetarian', 'gluten-free')
on conflict do nothing;

-- ── Screening answers (PHI) ─────────────────────────────────────────────────
create table if not exists public.patient_screening_answers (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  question text not null check (question in ('medication', 'eating_disorder', 'pregnancy')),
  answer text not null check (answer in ('yes', 'no', 'skipped')),
  -- Which diet pick prompted the question, when one did.
  context_diet_slug text,
  answered_by uuid,
  answered_by_role text not null check (answered_by_role in ('patient', 'staff')),
  created_at timestamptz not null default now()
);
create index if not exists patient_screening_answers_latest_idx
  on public.patient_screening_answers (patient_id, question, created_at desc);
comment on table public.patient_screening_answers is
  'Append-only safety screening answers (insulin/diabetes medication, eating-disorder history, pregnancy/breastfeeding). The latest row per question is current. PHI; service-role only.';
alter table public.patient_screening_answers enable row level security;
revoke all on public.patient_screening_answers from public, anon, authenticated;
grant all on public.patient_screening_answers to service_role;

-- ── Activity level history ──────────────────────────────────────────────────
create table if not exists public.patient_activity_levels (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  level text not null check (level in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  source text not null check (source in ('diet_selection', 'check_in', 'settings', 'staff')),
  recorded_on date not null,
  recorded_by uuid,
  recorded_by_role text not null default 'patient' check (recorded_by_role in ('patient', 'staff')),
  created_at timestamptz not null default now()
);
create index if not exists patient_activity_levels_latest_idx
  on public.patient_activity_levels (patient_id, recorded_on desc, created_at desc);
comment on table public.patient_activity_levels is
  'Append-only activity level answers (asked at diet selection and every weekly check-in); the latest row feeds the target calculator. Service-role only.';
alter table public.patient_activity_levels enable row level security;
revoke all on public.patient_activity_levels from public, anon, authenticated;
grant all on public.patient_activity_levels to service_role;

-- ── Calculated target snapshots ─────────────────────────────────────────────
create table if not exists public.patient_target_snapshots (
  patient_id uuid not null references public.patients(id) on delete cascade,
  date_key date not null,
  phase text not null check (phase in ('protocol', 'maintenance')),
  program_day integer not null check (program_day >= 1),
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  calculated jsonb not null check (jsonb_typeof(calculated) = 'object'),
  effective jsonb not null check (jsonb_typeof(effective) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (patient_id, date_key)
);
comment on table public.patient_target_snapshots is
  'One row per patient per day: the inputs the calculator saw, what it produced and what applied after overrides. Lets staff and the patient see why a target changed. Service-role only.';
alter table public.patient_target_snapshots enable row level security;
revoke all on public.patient_target_snapshots from public, anon, authenticated;
grant all on public.patient_target_snapshots to service_role;

-- ── Edit history: admit the diet family ─────────────────────────────────────
alter table public.patient_edit_history drop constraint if exists patient_edit_history_family_check;
alter table public.patient_edit_history
  add constraint patient_edit_history_family_check
  check (family in ('profile', 'status', 'weight', 'measurement', 'medication', 'note', 'diet'));

-- ── Staff outbox: admit the diet alert kinds (office-scoped) ────────────────
alter table public.staff_notifications drop constraint if exists staff_notifications_kind_check;
alter table public.staff_notifications
  add constraint staff_notifications_kind_check
  check (kind in (
    'staff_attention_digest', 'system_threshold', 'office_access_restricted', 'coach_chat_flag', 'weekly_customer_health',
    'diet_change', 'diet_safety', 'diet_allergy_severe'
  ));
alter table public.staff_notifications drop constraint if exists staff_notifications_scope_check;
alter table public.staff_notifications
  add constraint staff_notifications_scope_check
  check (
    (kind in ('system_threshold', 'office_access_restricted', 'weekly_customer_health') and provider_id is null)
    or (kind not in ('system_threshold', 'office_access_restricted', 'weekly_customer_health') and provider_id is not null)
  );

-- ── Identity write barrier ──────────────────────────────────────────────────
select private.install_patient_identity_write_guards();
