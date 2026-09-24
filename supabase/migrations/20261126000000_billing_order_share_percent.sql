-- THINNR's share of floor is no longer a constant: an office restricted for
-- nonpayment pays an elevated share on the charges it takes from that point
-- forward. Each order records the percentage that was applied to it, next to
-- the share amount its items already snapshot, so a later restriction (or a
-- recovery) can never be read back onto a charge that has been processed.
--
-- Null = taken before the share was recorded; those orders were all charged at
-- the normal share.
alter table public.billing_orders
  add column if not exists thinnr_share_percent smallint;

comment on column public.billing_orders.thinnr_share_percent is
  'THINNR share of floor price applied to this order, in percent (null = legacy order at the normal share).';

alter table public.billing_orders
  drop constraint if exists billing_orders_thinnr_share_percent_range;
alter table public.billing_orders
  add constraint billing_orders_thinnr_share_percent_range
  check (thinnr_share_percent is null or (thinnr_share_percent between 0 and 100));
