-- Passwordless staff logins: one canonical, atomic provisioning rail.
--
-- Provider owners and legacy-imported office team members have no HQ
-- pre-approval row, so the signup triggers leave their logins with claim
-- markers and no profiles row; the operations session resolver then parks
-- them on the claimed-workspace placeholder instead of the office desk.
-- The API server calls this function (service role) at every provider /
-- team-member code verify — first logins and repairs alike — so a proven
-- staff code always resolves to an authorized office workspace:
--
--   1. staff_role_assignments upsert   (pre-approval becomes authoritative)
--   2. thinnr_provisioned marker       (future assignment moves keep syncing)
--   3. profiles upsert                 (role + provider_account_code route
--                                       the operations app, lock screen included)
--   4. training viewer link            (office roster row, same chain HQ
--                                       provisioning uses)
--
-- Service-role only: never callable from anon/authenticated clients.

create or replace function public.provision_staff_login(
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_account_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_account text := trim(coalesce(p_account_code, ''));
  v_name text := nullif(trim(coalesce(p_display_name, '')), '');
  v_assignment public.staff_role_assignments%rowtype;
  v_has_assignment boolean := false;
begin
  if p_user_id is null or v_email = '' or v_account = '' then
    raise exception 'provision_staff_login: user id, email and account code are required';
  end if;

  select * into v_assignment
  from public.staff_role_assignments
  where lower(email) = v_email
  limit 1;
  v_has_assignment := found;

  -- An HQ pre-approval outranks the office realms; login precedence makes
  -- this unreachable, so refuse loudly rather than repoint it.
  if v_has_assignment and v_assignment.role <> 'provider_staff'::public.app_role then
    raise exception 'provision_staff_login: % already carries a % assignment',
      v_email, v_assignment.role;
  end if;

  -- Marker first: the assignment sync trigger only elevates provisioned
  -- logins, and later office moves must keep working for this account.
  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
        || jsonb_build_object('thinnr_provisioned', true)
  where id = p_user_id;
  if not found then
    raise exception 'provision_staff_login: auth user % not found', p_user_id;
  end if;

  -- Assignment upsert, written only when something actually changes so the
  -- sync trigger's revoke-then-reelevate pass never runs as a no-op churn.
  if v_has_assignment then
    update public.staff_role_assignments
    set role = 'provider_staff'::public.app_role,
        provider_account_code = v_account,
        updated_at = now()
    where lower(email) = v_email
      and provider_account_code is distinct from v_account;
  else
    insert into public.staff_role_assignments (email, role, provider_account_code)
    values (v_email, 'provider_staff'::public.app_role, v_account)
    on conflict (email) do update
      set role = 'provider_staff'::public.app_role,
          provider_account_code = excluded.provider_account_code,
          updated_at = now()
      where public.staff_role_assignments.provider_account_code
        is distinct from excluded.provider_account_code;
  end if;

  -- The profiles row is what routes the operations app: provider_staff plus
  -- the office account code opens the office desk (its lock screen and the
  -- lock-aware RLS helpers key on this same code).
  insert into public.profiles (id, role, display_name, email, provider_account_code)
  values (p_user_id, 'provider_staff'::public.app_role, v_name, v_email, v_account)
  on conflict (id) do update
    set role = 'provider_staff'::public.app_role,
        provider_account_code = excluded.provider_account_code,
        display_name = coalesce(public.profiles.display_name, excluded.display_name),
        email = coalesce(public.profiles.email, excluded.email);

  perform private.link_staff_training_viewer(p_user_id, v_email, v_name, v_account);
end;
$$;

revoke all on function public.provision_staff_login(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.provision_staff_login(uuid, text, text, text)
  to service_role;
