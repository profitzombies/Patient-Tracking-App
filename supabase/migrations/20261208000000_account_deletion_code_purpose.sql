-- Public delete-account page (app.trythinnr.com/delete-account): the one-time
-- code it sends rides the shared claim_verifications ledger under its own
-- purpose, so a sign-in or recovery code can never file a deletion and a
-- deletion code can never sign anyone in.
alter table public.claim_verifications
  drop constraint if exists claim_verifications_purpose_check;
alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array[
    'claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text, 'recovery'::text,
    'profile_email'::text, 'profile_phone'::text, 'password_change'::text, 'cart_pay'::text,
    'staff_sms'::text, 'account_deletion'::text
  ]));
