---
name: Office offboarding flow
description: How the HQ office offboarding stepper (disable, bundle, hand-over, seal, offboarded) is wired and the traps met building it.
---

# Office offboarding

**Rules**
- `providers.offboarding_status` (active/offboarding/offboarded) is the coarse state. Step 1 flips it to `offboarding` and revokes staff sessions WITHOUT setting `access_disabled`; only step 5 sets `access_disabled = true`. JS selectors filter on `officeIsActive` (both columns); SQL rollups still only know `access_disabled`, so an office in progress stays in SQL rollups until offboarded.
- Every selector that lists offices must either add the status column to its providers select or call `loadInactiveOfficeIds()` once per run. New selectors keyed on other tables (rollup RPCs) need the id-set exclusion or offboarding offices reappear in HQ comparisons.
- Patient gate rides the existing identity lookup via a PostgREST embed (`providers!fk_patients_provider(offboarding_status)`); fakes without the embed read as active. Both the bearer path and whoami return 403 code `program_ended`; the mobile app routes to a neutral screen and does NOT sign the device out server-side.
- Seal = the account-closure primitive per chart, enqueued by an SQL batch RPC. `destroy` hand-over pins `patients.record_retain_until` (30 days) before closure; `retain` leaves it null so the clinical policy applies.
- Reactivation (contract renewed) is all-or-nothing and only for status `offboarded`: an SQL RPC under the provider row lock reopens exactly the charts this offboarding sealed (`closed_at >= seal start`), refusing with counts if ANY of them is already a tombstone, past retain-until, or mid-purge; earlier patient-initiated closures are untouched. Reopened requests stay `cancelled` with `closed_at` kept so the patient identity gate can answer `reenroll_required` (404) instead of `account_closed`; patient logins are NOT restored (GoTrue users were deleted at closure). The provider flip (active, access_disabled false) happens AFTER charts reopen so a crash mid-way repeats safely; the offboarding record stays as history (`reactivated_*`) and the next start resets it.

**Why:** the BAA "return or destroy" clause; the office must lose access first, be handed the bundle, and only then have charts sealed; legal holds must block sealing and completion at the SQL predicate level, not only in the route.

**Traps**
- The batch enqueue RPC must exclude patients whose open request is already due, otherwise a repeat call re-counts them and the job's "fewer than a batch = done" loop spins to its round cap. Real-PG test caught it; the route fake did not.
- Real-PG suites that apply a migration referencing account-closure columns need those columns (and the widened status CHECK) in the stub schema first.
- The Supabase security advisor flags `rls_enabled_no_policy` INFO for service-role-only ledgers; that is the intended posture.
- A new Expo route fails mobile typecheck until the Expo workflow is restarted (typed routes regenerate).
- Real-PG fixtures: the patient identity write guard rejects inserting deletion requests for already-archived patients — insert the request rows first, then archive.
- Web RTR suites that open a confirmation Dialog need the DOM-free dialog stub mapped in the suite tsconfig; the real Radix portal wants a document.

**How to apply:** touching rosters, digests, renewals, warehouse submission, leaderboards, HQ counts or any staff/patient sign-in path → check `lib/office-status.ts` is consulted; extending the stepper → keep each step idempotent (200 on repeat) and audited.
