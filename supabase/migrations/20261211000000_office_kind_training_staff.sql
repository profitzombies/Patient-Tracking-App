-- Software-only offices: the self-serve training roster write closes too.
--
-- 20261210000000_office_kind.sql made every training READ fail closed for
-- staff of a software-only office (catalog policies, caller_provider_account,
-- caller_is_staff). The one training WRITE a provider staffer can reach,
-- public.training_add_staff, is SECURITY DEFINER and checked the caller's
-- office by reading profiles directly rather than through those helpers, so
-- a software-office staffer could still grow their office's training roster
-- by calling the RPC by hand.
--
-- This is a full replacement of the 20260829 version. The only change is the
-- kind refusal beside the existing lock refusal; HQ admins are unchanged and
-- may still add staff to any office.
--
-- Recreating a function resets nothing it declares inline, but the grants
-- are restated anyway so this file stands alone (re-runnable).

create or replace function public.training_add_staff(
  p_account_id text,
  p_name text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_account text := trim(coalesce(p_account_id, ''));
  v_name text := trim(coalesce(p_name, ''));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_caller_office text;
  v_existing public.staff_role_assignments%rowtype;
  v_viewer public.training_viewers%rowtype;
begin
  if v_uid is null then
    raise exception 'Sign in to add teammates.';
  end if;

  if v_account = '' or char_length(v_account) > 80 then
    raise exception 'Choose a valid office.';
  end if;

  if not private.is_hq_admin() then
    select profile.provider_account_code into v_caller_office
    from public.profiles profile
    where profile.id = v_uid
      and profile.role = 'provider_staff'::public.app_role;

    if v_caller_office is null or v_caller_office <> v_account then
      raise exception 'You can only add teammates to your own office.';
    end if;

    -- A locked office cannot grow its roster while locked.
    if private.provider_account_is_locked(v_caller_office) then
      raise exception 'This account is locked by THINNR. Contact THINNR to restore access.';
    end if;

    -- A software-only office has no Training at all, so there is no training
    -- roster for its staff to add to.
    if private.caller_office_is_software() then
      raise exception 'Training is not part of this office''s THINNR plan.';
    end if;
  end if;

  if char_length(v_email) < 3 or char_length(v_email) > 320
    or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.';
  end if;

  if v_name = '' then
    raise exception 'Enter the teammate''s name.';
  end if;

  select * into v_existing
  from public.staff_role_assignments
  where lower(email) = v_email;

  if found then
    if v_existing.role <> 'provider_staff'::public.app_role
      or coalesce(v_existing.provider_account_code, '') <> v_account then
      raise exception 'That email already has a different staff assignment.';
    end if;
    -- Same office, same role: fall through and make sure the viewer exists.
  else
    insert into public.staff_role_assignments (email, role, provider_account_code)
    values (v_email, 'provider_staff'::public.app_role, v_account);
    -- The sync trigger elevates an already-confirmed account and links
    -- its viewer row immediately.
  end if;

  select * into v_viewer
  from public.training_viewers
  where lower(email) = v_email
  order by created_at asc
  limit 1;

  if found then
    update public.training_viewers
    set account_id = v_account,
        name = case
          when coalesce(trim(name), '') in ('', '—') then left(v_name, 120)
          else name
        end
    where id = v_viewer.id
    returning * into v_viewer;
  else
    if (select count(*) from public.training_viewers) >= 5000 then
      raise exception 'The demo viewer roster is full.';
    end if;

    insert into public.training_viewers
      (name, email, phone, account_id, location, sessions, is_demo)
    values
      (left(v_name, 120), v_email, '—', v_account, '—', 0, false)
    returning * into v_viewer;
  end if;

  return jsonb_build_object('viewer', to_jsonb(v_viewer));
end;
$$;

revoke all on function public.training_add_staff(text, text, text) from public, anon;
grant execute on function public.training_add_staff(text, text, text) to authenticated;
