# Brief 01 — Supabase migration for billing_* tables

Owner files:
- `supabase/migrations/20261011000000_billing_connect.sql` (create)
- `artifacts/api-server/src/billing/billing.sql.test.ts` (create)
- `docs/billing-connect/DECISIONS.md` (append only, under "## 01-migration")

## Deliverables
1. Write the migration exactly per SPEC §4 (all 17 `billing_*` tables, seeds,
   indexes, RLS enabled with no policies, `updated_at` triggers). Requirements:
   - Idempotent: `create table if not exists`, `create index if not exists`,
     seeds with `on conflict (slug) do nothing`, settings singleton
     `insert … where not exists`. The file must be safe to re-apply.
   - `billing_settings` singleton: `id int primary key default 1 check (id = 1)`.
   - Money columns are `integer` (bigint only for ledger/payout amounts is fine
     but keep it simple: integer everywhere, `check (>= 0)` where a negative
     never makes sense — NOT on ledger `amount_cents`/`application_fee_cents`,
     which are signed).
   - `billing_orders.order_number` unique; `billing_payment_links.token` unique;
     `billing_webhook_events.stripe_event_id` primary key.
   - FKs: `provider_id text references providers(provider_id)`,
     `patient_id uuid references patients(id) on delete set null`,
     product/order/subscription/payer FKs as in §4. Check the live column
     types first (see below) — `providers.provider_id` is text; `patients.id`
     is uuid.
   - Check constraints for every enum-like text column listed in §4.
   - A single `billing_touch_updated_at()` trigger function reused by every
     table that has `updated_at`. Check whether a generic `set_updated_at`
     already exists in earlier migrations; reuse it if so.
   - Grant nothing to anon/authenticated (service role bypasses RLS).
2. Apply it to the live Supabase project through the management API
   (`POST https://api.supabase.com/v1/projects/{ref}/database/query`, bearer
   `SUPABASE_ACCESS_TOKEN`, ref = first host label of `SUPABASE_URL`). Use the
   CodeExecution sandbox with `requestSecrets`/`requestEnvVars` per the
   environment-secrets skill; never print the token. Send the file verbatim as
   one query body. Then confirm via a follow-up query that all 17 tables exist
   and `billing_products` has 10 rows, and re-check
   `GET /v1/projects/{ref}/advisors/security` for NEW findings (RLS-enabled
   tables with no policies are expected and fine; fix anything else new).
   Before applying, inspect the live `providers` and `patients` column types
   with `information_schema.columns` so the FKs match.
3. Local-Postgres vitest `billing.sql.test.ts` following
   `artifacts/api-server/src/jobs/schema.sql.test.ts` (boot temp `initdb`/`pg_ctl`
   on a unix socket, always pass `-h <sockdir> -d postgres`, `describe.skipIf`
   when binaries are missing). Create minimal `providers(provider_id text pk)`
   and `patients(id uuid pk, provider_id text)` stubs, apply the REAL migration
   file read from `supabase/migrations`, and assert:
   - re-applying the file is a no-op (idempotent),
   - 10 seeded products, settings singleton with defaults 1000/1000/290/30,
   - `insert … on conflict do nothing` on `billing_webhook_events` returns 0 rows
     the second time (idempotency key),
   - `updated_at` advances on update of `billing_office_prices`,
   - a second settings row (id=2) is rejected,
   - an order with an invalid status is rejected,
   - RLS is enabled on all billing tables (`pg_class.relrowsecurity`).
   Run it: `pnpm --filter @workspace/api-server exec vitest run src/billing/billing.sql.test.ts`.

Do not add the `test:` script or validation command; report the command instead.
