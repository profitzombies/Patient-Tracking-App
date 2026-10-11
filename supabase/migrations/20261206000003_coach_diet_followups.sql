-- Coach follows the patient's diet and food lists.
--
-- 1. The AI coach may add a dislike, sensitivity or allergy on the patient's
--    confirmation inside chat ("Want me to add broccoli to your dislikes?").
--    Those rows carry entered_by_role = 'coach' so the lists UI and audit
--    trail show who entered them; the CHECK list gains the new role.
-- 2. The coach acknowledges a diet change once, on the next reply after the
--    change. The marker lives on the selection row itself (null until the
--    coach has spoken), so a change is acknowledged exactly once per
--    selection and never again after a restart.

alter table public.patient_preference_items
  drop constraint if exists patient_preference_items_entered_by_role_check;
alter table public.patient_preference_items
  add constraint patient_preference_items_entered_by_role_check
  check (entered_by_role in ('patient', 'staff', 'migration', 'coach'));

alter table public.patient_diet_selections
  add column if not exists coach_acknowledged_at timestamptz;
