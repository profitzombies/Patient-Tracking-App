-- Replace the already-deployed Support contact RPC without its former plan
-- column. DROP is required because PostgreSQL cannot change table-returning OUT
-- columns with CREATE OR REPLACE. Every statement is safe to reapply.
drop function if exists public.hq_provider_contact_directory();

create or replace function public.hq_provider_contact_directory()
returns table (
  provider_id text,
  provider_name text,
  office_name text,
  email text,
  phone text,
  city text,
  state text,
  provider_role text,
  access_disabled boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_hq_permission('provider_contact_read') then
    raise exception 'Not authorized to read provider contacts.';
  end if;

  return query
    select p.provider_id, p.provider_name, p.office_name, p.email, p.phone,
           p.city, p.state, p.provider_role, p.access_disabled,
           p.created_at, p.updated_at
    from public.providers p;
end;
$$;

revoke all on function public.hq_provider_contact_directory() from public, anon;
grant execute on function public.hq_provider_contact_directory() to authenticated;