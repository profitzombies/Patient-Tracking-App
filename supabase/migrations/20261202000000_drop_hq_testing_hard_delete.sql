-- Retire the HQ testing hard-delete override.
--
-- public.hq_testing_hard_delete (20261129000000_hq_testing_hard_delete.sql) was
-- a temporary, deliberately non-compliant wipe for made-up test offices and
-- patients. The test records it existed for were removed from production on
-- 2026-10-07 and the app no longer calls it, so production keeps only its
-- normal deletion and retention paths (patient purge, office offboarding,
-- legal holds, retention jobs).
--
-- Apply to development first, then production, through the management API.

drop function if exists public.hq_testing_hard_delete(text, uuid);
