alter table public.data_exports drop constraint if exists data_exports_kind_check;
alter table public.data_exports
  add constraint data_exports_kind_check check (kind in (
    'office_comparison', 'patient_activity', 'audit_events', 'training_completion', 'provider_directory',
    'billing_transactions', 'billing_subscriptions', 'billing_payouts'
  ));
