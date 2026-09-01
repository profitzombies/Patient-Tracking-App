-- THINNR patient invitations: provider-scoped pending patients created from
-- the office portals (desktop roster + native provider dashboard).
--
-- A pending invitation IS a normal patients row — activation_status is
-- 'invited', provider_id is the inviting office, and auth_user_id stays null
-- until the patient claims the row by verifying the invited phone number on
-- the existing passwordless rail (which sets auth_user_id + claimed_at and
-- flips activation_status to 'activated'). No parallel invitation table
-- means duplicates are impossible by construction: the existing partial
-- unique indexes on lower(email) and the last-10-digit phone key apply to
-- invited rows exactly like self-signup rows.
--
-- invite_email_status is the durable retry state for the branded email:
--   pending -> row landed, email not yet confirmed sent
--   sent    -> handed to the email provider after the row committed
--   failed  -> delivery failed; the portals surface a Resend action
-- invite_email_updated_at anchors the resend rate limit: resends are a
-- conditional UPDATE guarded on this timestamp, so parallel clicks can
-- neither double-send nor create duplicate patients.

alter table public.patients
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid,
  add column if not exists invite_email_status text
    check (invite_email_status in ('pending', 'sent', 'failed')),
  add column if not exists invite_email_updated_at timestamptz;

-- The legacy activation_status check predates invitations; widen it so
-- 'invited' is a legal state alongside the existing values.
alter table public.patients
  drop constraint if exists patients_activation_status_check;
alter table public.patients
  add constraint patients_activation_status_check
    check (activation_status in ('unactivated', 'activated', 'disabled', 'invited'));

comment on column public.patients.invited_at is
  'When the office invited this patient (null for self-signup patients).';
comment on column public.patients.invited_by is
  'Auth user id of the staff member who created the invitation.';
comment on column public.patients.invite_email_status is
  'Branded invitation email delivery state: pending, sent, or failed.';
comment on column public.patients.invite_email_updated_at is
  'Last invitation email attempt; anchors the atomic resend rate limit.';
