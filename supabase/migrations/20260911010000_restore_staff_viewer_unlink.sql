-- Restore the training-viewer link maintenance that 20260828 built into
-- sync_staff_role_assignment and 20260902's rewrite accidentally dropped.
--
-- Semantics are the 20260902 version (profile elevation requires a confirmed,
-- server-provisioned account) PLUS the 20260828 viewer-link upkeep:
--   * revoking (or moving) an assignment severs training_viewers.auth_user_id
--     so the revoked sign-in loses its own-row path while HQ keeps history;
--   * a non-DELETE write re-links (or creates) the viewer row for a
--     confirmed, provisioned provider staffer right away, so an office move
--     never leaves active staff unlinked.

create or replace function public.sync_staff_role_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_display_name text;
begin
  -- Revoke the prior address first. This covers an assignment being deleted
  -- or moved to a new address, and keeps no stale elevated profile behind.
  if tg_op in ('UPDATE', 'DELETE') then
    update public.profiles
    set role = 'patient'::public.app_role,
        provider_account_code = null
    where lower(email) = lower(old.email);

    -- Sever the training link too: the viewer row (and its history) stays
    -- for HQ, but the revoked sign-in loses its own-row read/write path.
    -- On an office move (same email still assigned below) the non-DELETE
    -- branch re-links immediately, so active staff are unaffected.
    update public.training_viewers viewer
    set auth_user_id = null
    from auth.users user_record
    where viewer.auth_user_id = user_record.id
      and lower(user_record.email) = lower(old.email);
  end if;

  if tg_op <> 'DELETE' then
    update public.profiles profile
    set role = new.role,
        provider_account_code = new.provider_account_code
    from auth.users user_record
    where profile.id = user_record.id
      and lower(user_record.email) = lower(new.email)
      and user_record.email_confirmed_at is not null
      and coalesce(user_record.raw_app_meta_data ->> 'thinnr_provisioned', '') = 'true';

    -- If a confirmed, provisioned account already exists for this email,
    -- link (or create) its training viewer row under the assigned office.
    if new.role = 'provider_staff'::public.app_role then
      select user_record.id, profile.display_name
      into v_user_id, v_display_name
      from auth.users user_record
      left join public.profiles profile on profile.id = user_record.id
      where lower(user_record.email) = lower(new.email)
        and user_record.email_confirmed_at is not null
        and coalesce(user_record.raw_app_meta_data ->> 'thinnr_provisioned', '') = 'true'
      limit 1;

      if v_user_id is not null then
        perform private.link_staff_training_viewer(
          v_user_id, new.email, v_display_name, new.provider_account_code
        );
      end if;
    end if;

    return new;
  end if;

  return old;
end;
$$;

revoke all on function public.sync_staff_role_assignment() from public, anon, authenticated;
