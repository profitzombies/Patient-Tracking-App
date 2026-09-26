-- App payments reports: three HQ-only export kinds covering what offices pay
-- THINNR for the app (office access subscriptions), kept apart from patient
-- shop and office sales.
--
--   app_payments_offices       billable offices snapshot (unranged)
--   app_payments_forecast      scheduled charges + forecast for a window
--   app_payments_transactions  every access charge attempt / payment in a range
--
-- They are network-wide and requested by HQ only; the scope check makes an
-- office-requested or office-pinned row impossible even if the API regressed.

alter table public.data_exports drop constraint if exists data_exports_kind_check;
alter table public.data_exports
  add constraint data_exports_kind_check check (kind in (
    'office_comparison', 'patient_activity', 'audit_events', 'training_completion', 'provider_directory',
    'billing_transactions', 'billing_subscriptions', 'billing_payouts', 'patient_record', 'office_bundle',
    'app_payments_offices', 'app_payments_forecast', 'app_payments_transactions'
  ));

alter table public.data_exports drop constraint if exists data_exports_app_payments_scope_check;
alter table public.data_exports
  add constraint data_exports_app_payments_scope_check check (
    kind not in ('app_payments_offices', 'app_payments_forecast', 'app_payments_transactions')
    or (requester_kind = 'hq' and provider_id is null)
  );
