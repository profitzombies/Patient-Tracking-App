---
name: Overview finance live smoke harness
description: How the signed-in Overview finance tiles (MRR, Revenue Trend, failed-payments card) are proven live against a synthetic Stripe-connected office, and the traps it exposed.
---
**Rule:** unit tests that mock the Supabase REST layer must honor the `select=` projection; a mock that returns columns the query never asked for hides "counted on a column we did not fetch" bugs.
**Why:** the dashboard's failed-payments query selected `id` only while the counter filtered on `status`; the unit test's mock returned `status` anyway, so the live card count was always 0 until the browser pass caught it.
**How to apply:** when a reporting helper filters rows client-side, the test mock should project rows to the selected columns (see the `project()` helper in the reporting-mrr test), and the live harness cross-checks every figure against the plan.

**Harness recipe (api-server `scripts/overview-finance-live-smoke.ts`; `test:overview-finance-live` = cleanup → prepare → verify):**
- One throwaway office with a REAL Stripe TEST connected account (deleted at cleanup), 7 `billing_subscriptions` (3 active at differing qty/cadence, past_due, unpaid, canceled + incomplete controls) and 3 paid orders placed so the default 30-day and a 7-day range show different totals and deltas.
- Paid orders are inserted via the management API under `session_replication_role = replica`: the paid-order trigger would otherwise queue a WarehouseCraft submission for a synthetic office.
- BOTH identities go through the `provision_staff_login` RPC (the same rail a real staff code login runs). A `team_members` row alone leaves the staffer on the "Welcome back" claimed-workspace screen; cleanup must also remove `staff_role_assignments` and `training_viewers` the rail wrote.
- `verify` reads `OVERVIEW_SMOKE_API_BASE_URL` at run time (the base is also frozen in the fixture at prepare, so pass it to verify too). Locally the API is only reachable through the proxy (`http://localhost:80/api`); the api-server dev workflow runs a BUILT bundle, so server fixes need a workflow restart before a live re-run.
- Browser pass: owner helper → `/` (MRR text, revenue total/delta testids, dashboard request `from` = range start − dayCount), react-day-picker range click 13→19 then Apply, priority card link → `?status=needs_attention` rows by `subscription-row-<id>`; staff helper → "—" + "Owners and admins only", `revenue-forbidden`, no toast. Subscription rows show "Payment failed / Card declined N times", not the raw status names.

**Ambient trap:** an unrelated `api-spec` codegen clean (from a concurrent merge) can delete `lib/api-client-react/src/generated/*` mid-session; Vite then overlays "Failed to resolve import ./generated/api" on every route. `pnpm --filter @workspace/api-spec run codegen` restores byte-identical files.
