-- Consent to launch is tied to the reviewed Stripe environment. Changing mode
-- never loses the shared practice details or another environment's progress.
create table public.practice_launch_completions (
  provider_id text not null references public.providers(provider_id) on delete cascade,
  stripe_mode text not null check(stripe_mode in ('test','live')),
  platform_account_id text not null,
  completed_at timestamptz not null default now(),
  primary key(provider_id,stripe_mode,platform_account_id)
);
alter table public.practice_launch_completions enable row level security;
revoke all on public.practice_launch_completions from anon,authenticated;
grant all on public.practice_launch_completions to service_role;
drop function public.complete_practice_launch(text,integer);
create function public.complete_practice_launch(p_provider_id text,p_expected_version integer,p_stripe_mode text,p_platform_account_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare launch public.practice_launch%rowtype;
begin
  select * into launch from public.practice_launch where provider_id=p_provider_id for update;
  if not found then raise exception 'Practice setup not found.' using errcode='22023'; end if;
  if exists(select 1 from public.practice_launch_completions where provider_id=p_provider_id
    and stripe_mode=p_stripe_mode and platform_account_id=p_platform_account_id) then return; end if;
  if launch.version<>p_expected_version then
    raise exception 'Practice setup changed. Reload and try again.' using errcode='40001';
  end if;
  if not launch.details_confirmed or not launch.products_confirmed or not exists(
    select 1 from public.practice_launch_product_receipts where provider_id=p_provider_id
      and stripe_mode=p_stripe_mode and platform_account_id=p_platform_account_id) then
    raise exception 'Confirm details and product prices in the current payment mode.' using errcode='22023';
  end if;
  insert into public.practice_launch_completions(provider_id,stripe_mode,platform_account_id)
    values(p_provider_id,p_stripe_mode,p_platform_account_id);
  update public.practice_launch set completed_at=now(),version=version+1 where provider_id=p_provider_id;
end $$;
revoke all on function public.complete_practice_launch(text,integer,text,text) from public,anon,authenticated;
grant execute on function public.complete_practice_launch(text,integer,text,text) to service_role;