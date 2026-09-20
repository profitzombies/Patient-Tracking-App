-- Existing practices are grandfathered; only INSERTs after rollout require launch.
create table public.practice_launch (
  provider_id text primary key references public.providers(provider_id) on delete cascade,
  required boolean not null default true,
  version integer not null default 0,
  details_confirmed boolean not null default false,
  products_confirmed boolean not null default false,
  completed_at timestamptz
);
insert into public.practice_launch(provider_id,required) select provider_id,false from public.providers;
alter table public.practice_launch enable row level security;
revoke all on public.practice_launch from anon,authenticated;
create table public.practice_launch_tours (
  provider_id text not null references public.providers(provider_id) on delete cascade,
  actor_user_id uuid not null,
  step integer not null default 0 check(step between 0 and 5),
  status text not null default 'not_started' check(status in ('not_started','active','skipped','completed')),
  primary key(provider_id,actor_user_id)
);
alter table public.practice_launch_tours enable row level security;
revoke all on public.practice_launch_tours from anon,authenticated;
grant all on public.practice_launch,public.practice_launch_tours to service_role;
create function public.initialize_practice_launch() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  insert into public.practice_launch(provider_id) values(new.provider_id);
  return new;
end $$;
create trigger initialize_practice_launch after insert on public.providers
for each row execute function public.initialize_practice_launch();

create function public.save_practice_launch_details(p_provider_id text,p_expected_version integer,p_details jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare launch public.practice_launch%rowtype;
begin
  select * into launch from public.practice_launch where provider_id=p_provider_id for update;
  -- Identical retries are safe, but never accept a different stale write.
  if launch.details_confirmed and exists(select 1 from public.providers where provider_id=p_provider_id
    and office_name=p_details->>'officeName' and provider_name=p_details->>'providerName'
    and email=p_details->>'email' and phone=p_details->>'phone' and address_line_1=p_details->>'address1'
    and coalesce(address_line_2,'')=coalesce(p_details->>'address2','')
    and city=p_details->>'city' and state=p_details->>'state' and postal_code=p_details->>'postalCode') then return; end if;
  if not found or launch.version<>p_expected_version then
    raise exception 'Practice setup changed. Reload and try again.' using errcode='40001';
  end if;
  update public.providers set office_name=p_details->>'officeName',provider_name=p_details->>'providerName',
    email=p_details->>'email',phone=p_details->>'phone',address_line_1=p_details->>'address1',
    address_line_2=p_details->>'address2',city=p_details->>'city',state=p_details->>'state',
    postal_code=p_details->>'postalCode' where provider_id=p_provider_id;
  update public.practice_launch set details_confirmed=true,version=version+1 where provider_id=p_provider_id;
end $$;
revoke all on function public.save_practice_launch_details(text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_practice_launch_details(text,integer,jsonb) to service_role;

create function public.complete_practice_launch(p_provider_id text,p_expected_version integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare launch public.practice_launch%rowtype;
begin
  select * into launch from public.practice_launch where provider_id=p_provider_id for update;
  if launch.completed_at is not null then return; end if;
  if not found or launch.version<>p_expected_version then
    raise exception 'Practice setup changed. Reload and try again.' using errcode='40001';
  end if;
  if not launch.details_confirmed or not launch.products_confirmed then
    raise exception 'Confirm practice details and products first.' using errcode='22023';
  end if;
  update public.practice_launch set completed_at=now(),version=version+1 where provider_id=p_provider_id;
end $$;
revoke all on function public.complete_practice_launch(text,integer) from public,anon,authenticated;
grant execute on function public.complete_practice_launch(text,integer) to service_role;