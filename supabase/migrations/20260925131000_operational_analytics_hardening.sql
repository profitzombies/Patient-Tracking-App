-- Keep the append-only guard independent of every caller's search path.
-- The original migration also carries this definition for fresh databases;
-- this follow-up applies the hardening to databases where it already ran.

create or replace function public.reject_operational_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'operational event tables are append-only';
end;
$$;

revoke all on function public.reject_operational_event_mutation()
  from public, anon, authenticated;