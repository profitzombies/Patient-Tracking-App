-- Passwordless code login, both realms.
--
-- 1. The claim_verifications ledger gains two purposes: 'login' (staff email
--    codes and patient phone/email codes) and 'signup' (new-patient phone
--    verification). The existing claim_register_send RPC passes purpose
--    through untouched, so widening this CHECK is the only schema change the
--    code rails need.
-- 2. Patients get real uniqueness guarantees on their login identifiers:
--    email unique among patients (the email-code fallback must map to exactly
--    one account) and phone unique among patients on the last-10-digit
--    normalization the directory lookups already use. Both are partial
--    indexes so blank/null contact fields stay legal.

alter table public.claim_verifications
  drop constraint claim_verifications_purpose_check;

alter table public.claim_verifications
  add constraint claim_verifications_purpose_check
  check (purpose = any (array['claim'::text, 'add_phone'::text, 'login'::text, 'signup'::text]));

create unique index if not exists patients_email_unique_idx
  on public.patients (lower(email))
  where email is not null and email <> '';

create unique index if not exists patients_phone_unique_idx
  on public.patients (right(regexp_replace(phone, '\D', '', 'g'), 10))
  where phone is not null and regexp_replace(phone, '\D', '', 'g') <> '';
