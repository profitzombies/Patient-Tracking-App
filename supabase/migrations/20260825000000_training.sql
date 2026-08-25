-- THINNR HQ training portal — live course, viewer, and progress data.
--
-- Replaces the old in-memory/sessionStorage training mock. All rows are
-- intentionally fake demo content, so SELECT is open to the anon key (demo
-- personas browse read-only). Authoring writes require a real signed-in HQ
-- admin (private.is_hq_admin()). The learner preview's unauthenticated
-- actions (email-gate registration, staff invites, mark-complete) go through
-- the narrow SECURITY DEFINER RPCs at the bottom — anon has no direct write
-- access to any table.
--
-- Videos are METADATA ONLY: title, duration, chapters, attachments. No video
-- files are hosted anywhere and no storage provider is configured. The
-- nullable `video_source` column is a deliberately empty placeholder so a
-- storage provider can be plugged in later without reworking these tables.
--
-- Safe to re-run: tables/indexes use IF NOT EXISTS, policies and triggers
-- are dropped and recreated, functions are CREATE OR REPLACE.

-- ---------------------------------------------------------------------------
-- The non-recursive "is the caller an HQ admin?" helper. Kept in a private,
-- non-exposed schema; recreated here so this migration stands alone even on
-- a database where the profiles migration hasn't run yet.
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.is_hq_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and profile.role = 'hq_admin'::public.app_role
  );
$$;

revoke all on function private.is_hq_admin() from public;
grant usage on schema private to authenticated;
grant execute on function private.is_hq_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.training_courses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (char_length(slug) between 1 and 120),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  status text not null default 'draft' check (status in ('live', 'draft')),
  sequential_unlock boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.training_courses is
  'HQ training courses. Demo content — reads are intentionally public.';

create table if not exists public.training_modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.training_courses(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  published text not null default 'published' check (published in ('published', 'draft')),
  unlock_mode text not null default 'sequential' check (unlock_mode in ('sequential', 'free')),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_modules_course_idx
  on public.training_modules (course_id, position);

create table if not exists public.training_subgroups (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.training_modules(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  published text not null default 'published' check (published in ('published', 'draft')),
  unlock_mode text not null default 'free' check (unlock_mode in ('sequential', 'free')),
  -- Entry position within the module, interleaved with module-level videos.
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists training_subgroups_module_idx
  on public.training_subgroups (module_id, position);

create table if not exists public.training_videos (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.training_modules(id) on delete cascade,
  -- Null = the video sits directly at module level. If a sub-group row is
  -- deleted directly in SQL, its videos fall back to module level rather
  -- than being destroyed (the app moves them explicitly first).
  subgroup_id uuid references public.training_subgroups(id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  duration_seconds integer not null default 300 check (duration_seconds between 0 and 86400),
  published text not null default 'draft' check (published in ('published', 'draft')),
  unlock_mode text not null default 'sequential' check (unlock_mode in ('sequential', 'free')),
  add_staff text not null default 'auto' check (add_staff in ('auto', 'show', 'hidden')),
  -- Plain paragraphs: ["...", "..."].
  description jsonb not null default '[]'::jsonb,
  -- [{"id": "...", "at": seconds, "title": "..."}].
  chapters jsonb not null default '[]'::jsonb,
  thumbnail_chapter integer not null default 0 check (thumbnail_chapter >= 0),
  -- [{"id": "...", "name": "...", "sizeLabel": "..."}] — names only; no files
  -- are hosted anywhere.
  attachments jsonb not null default '[]'::jsonb,
  -- Position within the sub-group, or the entry position within the module
  -- (interleaved with sub-groups) when subgroup_id is null.
  position integer not null default 0,
  -- ALWAYS NULL today. Empty placeholder for a future hosted video file
  -- (URL or storage key). No storage provider is configured anywhere; when
  -- one is added later, it plugs in here without a schema rework.
  video_source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.training_videos.video_source is
  'Blank placeholder for a future video file source. No storage is configured; nothing writes this yet.';

create index if not exists training_videos_module_idx
  on public.training_videos (module_id, position);
create index if not exists training_videos_subgroup_idx
  on public.training_videos (subgroup_id);

create table if not exists public.training_viewers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 320),
  phone text not null default '—',
  -- Demo provider account code (e.g. acct-p1). Provider accounts themselves
  -- are still seeded app data, so this stays a loose text reference.
  account_id text,
  staff_of_viewer_id uuid references public.training_viewers(id) on delete set null,
  location text not null default '—',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sessions integer not null default 1 check (sessions >= 0),
  created_at timestamptz not null default now()
);

create unique index if not exists training_viewers_email_unique
  on public.training_viewers (lower(email));
create index if not exists training_viewers_staff_of_idx
  on public.training_viewers (staff_of_viewer_id);

create table if not exists public.training_invites (
  id uuid primary key default gen_random_uuid(),
  inviter_viewer_id uuid references public.training_viewers(id) on delete set null,
  email text not null check (char_length(email) between 3 and 320),
  invited_viewer_id uuid references public.training_viewers(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists training_invites_inviter_idx
  on public.training_invites (inviter_viewer_id);
create index if not exists training_invites_invited_idx
  on public.training_invites (invited_viewer_id);

create table if not exists public.training_completions (
  viewer_id uuid not null references public.training_viewers(id) on delete cascade,
  video_id uuid not null references public.training_videos(id) on delete cascade,
  -- Watch metadata: seconds actually watched (rewatches may exceed the video
  -- duration). A row with completed_at NULL means started but not finished.
  watch_seconds integer not null default 0 check (watch_seconds between 0 and 604800),
  first_watched_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (viewer_id, video_id)
);

create index if not exists training_completions_video_idx
  on public.training_completions (video_id);

-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------

create or replace function public.set_thinnr_training_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_training_courses_updated_at on public.training_courses;
create trigger set_training_courses_updated_at
  before update on public.training_courses
  for each row execute procedure public.set_thinnr_training_updated_at();

drop trigger if exists set_training_modules_updated_at on public.training_modules;
create trigger set_training_modules_updated_at
  before update on public.training_modules
  for each row execute procedure public.set_thinnr_training_updated_at();

drop trigger if exists set_training_subgroups_updated_at on public.training_subgroups;
create trigger set_training_subgroups_updated_at
  before update on public.training_subgroups
  for each row execute procedure public.set_thinnr_training_updated_at();

drop trigger if exists set_training_videos_updated_at on public.training_videos;
create trigger set_training_videos_updated_at
  before update on public.training_videos
  for each row execute procedure public.set_thinnr_training_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security: open reads, HQ-admin-only writes
-- ---------------------------------------------------------------------------

alter table public.training_courses enable row level security;
alter table public.training_modules enable row level security;
alter table public.training_subgroups enable row level security;
alter table public.training_videos enable row level security;
alter table public.training_viewers enable row level security;
alter table public.training_invites enable row level security;
alter table public.training_completions enable row level security;

-- Demo data is intentionally public to read; anon must never write directly.
revoke insert, update, delete on public.training_courses,
  public.training_modules, public.training_subgroups, public.training_videos,
  public.training_viewers, public.training_invites, public.training_completions
  from anon;
grant select on public.training_courses,
  public.training_modules, public.training_subgroups, public.training_videos,
  public.training_viewers, public.training_invites, public.training_completions
  to anon, authenticated;
grant insert, update, delete on public.training_courses,
  public.training_modules, public.training_subgroups, public.training_videos,
  public.training_viewers, public.training_invites, public.training_completions
  to authenticated;

drop policy if exists "Training courses are readable by everyone" on public.training_courses;
create policy "Training courses are readable by everyone"
  on public.training_courses for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training courses" on public.training_courses;
create policy "HQ admins manage training courses"
  on public.training_courses for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

drop policy if exists "Training modules are readable by everyone" on public.training_modules;
create policy "Training modules are readable by everyone"
  on public.training_modules for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training modules" on public.training_modules;
create policy "HQ admins manage training modules"
  on public.training_modules for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

drop policy if exists "Training subgroups are readable by everyone" on public.training_subgroups;
create policy "Training subgroups are readable by everyone"
  on public.training_subgroups for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training subgroups" on public.training_subgroups;
create policy "HQ admins manage training subgroups"
  on public.training_subgroups for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

drop policy if exists "Training videos are readable by everyone" on public.training_videos;
create policy "Training videos are readable by everyone"
  on public.training_videos for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training videos" on public.training_videos;
create policy "HQ admins manage training videos"
  on public.training_videos for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

drop policy if exists "Training viewers are readable by everyone" on public.training_viewers;
create policy "Training viewers are readable by everyone"
  on public.training_viewers for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training viewers" on public.training_viewers;
create policy "HQ admins manage training viewers"
  on public.training_viewers for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

drop policy if exists "Training invites are readable by everyone" on public.training_invites;
create policy "Training invites are readable by everyone"
  on public.training_invites for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training invites" on public.training_invites;
create policy "HQ admins manage training invites"
  on public.training_invites for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

drop policy if exists "Training completions are readable by everyone" on public.training_completions;
create policy "Training completions are readable by everyone"
  on public.training_completions for select to anon, authenticated using (true);
drop policy if exists "HQ admins manage training completions" on public.training_completions;
create policy "HQ admins manage training completions"
  on public.training_completions for all to authenticated
  using (private.is_hq_admin()) with check (private.is_hq_admin());

-- ---------------------------------------------------------------------------
-- Learner-preview RPCs — the ONLY unauthenticated write paths.
--
-- SECURITY DEFINER with an empty search_path; inputs are validated and every
-- write is narrow (registration, staff invite, mark-complete). All data in
-- this portal is fake demo content, so exposing these to anon is deliberate.
-- ---------------------------------------------------------------------------

create or replace function public.training_register_viewer(p_email text)
returns public.training_viewers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text;
  v_viewer public.training_viewers%rowtype;
begin
  if char_length(v_email) < 3 or char_length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;

  select * into v_viewer
  from public.training_viewers
  where lower(email) = v_email;

  if found then
    update public.training_viewers
    set last_seen_at = now(),
        sessions = sessions + 1
    where id = v_viewer.id
    returning * into v_viewer;
    return v_viewer;
  end if;

  if (select count(*) from public.training_viewers) >= 5000 then
    raise exception 'The demo viewer roster is full.';
  end if;

  v_name := coalesce(
    nullif(trim(initcap(regexp_replace(split_part(v_email, '@', 1), '[._+\-0-9]+', ' ', 'g'))), ''),
    'New Viewer'
  );

  insert into public.training_viewers (name, email, phone, location, sessions)
  values (left(v_name, 120), v_email, '—', '—', 1)
  returning * into v_viewer;
  return v_viewer;
end;
$$;

create or replace function public.training_invite_staff(p_inviter_viewer_id uuid, p_email text)
returns public.training_viewers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text;
  v_inviter public.training_viewers%rowtype;
  v_viewer public.training_viewers%rowtype;
begin
  select * into v_inviter
  from public.training_viewers
  where id = p_inviter_viewer_id;
  if not found then
    raise exception 'Sign in through the email gate before adding staff.';
  end if;

  if char_length(v_email) < 3 or char_length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;

  select * into v_viewer
  from public.training_viewers
  where lower(email) = v_email;

  if not found then
    if (select count(*) from public.training_viewers) >= 5000 then
      raise exception 'The demo viewer roster is full.';
    end if;

    v_name := coalesce(
      nullif(trim(initcap(regexp_replace(split_part(v_email, '@', 1), '[._+\-0-9]+', ' ', 'g'))), ''),
      'New Teammate'
    );

    -- Staff inherit the inviter's office so per-account rollups stay honest.
    insert into public.training_viewers
      (name, email, phone, account_id, staff_of_viewer_id, location, sessions)
    values
      (left(v_name, 120), v_email, '—', v_inviter.account_id, v_inviter.id, v_inviter.location, 0)
    returning * into v_viewer;
  end if;

  if v_viewer.id <> v_inviter.id then
    insert into public.training_invites (inviter_viewer_id, email, invited_viewer_id)
    values (v_inviter.id, v_email, v_viewer.id);
  end if;

  return v_viewer;
end;
$$;

create or replace function public.training_mark_video_complete(p_viewer_id uuid, p_video_id uuid)
returns public.training_completions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_duration integer;
  v_completion public.training_completions%rowtype;
begin
  if not exists (select 1 from public.training_viewers where id = p_viewer_id) then
    raise exception 'Sign in through the email gate before marking progress.';
  end if;

  select duration_seconds into v_duration
  from public.training_videos
  where id = p_video_id;
  if not found then
    raise exception 'That video no longer exists.';
  end if;

  insert into public.training_completions (viewer_id, video_id, watch_seconds, completed_at)
  values (p_viewer_id, p_video_id, v_duration, now())
  on conflict (viewer_id, video_id) do update
    set watch_seconds = greatest(public.training_completions.watch_seconds, excluded.watch_seconds),
        completed_at = coalesce(public.training_completions.completed_at, excluded.completed_at)
  returning * into v_completion;

  update public.training_viewers
  set last_seen_at = now()
  where id = p_viewer_id;

  return v_completion;
end;
$$;

revoke all on function public.training_register_viewer(text) from public;
revoke all on function public.training_invite_staff(uuid, text) from public;
revoke all on function public.training_mark_video_complete(uuid, uuid) from public;
grant execute on function public.training_register_viewer(text) to anon, authenticated;
grant execute on function public.training_invite_staff(uuid, text) to anon, authenticated;
grant execute on function public.training_mark_video_complete(uuid, uuid) to anon, authenticated;
