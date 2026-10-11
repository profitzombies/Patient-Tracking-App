-- Diets & restrictions report: one HQ-only, network-wide-or-one-office CSV
-- export kind (`diet_restrictions`) built from the hq_diet_restrictions_facts
-- RPC. Aggregate only — no patient identifiers leave with it.

alter table public.data_exports drop constraint if exists data_exports_kind_check;
alter table public.data_exports
  add constraint data_exports_kind_check check (kind in (
    'office_comparison', 'patient_activity', 'audit_events', 'training_completion', 'provider_directory',
    'billing_transactions', 'billing_subscriptions', 'billing_payouts', 'patient_record', 'office_bundle',
    'app_payments_offices', 'app_payments_forecast', 'app_payments_transactions', 'diet_restrictions'
  ));
