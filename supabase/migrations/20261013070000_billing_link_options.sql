alter table public.billing_payment_links
  add column if not exists product_id uuid null references public.billing_products(id),
  add column if not exists max_uses integer null;

alter table public.billing_payment_links
  drop constraint if exists billing_payment_links_max_uses_check;
alter table public.billing_payment_links
  add constraint billing_payment_links_max_uses_check check (max_uses is null or max_uses >= 1);

create or replace function public.billing_claim_payment_link_use(p_link_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  update public.billing_payment_links
  set uses = uses + 1, last_used_at = now(), updated_at = now()
  where id = p_link_id
    and active is true
    and (expires_at is null or expires_at > now())
    and (max_uses is null or uses < max_uses)
  returning id into claimed_id;
  return claimed_id is not null;
end;
$$;

create or replace function public.billing_release_payment_link_use(p_link_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  released_id uuid;
begin
  update public.billing_payment_links
  set uses = uses - 1, updated_at = now()
  where id = p_link_id and uses > 0
  returning id into released_id;
  return released_id is not null;
end;
$$;

revoke all on function public.billing_claim_payment_link_use(uuid) from public, anon, authenticated;
revoke all on function public.billing_release_payment_link_use(uuid) from public, anon, authenticated;
grant execute on function public.billing_claim_payment_link_use(uuid) to service_role;
grant execute on function public.billing_release_payment_link_use(uuid) to service_role;