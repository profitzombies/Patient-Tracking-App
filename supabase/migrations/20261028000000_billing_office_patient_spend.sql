-- Lifetime spend per patient at ONE office, in one grouped query, for the
-- office roster (spend filters and "Top spenders").
--
-- Mirrors the per-patient purchases summary exactly: an order counts as paid
-- while its status is paid / partially_refunded / refunded (the refund is
-- subtracted, never the order removed); refunds count only once succeeded;
-- the last paid moment is paid_at falling back to created_at. Patients with
-- no paid order at this office get no row at all — the caller reads that as
-- zero once the RPC succeeded, and only an RPC failure means "unknown".
--
-- Scoped by provider_id on both tables' owning order, so an order a patient
-- placed at a previous practice never surfaces on the new office's roster.

create or replace function public.billing_office_patient_spend(
  p_provider_id text
) returns table (
  patient_id uuid,
  paid_cents bigint,
  refunded_cents bigint,
  last_paid_at timestamptz
) language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required';
  end if;
  return query
  with paid as (
    select o.id, o.patient_id, o.total_cents, coalesce(o.paid_at, o.created_at) as paid_moment
    from billing_orders o
    where o.provider_id = p_provider_id
      and o.patient_id is not null
      and o.status in ('paid', 'partially_refunded', 'refunded')
  ),
  refunds as (
    select p.patient_id, sum(r.amount_cents)::bigint as refunded_cents
    from billing_refunds r
    join paid p on p.id = r.order_id
    where r.status = 'succeeded'
    group by p.patient_id
  )
  select
    p.patient_id,
    sum(p.total_cents)::bigint as paid_cents,
    coalesce(max(rf.refunded_cents), 0)::bigint as refunded_cents,
    max(p.paid_moment) as last_paid_at
  from paid p
  left join refunds rf on rf.patient_id = p.patient_id
  group by p.patient_id;
end;
$$;

revoke all on function public.billing_office_patient_spend(text) from public, anon, authenticated;
grant execute on function public.billing_office_patient_spend(text) to service_role;

create index if not exists billing_orders_provider_patient_status_idx
  on public.billing_orders (provider_id, patient_id, status);
