-- THINNR patient progress rail — photos, check-ins, and account flags.
--
-- The last device-local slices of the patient companion move onto the
-- account: the progress photo grid, weekly check-ins (weight + answers),
-- the stall-nudge outreach state, and onboarding answers/completion plus
-- notification preferences. Every row is keyed by patients.id (the clinical
-- row an auth user resolves to via patients.auth_user_id), so reinstalling
-- the app or signing in on a second device rebuilds the same progress view.
--
-- Progress photo BYTES ride the existing per-patient media rail
-- (/objects/patient-media/<patient_id>/progress-<id>) with their own object
-- kind in the patient_media ledger; the rows here are the GRID entries the
-- app renders (angle, label, capture day) pointing at those objects. The
-- object_path ownership check makes a row that points into another
-- patient's folder unrepresentable.
--
-- RLS: enabled with NO policies on purpose, and privileges revoked from
-- anon/authenticated. Only the API server's service role (which bypasses
-- RLS) reads or writes; the mobile app always goes through
-- /api/patient-data/* with a bearer session token. Do not add
-- anon/authenticated policies here.
--
-- Safe to re-run: guarded with IF NOT EXISTS / OR REPLACE.

-- ── Progress photos in the media ledger ─────────────────────────────────────
--
-- Progress photo copies ride the patient-media rail (upload-url → presigned
-- PUT → finalize) with their own object kind, replacing the old anonymous
-- progress-photos upload path. Widen the ledger's kind check.

alter table public.patient_media drop constraint if exists patient_media_kind_check;
alter table public.patient_media add constraint patient_media_kind_check
  check (kind in ('food', 'recipe', 'chat', 'progress'));

-- ── Progress photo grid ─────────────────────────────────────────────────────

create table if not exists public.patient_progress_photos (
  patient_id uuid not null references public.patients(id) on delete cascade,
  -- Client-generated id (e.g. "photo_mf2k1x_7"); opaque to the server.
  photo_id text not null
    check (photo_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  date_key date not null,
  label text not null
    check (char_length(label) between 1 and 80),
  -- Guided-session pose; null for free-form uploads from the picker.
  angle text
    check (angle is null or angle in ('front', 'side', 'back')),
  -- Where the bytes live. Must sit inside THIS patient's media folder with
  -- the progress kind prefix — a row pointing at another patient's object
  -- (or a non-progress object) is unrepresentable.
  object_path text not null
    check (object_path like ('/objects/patient-media/' || patient_id::text || '/progress-%')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (patient_id, photo_id)
);

create index if not exists patient_progress_photos_by_day
  on public.patient_progress_photos (patient_id, date_key);

comment on table public.patient_progress_photos is
  'Per-patient progress photo grid entries (capture day, label, guided-session angle) pointing at objects on the patient-media rail. Written and read solely by the API server via the service role; RLS is enabled with no policies by design.';

alter table public.patient_progress_photos enable row level security;
revoke all on public.patient_progress_photos from anon, authenticated;

-- ── Check-ins ───────────────────────────────────────────────────────────────
--
-- One check-in per day: the app replaces a same-day re-submit, so the day is
-- the natural key and an upsert swaps in the newer answers wholesale
-- (including the client-generated check_in_id).

create table if not exists public.patient_check_ins (
  patient_id uuid not null references public.patients(id) on delete cascade,
  date_key date not null,
  -- Client-generated id (e.g. "ci_mf2k1x_7"); opaque to the server.
  check_in_id text not null
    check (check_in_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  -- Pounds, rounded to 0.1 by the app; null when the patient skipped it.
  weight numeric
    check (weight is null or (weight >= 1 and weight <= 1500)),
  mood integer not null
    check (mood between 1 and 5),
  side_effects jsonb not null default '[]'::jsonb
    check (jsonb_typeof(side_effects) = 'array'),
  notes text
    check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (patient_id, date_key)
);

comment on table public.patient_check_ins is
  'Per-patient weekly check-ins (weight, mood, side effects, notes), one per day — a same-day re-submit replaces the row. Written and read solely by the API server via the service role; RLS is enabled with no policies by design.';

alter table public.patient_check_ins enable row level security;
revoke all on public.patient_check_ins from anon, authenticated;

-- ── Account flags & preferences ─────────────────────────────────────────────
--
-- One row per patient: stall-nudge outreach state (opt-out, engagement, the
-- cooldown anchors), onboarding answers/completion, and notification
-- preferences. Partial upserts merge fields; absent fields keep their value.

create table if not exists public.patient_flags (
  patient_id uuid primary key references public.patients(id) on delete cascade,
  -- Patient paused coach stall nudges (re-enabled from the check-in).
  nudge_opt_out boolean not null default false,
  -- Patient replied after the current episode's outreach appeared.
  nudge_engaged boolean not null default false,
  -- Date key the last outreach seeded on — anchors the cooldown window.
  nudge_last_sent_key date,
  -- crossedOnKey of the episode that outreach belonged to.
  nudge_last_crossing_key date,
  onboarding_complete boolean not null default false,
  -- The onboarding questionnaire's answer object, stored as the app shaped
  -- it; opaque to the server beyond being a JSON object.
  onboarding_answers jsonb
    check (onboarding_answers is null or jsonb_typeof(onboarding_answers) = 'object'),
  -- Reminder/notification switches derived from onboarding (and later from
  -- settings); opaque to the server beyond being a JSON object.
  notification_prefs jsonb
    check (notification_prefs is null or jsonb_typeof(notification_prefs) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.patient_flags is
  'Per-patient account flags: stall-nudge outreach state, onboarding answers/completion, notification preferences. Written and read solely by the API server via the service role; RLS is enabled with no policies by design.';

alter table public.patient_flags enable row level security;
revoke all on public.patient_flags from anon, authenticated;

-- ── Photo removal (rows + ledger, one transaction) ──────────────────────────
--
-- Deleting a progress photo must drop the grid row AND its patient_media
-- ledger row together, then hand the object path back to the API server so
-- it can delete the stored bytes. Ids that do not exist simply return no
-- path (idempotent — a replayed delete after a crash is safe).

create or replace function public.patient_progress_photos_remove(
  p_patient_id uuid,
  p_photo_ids text[]
)
returns text[]
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_paths text[];
begin
  if p_patient_id is null then
    raise exception 'patient id is required';
  end if;

  with removed as (
    delete from public.patient_progress_photos
    where patient_id = p_patient_id
      and photo_id = any(coalesce(p_photo_ids, array[]::text[]))
    returning object_path
  )
  select coalesce(array_agg(object_path), array[]::text[])
    into v_paths
    from removed;

  -- Keep the media ledger in lockstep: the object is about to be deleted.
  delete from public.patient_media
  where patient_id = p_patient_id
    and object_path = any(v_paths);

  return v_paths;
end;
$$;

revoke all on function public.patient_progress_photos_remove(uuid, text[])
  from public, anon, authenticated;
grant execute on function public.patient_progress_photos_remove(uuid, text[])
  to service_role;
