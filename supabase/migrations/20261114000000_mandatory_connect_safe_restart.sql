-- required now means full details/catalog setup, not exemption from payments.
alter table public.practice_launch add column regated_at timestamptz;
create table public.practice_launch_regates (
  id bigint generated always as identity primary key,
  provider_id text not null references public.providers(provider_id),
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
alter table public.practice_launch_regates enable row level security;
revoke all on public.practice_launch_regates from public,anon,authenticated;
grant select,insert on public.practice_launch_regates to service_role;
grant usage on sequence public.practice_launch_regates_id_seq to service_role;

create or replace function public.regate_practice_launch(p_provider_id text,p_expected_version integer,p_actor uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.practice_launch%rowtype;
begin
  select * into l from public.practice_launch where provider_id=p_provider_id for update;
  if not found or l.version<>p_expected_version then raise exception 'Setup changed. Reload.' using errcode='40001'; end if;
  delete from public.practice_launch_completions where provider_id=p_provider_id;
  update public.practice_launch set completed_at=null,regated_at=clock_timestamp(),version=version+1 where provider_id=p_provider_id;
  insert into public.practice_launch_regates(provider_id,actor_user_id) values(p_provider_id,p_actor);
end $$;
revoke all on function public.regate_practice_launch(text,integer,uuid) from public,anon,authenticated;
grant execute on function public.regate_practice_launch(text,integer,uuid) to service_role;

create or replace function public.complete_practice_launch(p_provider_id text,p_expected_version integer,p_stripe_mode text,p_platform_account_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.practice_launch%rowtype; a public.billing_connected_accounts%rowtype;
begin
  select * into l from public.practice_launch where provider_id=p_provider_id for update;
  if not found then raise exception 'Setup unavailable.'; end if;
  select * into a from public.billing_connected_accounts where provider_id=p_provider_id
    and stripe_mode=p_stripe_mode and stripe_platform_account_id=p_platform_account_id for share;
  if not found or not a.charges_enabled or not a.payouts_enabled or not a.details_submitted
    or a.disconnected_at is not null or coalesce(jsonb_array_length(a.requirements->'currently_due'),0)>0
    or coalesce(jsonb_array_length(a.requirements->'past_due'),0)>0
    or a.last_synced_at is null or a.last_synced_at<clock_timestamp()-interval '2 minutes'
    or (l.regated_at is not null and a.last_synced_at<l.regated_at) then
    raise exception 'Fresh Stripe verification must confirm charges and payouts are ready.' using errcode='22023';
  end if;
  if exists(select 1 from public.practice_launch_completions where provider_id=p_provider_id
    and stripe_mode=p_stripe_mode and platform_account_id=p_platform_account_id) then return; end if;
  if l.version<>p_expected_version then raise exception 'Setup changed. Reload.' using errcode='40001'; end if;
  if l.required and (not l.details_confirmed or not l.products_confirmed or not exists(
    select 1 from public.practice_launch_product_receipts where provider_id=p_provider_id
      and stripe_mode=p_stripe_mode and platform_account_id=p_platform_account_id)) then
    raise exception 'Confirm details and product prices in the current payment mode.' using errcode='22023';
  end if;
  insert into public.practice_launch_completions(provider_id,stripe_mode,platform_account_id)
    values(p_provider_id,p_stripe_mode,p_platform_account_id);
  update public.practice_launch set completed_at=now(),version=version+1 where provider_id=p_provider_id;
end $$;

create table public.billing_connect_guards (
  provider_id text not null references public.providers(provider_id),
  stripe_mode text not null check(stripe_mode in ('test','live')),
  platform_account_id text not null,
  generation integer not null default 0,
  operation_token uuid,
  operation_kind text,
  ever_used boolean not null default false,
  primary key(provider_id,stripe_mode,platform_account_id)
);
create table public.billing_connect_archive (
  id bigint generated always as identity primary key,
  provider_id text not null references public.providers(provider_id),
  stripe_mode text not null,
  platform_account_id text not null,
  generation integer not null,
  account_snapshot jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.billing_connect_guards enable row level security;
alter table public.billing_connect_archive enable row level security;
revoke all on public.billing_connect_guards,public.billing_connect_archive from public,anon,authenticated;
grant select on public.billing_connect_guards,public.billing_connect_archive to service_role;
insert into public.billing_connect_guards(provider_id,stripe_mode,platform_account_id,ever_used)
  select provider_id,stripe_mode,stripe_platform_account_id,true from public.billing_connected_accounts
  where stripe_mode is not null and (charges_enabled or payouts_enabled);

-- Persistent claims deliberately have NO expiry: a timed-out Stripe mutation has
-- an unknown outcome and may never be unlocked automatically for replacement.
create function public.guard_office_connect(p_provider_id text,p_mode text,p_platform text,p_deployment text,p_action text,
  p_generation integer default null,p_token uuid default null,p_account jsonb default null,p_version integer default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.billing_connect_guards%rowtype; a public.billing_connected_accounts%rowtype; t text; used boolean; mode_version integer;
begin
  select version into mode_version from public.billing_mode_state where deployment_id=p_deployment and mode=p_mode
    and platform_account_id=p_platform and (p_version is null or version=p_version) for share;
  if not found then raise exception 'Payment mode changed. Reload.' using errcode='40001'; end if;
  insert into public.billing_connect_guards(provider_id,stripe_mode,platform_account_id)
    values(p_provider_id,p_mode,p_platform) on conflict do nothing;
  select * into g from public.billing_connect_guards where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform for update;
  select * into a from public.billing_connected_accounts where provider_id=p_provider_id and stripe_mode=p_mode and stripe_platform_account_id=p_platform;
  if p_action='release' then
    if g.operation_token=p_token and g.operation_kind='restart' then
      update public.billing_connect_guards set operation_token=null,operation_kind=null where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform;
    end if;
    return '{}'::jsonb;
  end if;
  if p_action in ('attach','restart_commit') then
    if g.operation_token is distinct from p_token or p_token is null or g.generation is distinct from p_generation
      or g.operation_kind is distinct from (case when p_action='attach' then 'connect' else 'restart' end) then
      raise exception 'Stale connection operation. Contact HQ.' using errcode='40001';
    end if;
  elsif g.operation_token is not null then
    raise exception 'A connection operation is unresolved. Contact HQ support.' using errcode='40001';
  end if;
  if p_generation is not null and p_generation<>g.generation then
    raise exception 'This connection link expired after restart.' using errcode='40001';
  end if;
  if p_action in ('start','claim','attach') and a.provider_id is not null then
    raise exception 'An existing connection cannot be replaced. Use safe restart or HQ support.' using errcode='40001';
  end if;
  if p_action in ('restart_claim','restart_commit') then
    if g.ever_used or coalesce(a.charges_enabled,false) or coalesce(a.payouts_enabled,false)
      or coalesce(a.details_submitted,false) or coalesce(jsonb_array_length(a.requirements->'pending_verification'),0)>0 then
      raise exception 'Enabled or financially used accounts cannot restart. Contact HQ.' using errcode='40001';
    end if;
    if exists(select 1 from public.billing_account_events where provider_id=p_provider_id and kind in ('charges_enabled','payouts_enabled')) then
      raise exception 'This account was previously enabled. Contact HQ support.' using errcode='40001';
    end if;
    -- Across ALL identities: quarantined legacy financial records count too.
    foreach t in array array['billing_orders','billing_subscriptions','billing_ledger','billing_payouts',
      'billing_payers','billing_payment_links','billing_carts','billing_prebuilt_carts'] loop
      execute format('select exists(select 1 from public.%I where provider_id=$1)',t) into used using p_provider_id;
      if used then raise exception 'Financial records exist. Contact HQ; replacement is blocked.' using errcode='40001'; end if;
    end loop;
  end if;
  if p_action in ('claim','restart_claim') then
    if p_token is null then raise exception 'Operation token required'; end if;
    update public.billing_connect_guards set operation_token=p_token,
      operation_kind=case when p_action='claim' then 'connect' else 'restart' end
      where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform;
  elsif p_action='attach' then
    perform set_config('thinnr.connect_mutation','allowed',true);
    insert into public.billing_connected_accounts
      select (jsonb_populate_record(null::public.billing_connected_accounts,
        jsonb_build_object('created_at',now(),'updated_at',now()) || p_account ||
        jsonb_build_object('provider_id',p_provider_id,'stripe_mode',p_mode,'stripe_platform_account_id',p_platform))).*;
    update public.billing_connect_guards set operation_token=null,operation_kind=null
      where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform;
  elsif p_action='restart_commit' then
    perform set_config('thinnr.connect_mutation','allowed',true);
    if a.provider_id is not null then
      insert into public.billing_connect_archive(provider_id,stripe_mode,platform_account_id,generation,account_snapshot)
        values(p_provider_id,p_mode,p_platform,g.generation,to_jsonb(a)-'oauth_refresh_token');
      delete from public.billing_connected_accounts where provider_id=p_provider_id and stripe_mode=p_mode and stripe_platform_account_id=p_platform;
    end if;
    update public.billing_connect_guards set generation=generation+1,operation_token=null,operation_kind=null
      where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform;
    delete from public.practice_launch_completions where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform;
    delete from public.practice_launch_product_receipts where provider_id=p_provider_id and stripe_mode=p_mode and platform_account_id=p_platform;
    update public.practice_launch set completed_at=null,version=version+1 where provider_id=p_provider_id;
  elsif p_action<>'start' then raise exception 'Unsupported connection operation'; end if;
  return jsonb_build_object('generation',g.generation,'token',p_token,'modeVersion',mode_version);
end $$;
revoke all on function public.guard_office_connect(text,text,text,text,text,integer,uuid,jsonb,integer) from public,anon,authenticated;
grant execute on function public.guard_office_connect(text,text,text,text,text,integer,uuid,jsonb,integer) to service_role;

create function public.protect_connect_identity() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.billing_connect_guards%rowtype;
begin
  if current_setting('thinnr.connect_mutation',true)='allowed' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then raise exception 'Connection deletion requires safe restart.' using errcode='40001'; end if;
  if tg_op='INSERT' then raise exception 'Connection creation requires a claimed operation.' using errcode='40001'; end if;
  if (new.stripe_account_id,new.provider_id,new.stripe_mode,new.stripe_platform_account_id)
    is distinct from (old.stripe_account_id,old.provider_id,old.stripe_mode,old.stripe_platform_account_id) then
    raise exception 'Connection identity is immutable. Contact HQ.' using errcode='40001';
  end if;
  select * into g from public.billing_connect_guards where provider_id=new.provider_id
    and stripe_mode=new.stripe_mode and platform_account_id=new.stripe_platform_account_id for update;
  if g.operation_token is not null then raise exception 'Connection operation in progress.' using errcode='40001'; end if;
  if new.stripe_mode is not null and (new.charges_enabled or new.payouts_enabled) then
    insert into public.billing_connect_guards(provider_id,stripe_mode,platform_account_id,ever_used)
      values(new.provider_id,new.stripe_mode,new.stripe_platform_account_id,true)
      on conflict(provider_id,stripe_mode,platform_account_id) do update set ever_used=true;
  end if;
  return new;
end $$;
create trigger protect_connect_identity before insert or update or delete on public.billing_connected_accounts
  for each row execute function public.protect_connect_identity();

create function public.protect_connect_financial_write() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare busy boolean;
begin
  -- Lock the same guard row as restart. An operation either wins before restart,
  -- permanently marking this connection used, or fails while restart owns it.
  if new.stripe_mode is null then return new; end if;
  insert into public.billing_connect_guards(provider_id,stripe_mode,platform_account_id)
    values(new.provider_id,new.stripe_mode,new.stripe_platform_account_id) on conflict do nothing;
  select operation_token is not null into busy from public.billing_connect_guards where provider_id=new.provider_id
    and stripe_mode=new.stripe_mode and platform_account_id=new.stripe_platform_account_id for update;
  if busy then raise exception 'Stripe connection operation in progress.' using errcode='40001'; end if;
  update public.billing_connect_guards set ever_used=true where provider_id=new.provider_id
    and stripe_mode=new.stripe_mode and platform_account_id=new.stripe_platform_account_id;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['billing_orders','billing_subscriptions','billing_ledger','billing_payouts','billing_payers',
    'billing_payment_links','billing_carts','billing_prebuilt_carts'] loop
    execute format('create trigger protect_connect_financial_write before insert or update on public.%I for each row execute function public.protect_connect_financial_write()',t);
  end loop;
end $$;
revoke all on function public.protect_connect_identity(),public.protect_connect_financial_write() from public,anon,authenticated;
grant execute on function public.protect_connect_identity(),public.protect_connect_financial_write() to service_role;
notify pgrst,'reload schema';