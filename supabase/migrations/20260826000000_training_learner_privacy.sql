-- Training portal — learner privacy and capability-token hardening.
--
-- The first training migration opened SELECT on every training table because
-- "all rows are fake". That held for the seed, but not for the email gate:
-- a visitor who types a real address would have published it (plus activity)
-- to every anonymous caller, and open viewer ids let anyone invoke the
-- learner RPCs for somebody else. This migration closes both holes:
--
--   1. `training_viewers.is_demo` — anon/authenticated non-admins can read
--      ONLY seeded demo rows (and completions/invites belonging to them).
--      Gate registrations are visible to real HQ admins alone. The demo
--      persona still browses a full, obviously-fake roster.
--   2. `training_learner_sessions` — an unguessable per-registration token,
--      readable by nobody (no grants, no policies; only the SECURITY DEFINER
--      RPCs touch it). All learner actions are keyed by token, never by a
--      caller-supplied viewer id:
--        training_register_viewer(p_email)        → {viewer, token, completions}
--        training_learner_state(p_token)          → {viewer, completions}
--        training_mark_video_complete(p_token, p_video_id) → completion row
--        training_invite_staff(p_token, p_email)  → {invited: true}
--      The old id-keyed signatures are DROPPED so no viewer-id write path
--      remains. Repeat gate hits for a known email get a debounced activity
--      bump (can't inflate session counts) and invites are capped per viewer.
--
-- Course catalog reads (courses/modules/subgroups/videos) stay public: pure
-- authored content, no personal data.
--
-- Safe to re-run: IF NOT EXISTS / drop-and-recreate throughout.

-- ---------------------------------------------------------------------------
-- Viewer privacy flag
-- ---------------------------------------------------------------------------

alter table public.training_viewers
  add column if not exists is_demo boolean not null default false;

comment on column public.training_viewers.is_demo is
  'True only for seeded demo roster rows. Non-demo rows (email-gate registrations) are readable by HQ admins only.';

-- One-time backfill: every pre-privacy row came from the seed, whose fake
-- addresses all live under example.com domains.
update public.training_viewers
set is_demo = true
where is_demo = false
  and (email like '%.example.com' or email like '%@example.com');

-- ---------------------------------------------------------------------------
-- Learner session tokens — the capability behind all learner RPCs
-- ---------------------------------------------------------------------------

create table if not exists public.training_learner_sessions (
  token uuid primary key default gen_random_uuid(),
  viewer_id uuid not null references public.training_viewers(id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.training_learner_sessions is
  'Opaque learner capabilities. No role may read this table; only the SECURITY DEFINER training RPCs touch it.';

create index if not exists training_learner_sessions_viewer_idx
  on public.training_learner_sessions (viewer_id, created_at desc);

alter table public.training_learner_sessions enable row level security;
revoke all on public.training_learner_sessions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scoped read policies (admin access continues to flow from the existing
-- "HQ admins manage …" FOR ALL policies)
-- ---------------------------------------------------------------------------

drop policy if exists "Training viewers are readable by everyone" on public.training_viewers;
drop policy if exists "Demo training viewers are readable by everyone" on public.training_viewers;
create policy "Demo training viewers are readable by everyone"
  on public.training_viewers for select to anon, authenticated
  using (is_demo);

drop policy if exists "Training completions are readable by everyone" on public.training_completions;
drop policy if exists "Demo training completions are readable by everyone" on public.training_completions;
create policy "Demo training completions are readable by everyone"
  on public.training_completions for select to anon, authenticated
  using (
    exists (
      select 1 from public.training_viewers viewer
      where viewer.id = training_completions.viewer_id and viewer.is_demo
    )
  );

drop policy if exists "Training invites are readable by everyone" on public.training_invites;
drop policy if exists "Demo training invites are readable by everyone" on public.training_invites;
create policy "Demo training invites are readable by everyone"
  on public.training_invites for select to anon, authenticated
  using (
    inviter_viewer_id is not null
    and exists (
      select 1 from public.training_viewers viewer
      where viewer.id = training_invites.inviter_viewer_id and viewer.is_demo
    )
  );

comment on table public.training_viewers is
  'Training viewers. Seeded demo rows (is_demo) are world-readable; email-gate registrations are HQ-admin-only.';

-- ---------------------------------------------------------------------------
-- Token-keyed learner RPCs (old id-keyed signatures dropped)
-- ---------------------------------------------------------------------------

drop function if exists public.training_register_viewer(text);
drop function if exists public.training_invite_staff(uuid, text);
drop function if exists public.training_mark_video_complete(uuid, uuid);
drop function if exists public.training_learner_state(uuid);

create function public.training_register_viewer(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text;
  v_viewer public.training_viewers%rowtype;
  v_token uuid;
  v_completions jsonb;
begin
  if char_length(v_email) < 3 or char_length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;

  select * into v_viewer
  from public.training_viewers
  where lower(email) = v_email;

  if found then
    -- Debounced activity bump: hammering the gate with a known email cannot
    -- inflate that viewer's session count.
    update public.training_viewers
    set last_seen_at = now(),
        sessions = sessions
          + (case when last_seen_at < now() - interval '30 minutes' then 1 else 0 end)
    where id = v_viewer.id
    returning * into v_viewer;
  else
    if (select count(*) from public.training_viewers) >= 5000 then
      raise exception 'The demo viewer roster is full.';
    end if;

    v_name := coalesce(
      nullif(trim(initcap(regexp_replace(split_part(v_email, '@', 1), '[._+\-0-9]+', ' ', 'g'))), ''),
      'New Viewer'
    );

    insert into public.training_viewers (name, email, phone, location, sessions, is_demo)
    values (left(v_name, 120), v_email, '—', '—', 1, false)
    returning * into v_viewer;
  end if;

  -- Keep at most the 24 newest tokens per viewer so repeat registrations
  -- cannot bloat the sessions table.
  delete from public.training_learner_sessions stale
  where stale.viewer_id = v_viewer.id
    and stale.token not in (
      select fresh.token
      from public.training_learner_sessions fresh
      where fresh.viewer_id = v_viewer.id
      order by fresh.created_at desc
      limit 24
    );

  insert into public.training_learner_sessions (viewer_id)
  values (v_viewer.id)
  returning token into v_token;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.first_watched_at), '[]'::jsonb)
    into v_completions
  from public.training_completions c
  where c.viewer_id = v_viewer.id;

  return jsonb_build_object('viewer', to_jsonb(v_viewer), 'token', v_token, 'completions', v_completions);
end;
$$;

create function public.training_learner_state(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_viewer public.training_viewers%rowtype;
  v_completions jsonb;
begin
  select viewer.* into v_viewer
  from public.training_learner_sessions session
  join public.training_viewers viewer on viewer.id = session.viewer_id
  where session.token = p_token;

  if not found then
    raise exception 'Session expired — enter your email to continue.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.first_watched_at), '[]'::jsonb)
    into v_completions
  from public.training_completions c
  where c.viewer_id = v_viewer.id;

  return jsonb_build_object('viewer', to_jsonb(v_viewer), 'completions', v_completions);
end;
$$;

create function public.training_mark_video_complete(p_token uuid, p_video_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_viewer public.training_viewers%rowtype;
  v_duration integer;
  v_completion public.training_completions%rowtype;
begin
  select viewer.* into v_viewer
  from public.training_learner_sessions session
  join public.training_viewers viewer on viewer.id = session.viewer_id
  where session.token = p_token;

  if not found then
    raise exception 'Session expired — enter your email to continue.';
  end if;

  select duration_seconds into v_duration
  from public.training_videos
  where id = p_video_id;
  if not found then
    raise exception 'That video no longer exists.';
  end if;

  insert into public.training_completions (viewer_id, video_id, watch_seconds, completed_at)
  values (v_viewer.id, p_video_id, v_duration, now())
  on conflict (viewer_id, video_id) do update
    set watch_seconds = greatest(public.training_completions.watch_seconds, excluded.watch_seconds),
        completed_at = coalesce(public.training_completions.completed_at, excluded.completed_at)
  returning * into v_completion;

  update public.training_viewers
  set last_seen_at = now()
  where id = v_viewer.id;

  return to_jsonb(v_completion);
end;
$$;

create function public.training_invite_staff(p_token uuid, p_email text)
returns jsonb
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
  select viewer.* into v_inviter
  from public.training_learner_sessions session
  join public.training_viewers viewer on viewer.id = session.viewer_id
  where session.token = p_token;

  if not found then
    raise exception 'Session expired — enter your email to continue.';
  end if;

  if char_length(v_email) < 3 or char_length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;

  if (select count(*) from public.training_invites where inviter_viewer_id = v_inviter.id) >= 25 then
    raise exception 'Invite limit reached for this training link.';
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

    -- Staff inherit the inviter's office AND visibility class: teammates of a
    -- seeded demo viewer join the public demo roster; teammates of a real
    -- gate registration stay HQ-admin-only.
    insert into public.training_viewers
      (name, email, phone, account_id, staff_of_viewer_id, location, sessions, is_demo)
    values
      (left(v_name, 120), v_email, '—', v_inviter.account_id, v_inviter.id, v_inviter.location, 0, v_inviter.is_demo)
    returning * into v_viewer;
  end if;

  if v_viewer.id <> v_inviter.id then
    insert into public.training_invites (inviter_viewer_id, email, invited_viewer_id)
    values (v_inviter.id, v_email, v_viewer.id);
  end if;

  update public.training_viewers
  set last_seen_at = now()
  where id = v_inviter.id;

  -- Deliberately NOT the invited viewer's row: knowing an email must not
  -- reveal whether/how that email uses the portal.
  return jsonb_build_object('invited', true);
end;
$$;

revoke all on function public.training_register_viewer(text) from public;
revoke all on function public.training_learner_state(uuid) from public;
revoke all on function public.training_mark_video_complete(uuid, uuid) from public;
revoke all on function public.training_invite_staff(uuid, text) from public;
grant execute on function public.training_register_viewer(text) to anon, authenticated;
grant execute on function public.training_learner_state(uuid) to anon, authenticated;
grant execute on function public.training_mark_video_complete(uuid, uuid) to anon, authenticated;
grant execute on function public.training_invite_staff(uuid, text) to anon, authenticated;
