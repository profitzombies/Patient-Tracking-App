# Live organization policy browser regression

This is an **explicit, serial live check**, not a demo or mocked-browser test.
It covers `/admin/settings` (`LivePolicySettings`) and `/settings`
(`OfficeSettings`) against the running API and the configured Supabase project.
Use the testing subagent, with separate HQ and office browser contexts.

## Safety and setup

- Reserve a short maintenance window in the development workspace. The HQ
  escalation-email default is a shared singleton, so the test temporarily
  changes it for **every office without an override**. Do not run against a
  production project, concurrently with policy editing, or alongside other
  validation suites. Do not send messages or notifications during the check.
- Keep coach availability, notification defaults, retention, and all other HQ
  fields unchanged. Only the escalation-email field is needed for the full loop.
- Existing workspace Supabase secrets are used server-side. Never copy tokens,
  passwords, OTPs, or the private recovery manifest into reports or chat.
- Start the managed operations web and API workflows.
- From the workspace root run:

  ```sh
  node scripts/org-policy-browser-fixture.mjs prepare --allow-live-fixtures
  ```

  This creates a disposable **active HQ Admin**, a disposable office, and an
  office teammate with the **admin** role (not an HQ drill-in). The office
  manager's auth identity is created by normal code login. It outputs synthetic
  login emails and unique test values, but no credentials. Existing users are
  never used. A private, gitignored `.cache/org-policy-browser/state.json`
  records recovery data before the first write. Never delete it manually.
- Have the tester temporarily restart **only the development API** with
  `CLAIM_EMAIL_DELIVERY_MODE=dev`; use the code displayed in the real sign-in
  screen. Restore the workflow without overrides in a `finally` step. This
  avoids email delivery and any served session-injection helper.

## Browser plan

Use a desktop viewport (1440×1000 works). Record relevant response status,
version, and field values, **not authorization headers or auth response bodies**.
Do not mock/intercept any policy response. Any unexpected console error, 401,
403, or 5xx from an app request is a failure to investigate.

Attach response listeners **before navigation**, and observe the app's actual
GET/PUT requests. Plain Playwright `context.request.get()` only shares cookies;
this app authenticates through a bearer-token getter in `customFetch`, so that
probe is unauthenticated and gives a misleading 401. Do not infer authentication
from the fixed “Synthetic demo data” shell footer (currently shown even during
real sign-in). Prove live mode from the real identity, API responses, provider
ID, and persisted writes.

1. **Real sign-in:** In separate contexts, sign in at `/` with the emitted HQ
   and office emails and the inline development codes. Do not choose the guided
   demo. Navigate HQ to `/admin/settings`, office to `/settings`.
   - `GET /api/hq/settings` must return 200, and the HQ policy form must load.
   - `GET /api/office/settings` must return 200 with the emitted provider ID,
     `canEdit: true`, and override version 0. The office form must be editable.
2. **HQ save:** Fill `input-policy-escalation-email` with `hqValues[0]`, then
   click `button-save-policy-coach`.
   - Real `PUT /api/hq/settings`: 200, version = preceding GET version + 1,
     escalationEmail = the first value. Payload includes `expectedVersion` and
     only the coach section, not unrelated policy fields.
   - See **“Coach & care team saved”**, the refreshed input, and
     `policy-stamp-coach` naming Policy Browser HQ.
   - Reload office. Its GET reports the new HQ version and effective email,
     with `effective.source.escalationEmail = "hq"`. The visible
     `effective-escalation-email` equals that email and shows **HQ default**.
3. **HQ conflict (two real tabs):** Open another HQ settings tab in the same
   HQ context. Wait until both hold the same version. In the stale tab, type
   `staleValue` without saving. In the first tab, save `hqValues[1]`.
   - Winner PUT: 200 and another version increment.
   - Save the stale tab **without reloading it**. Its PUT sends the old version,
     receives a real 409, and visibly announces **“Someone else saved first”**.
   - Its follow-up GET is 200; the input reloads the winner value, not the stale
     value, and Save becomes disabled. A further reload keeps the winner.
   - If browser focus triggers a refetch before saving, keep both pages active
     or initiate the winner save in the other page without switching focus.
     Do not fabricate a 409 or rewrite the request's version.
4. **Office override wins and persists:** Reload the office page, which should
   now inherit `hqValues[1]`. Fill `input-override-escalation-email` with
   `officeValues[0]`, click `button-save-office-overrides`.
   - PUT `/api/office/settings/overrides`: 200, override version 1,
     `effective.source.escalationEmail = "office"`, HQ email still the winner.
   - See **“Office overrides saved”**. Reload, then verify the input and
     `effective-escalation-email` still show the override and **Office override**.
     A draft preview alone is not persistence evidence.
5. **Office conflict:** Open a second office settings tab and wait for the same
   override version. Draft `staleValue` there. Save `officeValues[1]` in the
   first office tab.
   - Winner PUT: 200, override version 2. Stale tab's save: 409 and
     **“Someone else saved first”**.
   - The stale tab re-fetches the winner, Save disables, and reload preserves
     the office winner. HQ remains unchanged.
6. **Database evidence:** Run:

   ```sh
   node scripts/org-policy-browser-fixture.mjs inspect --allow-live-fixtures
   ```

   It asserts real identities/roles, HQ and override version increments,
   both winning values, and audit evidence. Retain screenshot evidence of the
   inherited value, persisted override, and each conflict toast.

## Mandatory teardown (also after failure)

1. Close **all** test browser contexts before removing fixtures.
2. Run:

   ```sh
   node scripts/org-policy-browser-fixture.mjs cleanup --allow-live-fixtures
   ```

   Cleanup locks the HQ row and restores only the test-owned email and its
   section stamp. Versions stay monotonic; unrelated changes are preserved.
   An unexpected destination causes an explicit failure instead of overwriting
   someone else's edit. The private manifest is retained on failure so cleanup
   can be retried. Auth deletion uses GoTrue's normal cascades for sessions,
   identities, and security records.
3. Confirm cleanup reports zero disposable users, profiles, HQ memberships,
   office members, providers, overrides, challenges, and audit rows, plus
   `hq_value_restored: true`. The recovery manifest is removed only after those
   checks pass.
4. Restart the API workflow **without temporary environment overrides**, to
   clear the policy cache and restore normal email delivery. Check startup logs.

## Validation decision

Do **not** register this live check as an automatic validation command: it
mutates a shared singleton, needs a real browser and privileged Supabase access,
and temporarily changes development email delivery. Parallel completion
validation would not be hermetic or safe. Keep the existing `org-policies-web`
and `org-policies-api` commands as the hermetic guards; use this documented
fixture + browser plan explicitly when live regression evidence is needed.

## Verified run — 2026-09-09

Real code sign-in, API, and Supabase were used; no application code changes or
mocked policy responses were needed.

| Check | Observed result |
| --- | --- |
| HQ reads and saves | GET 200 at version 1; coach-only saves 200, versions 2 and 3 |
| Office inheritance | GET 200; updated HQ email visible, source `hq`, override version 0 |
| HQ stale save | Old version 2 sent; 409; exact conflict toast; winner reloaded at version 3 |
| Office override | Save 200 at override version 1; source `office`; persisted after reload |
| Office stale save | Winner advanced to version 2; stale version 1 returned 409; exact toast; winner survived reload |
| Supabase cross-check | One real HQ Admin and one signed-in office admin; both winners persisted; two HQ and two office audit events |
| Cleanup | Original HQ email restored; zero fixture auth users, profiles, memberships, office members, providers, overrides, login challenges, and audits |

Screenshots in the browser test report show inheritance, persisted override,
and both conflict toasts. The API was restarted without temporary overrides
after cleanup, and the private recovery manifest was removed. The existing
organization-policy component suite and all 21 focused policy API tests passed.

The first attempt stopped on cookie-only manual probes that lacked the app's
bearer header; the corrected continuation observed the app requests before
navigation and completed all saves. The tester also noted unrelated 401
resource errors on surrounding dashboard loads; no policy request failed
unexpectedly. This report verifies the policy flow, not every dashboard request.