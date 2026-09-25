-- Practice setup may finish once the office has submitted Stripe's form: the
-- connected account is details-submitted, not disconnected and not rejected.
-- Stripe reviewing it, or asking for more details after submission
-- (currently_due / past_due, requirements.* disabled reasons, under_review),
-- no longer holds the office out of its workspace; the office Overview asks
-- for those items instead. Patient charges stay off on their own until Stripe
-- enables them (checkout checks charges_enabled).
--
-- The fresh-Stripe-read and re-gate checks are unchanged. Same signature as
-- before, so `create or replace` keeps security definer and the existing
-- grants. Everything else in the function is unchanged.
create or replace function public.complete_practice_launch(p_provider_id text,p_expected_version integer,p_stripe_mode text,p_platform_account_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare l public.practice_launch%rowtype; a public.billing_connected_accounts%rowtype;
begin
  select * into l from public.practice_launch where provider_id=p_provider_id for update;
  if not found then raise exception 'Setup unavailable.'; end if;
  select * into a from public.billing_connected_accounts where provider_id=p_provider_id
    and stripe_mode=p_stripe_mode and stripe_platform_account_id=p_platform_account_id for share;
  -- Only a rejected account blocks, whatever the stored charge/payout flags
  -- say. Items Stripe lists as due after submission, and reasons such as
  -- requirements.* or under_review, no longer hold setup back. Keep in step
  -- with stripeAccountRejected in the API's practice-launch state helper.
  if not found or not a.details_submitted
    or coalesce(a.requirements->>'disabled_reason','') like 'rejected.%'
    or coalesce(a.requirements->>'disabled_reason','') in ('listed','platform_paused')
    or a.disconnected_at is not null
    or a.last_synced_at is null or a.last_synced_at<clock_timestamp()-interval '2 minutes'
    or (l.regated_at is not null and a.last_synced_at<l.regated_at) then
    raise exception 'Fresh Stripe verification must confirm the connected account is submitted and not blocked.' using errcode='22023';
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
