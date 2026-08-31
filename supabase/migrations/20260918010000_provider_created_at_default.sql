-- Live-created provider accounts need a durable joined date.

alter table public.providers
  alter column created_at set default now();

update public.providers
set created_at = now()
where created_at is null
  and provider_id like 'live-%';