-- guard_office_connect required a billing_mode_state row, but a deployment has
-- none until HQ switches modes for the first time; the application reads that
-- absence as the implicit Test / version 0 selection. Without this, no office
-- could connect Stripe on a fresh deployment (the 40001 raise is retried by
-- PostgREST until the client times out). Same body as 20261114 otherwise.
create or replace function public.guard_office_connect(p_provider_id text,p_mode text,p_platform text,p_deployment text,p_action text,
  p_generation integer default null,p_token uuid default null,p_account jsonb default null,p_version integer default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.billing_connect_guards%rowtype; a public.billing_connected_accounts%rowtype; t text; used boolean; mode_version integer;
begin
  select version into mode_version from public.billing_mode_state where deployment_id=p_deployment and mode=p_mode
    and platform_account_id=p_platform and (p_version is null or version=p_version) for share;
  if not found then
    -- No selection row yet: the application treats the deployment as Test /
    -- version 0 (the implicit default switch_billing_mode's first activation
    -- builds on). Accept exactly that default, serialized against a concurrent
    -- first activation by the same advisory lock switch_billing_mode takes.
    if p_mode='test' and coalesce(p_version,0)=0
       and not exists(select 1 from public.billing_mode_state where deployment_id=p_deployment) then
      perform pg_advisory_xact_lock(hashtextextended('billing-mode:' || p_deployment, 0));
      if exists(select 1 from public.billing_mode_state where deployment_id=p_deployment) then
        raise exception 'Payment mode changed. Reload.' using errcode='40001';
      end if;
      mode_version := 0;
    else
      raise exception 'Payment mode changed. Reload.' using errcode='40001';
    end if;
  end if;
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
