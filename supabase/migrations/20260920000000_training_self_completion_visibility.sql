-- Training self-completion must obey the same learner-visible course and
-- sequential-unlock rules as the provider UI.  The previous RPC accepted any
-- training_videos row, which allowed a direct caller to complete drafts or
-- jump ahead in a sequential course.

create or replace function public.training_mark_video_complete_self(p_video_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_viewer public.training_viewers%rowtype;
  v_duration integer;
  v_completion public.training_completions%rowtype;
  v_course_id uuid;
  v_sequential boolean;
  v_effective_free boolean;
  v_already_complete boolean;
  v_frontier uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to track your training.';
  end if;

  -- caller_is_staff includes the active-role and provider-lock/revocation
  -- checks introduced by the preceding training staff migrations.
  if not private.caller_is_staff() then
    raise exception 'No training profile is linked to this sign-in yet.';
  end if;

  select * into v_viewer
  from public.training_viewers
  where auth_user_id = v_uid;
  if not found then
    raise exception 'No training profile is linked to this sign-in yet.';
  end if;

  -- A target must be in the learner-visible tree: a live course and published
  -- module, optional subgroup, and video.  This deliberately happens before
  -- the idempotency branch: hidden material is never completable.
  select course.id, course.sequential_unlock,
         (video.unlock_mode = 'free' or module.unlock_mode = 'free'
           or coalesce(subgroup.unlock_mode = 'free', false))
    into v_course_id, v_sequential, v_effective_free
  from public.training_videos video
  join public.training_modules module on module.id = video.module_id
  join public.training_courses course on course.id = module.course_id
  left join public.training_subgroups subgroup on subgroup.id = video.subgroup_id
  where video.id = p_video_id
    and course.status = 'live'
    and module.published = 'published'
    and video.published = 'published'
    and (video.subgroup_id is null or subgroup.published = 'published');
  if not found then
    raise exception 'That lesson is not available.';
  end if;

  select duration_seconds into v_duration from public.training_videos where id = p_video_id;
  select exists (
    select 1 from public.training_completions
    where viewer_id = v_viewer.id and video_id = p_video_id and completed_at is not null
  ) into v_already_complete;

  -- Finished visible lessons remain safely repeatable.  For an unfinished
  -- effective-sequential lesson, resolve the first unfinished visible lesson
  -- in the same ordering used by getOrderedVideos(): module position, then a
  -- root video before an equal-position subgroup, then subgroup video position.
  if not v_already_complete and v_sequential and not v_effective_free then
    select visible.video_id into v_frontier
    from (
      select candidate.video_id,
             candidate.module_position,
             candidate.module_id,
             candidate.entry_position,
             candidate.entry_kind,
             candidate.entry_id,
             candidate.video_position
      from (
        select video.id as video_id, module.position as module_position, module.id as module_id,
               video.position as entry_position, 0 as entry_kind, video.id as entry_id, 0 as video_position
        from public.training_videos video
        join public.training_modules module on module.id = video.module_id
        where module.course_id = v_course_id and module.published = 'published'
          and video.subgroup_id is null and video.published = 'published'
        union all
        select video.id, module.position, module.id, subgroup.position, 1, subgroup.id, video.position
        from public.training_videos video
        join public.training_subgroups subgroup on subgroup.id = video.subgroup_id
        join public.training_modules module on module.id = subgroup.module_id
        where module.course_id = v_course_id and module.published = 'published'
          and subgroup.published = 'published' and video.published = 'published'
      ) candidate
      left join public.training_completions completion
        on completion.viewer_id = v_viewer.id
       and completion.video_id = candidate.video_id
       and completion.completed_at is not null
      where completion.video_id is null
    ) visible
    order by visible.module_position, visible.module_id, visible.entry_position, visible.entry_kind,
             visible.entry_id, visible.video_position, visible.video_id
    limit 1;
    if v_frontier is distinct from p_video_id then
      raise exception 'Complete the current lesson before this one.';
    end if;
  end if;

  insert into public.training_completions (viewer_id, video_id, watch_seconds, completed_at)
  values (v_viewer.id, p_video_id, v_duration, now())
  on conflict (viewer_id, video_id) do update
    set watch_seconds = greatest(public.training_completions.watch_seconds, excluded.watch_seconds),
        completed_at = coalesce(public.training_completions.completed_at, excluded.completed_at)
  returning * into v_completion;

  update public.training_viewers
  set last_seen_at = now(),
      sessions = sessions + (case when last_seen_at < now() - interval '30 minutes' then 1 else 0 end)
  where id = v_viewer.id;
  return to_jsonb(v_completion);
end;
$$;

revoke all on function public.training_mark_video_complete_self(uuid) from public, anon;
grant execute on function public.training_mark_video_complete_self(uuid) to authenticated;