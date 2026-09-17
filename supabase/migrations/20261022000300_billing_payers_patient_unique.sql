-- One billing payer per patient per office. Patient-backed payers were resolved
-- by read-then-insert with no constraint behind it, so two concurrent checkouts
-- (different cart keys) could create two payer rows and two Stripe customers for
-- the same patient, splitting cards, orders, and subscriptions across them. The
-- partial unique index makes the second insert a conflict the application
-- re-reads instead of a duplicate. Guest payers (patient_id null) are untouched.
create unique index if not exists billing_payers_provider_patient_key
  on public.billing_payers (provider_id, patient_id)
  where patient_id is not null;
