-- Hardening for live provider accounts after the canonical-id cutover.
-- Reapply the create function from the preceding migration so already-running
-- projects receive its concurrency and Auth-phone protections.

-- Convert the known demo-era acct-<provider_id> aliases wherever the matching
-- canonical provider exists. Imported values that do not resolve are left
-- untouched rather than guessed.
update public.profiles profile
set provider_account_code = substring(profile.provider_account_code from 6)
where profile.provider_account_code like 'acct-%'
  and exists (
    select 1 from public.providers provider
    where provider.provider_id = substring(profile.provider_account_code from 6)
  );

update public.staff_role_assignments assignment
set provider_account_code = substring(assignment.provider_account_code from 6)
where assignment.provider_account_code like 'acct-%'
  and exists (
    select 1 from public.providers provider
    where provider.provider_id = substring(assignment.provider_account_code from 6)
  );

update public.training_viewers viewer
set account_id = substring(viewer.account_id from 6)
where viewer.account_id like 'acct-%'
  and exists (
    select 1 from public.providers provider
    where provider.provider_id = substring(viewer.account_id from 6)
  );

insert into public.provider_account_locks (account_id, locked_at)
select substring(lock_row.account_id from 6), lock_row.locked_at
from public.provider_account_locks lock_row
where lock_row.account_id like 'acct-%'
  and exists (
    select 1 from public.providers provider
    where provider.provider_id = substring(lock_row.account_id from 6)
  )
on conflict (account_id) do nothing;

delete from public.provider_account_locks lock_row
where lock_row.account_id like 'acct-%'
  and exists (
    select 1 from public.providers provider
    where provider.provider_id = substring(lock_row.account_id from 6)
  );

-- During mixed-version rollout, treat acct-X and X as the same lock identity.
create or replace function private.provider_account_is_locked(p_account_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.provider_account_locks lock_row
    where lock_row.account_id = p_account_id
       or lock_row.account_id = case
            when p_account_id like 'acct-%' then substring(p_account_id from 6)
            else 'acct-' || p_account_id
          end
  );
$$;

revoke all on function private.provider_account_is_locked(text) from public;
grant execute on function private.provider_account_is_locked(text) to authenticated;

create or replace function private.claimed_provider_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with resolved as (
    select coalesce(
      (select provider_id from public.providers where auth_user_id = (select auth.uid()) limit 1),
      (select provider_id from public.team_members where auth_user_id = (select auth.uid()) limit 1)
    ) as provider_id
  )
  select provider_id
  from resolved
  where provider_id is not null
    and not private.provider_account_is_locked(provider_id);
$$;

revoke all on function private.claimed_provider_id() from public;
grant execute on function private.claimed_provider_id() to authenticated;

-- Self-row policies must also respect the same canonical provider lock.
drop policy if exists "Providers read their own record" on public.providers;
create policy "Providers read their own record"
  on public.providers for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    and not private.provider_account_is_locked(provider_id)
  );

drop policy if exists "Team members read their own record" on public.team_members;
create policy "Team members read their own record"
  on public.team_members for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    and not private.provider_account_is_locked(provider_id)
  );

create or replace function public.hq_create_provider_account(
  p_created_by uuid, p_office_name text, p_provider_name text,
  p_provider_role text, p_email text, p_phone text, p_city text,
  p_state text, p_plan text
)
returns public.providers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider public.providers%rowtype;
  v_digits text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_phone_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if not exists (
    select 1 from public.profiles
    where id = p_created_by and role = 'hq_admin'::public.app_role
  ) then raise exception 'Only HQ administrators can create provider accounts.';
  end if;
  if trim(coalesce(p_office_name, '')) = '' or trim(coalesce(p_provider_name, '')) = '' then
    raise exception 'Office and provider names are required.';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid provider email address.';
  end if;
  if p_plan is not null and p_plan not in ('Core', 'Plus', 'Concierge') then
    raise exception 'Choose a valid plan.';
  end if;
  if length(v_phone_digits) > 0 and length(v_phone_digits) < 10 then
    raise exception 'Enter a valid provider phone number.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-email:' || v_email, 0)
  );
  if length(v_phone_digits) >= 10 then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('provider-phone:' || right(v_phone_digits, 10), 0)
    );
  end if;

  if exists (
    select 1 from public.providers
    where lower(coalesce(email, '')) = v_email
       or (
         length(v_phone_digits) >= 10
         and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
         and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(v_phone_digits, 10)
       )
  ) then raise exception 'A provider with that contact already exists.';
  end if;
  if exists (
    select 1 from public.team_members where lower(coalesce(email, '')) = v_email
  ) then raise exception 'A staff member with that email already exists.';
  end if;
  if exists (
    select 1 from auth.users
    where lower(coalesce(email, '')) = v_email
       or (
         length(v_phone_digits) >= 10
         and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
         and right(regexp_replace(phone, '\D', '', 'g'), 10) = right(v_phone_digits, 10)
       )
  ) then raise exception 'That contact already has a login.';
  end if;

  loop
    v_digits := lpad((floor(random() * 1000000))::text, 6, '0');
    begin
      insert into public.providers (
        provider_id, provider_name, office_name, email, phone, city, state,
        provider_role, plan, onboarding_code, access_disabled
      ) values (
        'live-' || replace(gen_random_uuid()::text, '-', ''),
        trim(p_provider_name), trim(p_office_name), v_email, nullif(trim(p_phone), ''),
        nullif(trim(p_city), ''), nullif(upper(trim(p_state)), ''),
        nullif(trim(p_provider_role), ''), p_plan, v_digits, false
      ) returning * into v_provider;
      exit;
    exception when unique_violation then
      if not exists (
        select 1 from public.providers where onboarding_code = v_digits
      ) then raise;
      end if;
    end;
  end loop;
  return v_provider;
end;
$$;

revoke all on function public.hq_create_provider_account(uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.hq_create_provider_account(uuid, text, text, text, text, text, text, text, text)
  to service_role;