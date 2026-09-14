create unique index if not exists billing_orders_stripe_invoice_unique
  on public.billing_orders (stripe_invoice_id)
  where stripe_invoice_id is not null;

create unique index if not exists billing_ledger_kind_stripe_ref_unique
  on public.billing_ledger (kind, stripe_ref)
  where stripe_ref is not null;