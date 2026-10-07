---
name: Production/development Supabase split
description: Lessons from separating the published app's Supabase project from development — stale live suites, fixture cleanup, Stripe broadcast, schema drift.
---

The project/ref facts, configuration and migration rules live in replit.md → "Production vs development". These are the non-obvious lessons around them.

- **Many live-proof scripts were already stale before the split.** Failures caused by gates added after a script's last commit are not split regressions: the practice-setup gate (2026-09-20, waiver `practice_launch.setup_override_at`), auth-required AI Support chat (2026-09-15), the HQ-gated training media routes (2026-08-30), and the billing identity trigger that requires `stripe_mode` + `stripe_platform_account_id` on every billing row (2026-09-20).
  **Why:** debugging these as environment problems wastes hours.
  **How to apply:** before suspecting dev config, compare `git log -1` of the script with the commit that introduced the failing message.
- **A killed live run skips its `finally` cleanup**, which leaves fixture offices and users in development. Remove them with FK-enforced deletes: only the append-only ledgers go under `session_replication_role = replica`. Background jobs write extra dependents, such as `patient_app_event_rollups` for fixture offices, so expect a rollback on the first attempt. Scripts that have a `cleanup` mode (overview-finance smoke) should clean up through that mode.
- **Stripe test-mode events go to every test destination.** Production's `billing_webhook_events` grows while development runs Stripe tests; for example, `account.updated` arrives when a fixture connected account is created. Those rows are expected and are not a leak.
- **The development schema mirrors production's drift.** A dump inherits migrations that were never applied to production; the patient rewards tables were one. Diff the tables named in migration files against `information_schema` (regex hits on `private.` / `legacy_archive.` are schema names, not missing tables).
