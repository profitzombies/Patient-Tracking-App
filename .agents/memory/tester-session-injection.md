---
name: Signing the testing subagent in as real staff
description: Principle for getting the browser tester past code-login screens without pasting credentials through chat.
---

**Rule:** never hand the tester a long-lived token or JWT through chat text; never leave any sign-in helper in the served app tree.

**Why:** a pasted JWT arrived with one mangled character and every API call 401'd — indistinguishable from an app bug until the token was diffed. Email code login also needs an env-override restart and burns the small per-hour send cap.

**How to apply:** mint sessions for THROWAWAY identities server-side, deliver them through a temporary, gitignored/deleted-after helper that seeds the app's own storage keys (the app requires both the auth-library session AND its device-memory login stamp; a session without the stamp is signed out on load), and tear down the helper plus the identities before completing. Real user accounts are never used for tester sessions.

**Provisioning caveat:** direct Auth-admin session fixtures bypass first-login workspace provisioning. An API-authorized office owner is not necessarily an admitted Operations user. **Why:** a synthetic owner passed the office API ladder while the UI correctly showed an incomplete claimed-workspace screen because its provisioned profile was absent. **How to apply:** verify both the account-resolution response and the authenticated workspace profile before handing a helper to the tester; do not weaken application admission to accommodate a fixture.

**Cheapest live-office fixture for staff e2e (no helper page needed):** insert a throwaway `providers` row (fake `.example.com` email, 6-digit `onboarding_code`) plus an `activated` patient row via the management API; the first passwordless code login auto-creates and links the auth user and provisions the workspace. Have the tester itself restart the API workflow with `CLAIM_EMAIL_DELIVERY_MODE=dev` (code shows inline), then restart without overrides. Tear down in ONE mgmt-API transaction under `set local session_replication_role = replica` (append-only audit rows set-null into the office FK otherwise): measurements/notes/weights → audit events (by provider AND actor) → `claim_verifications` (by `identifier`) → patients → `training_viewers` → `profiles` → providers → `auth.identities`/`auth.sessions`/`auth.users`. Never point the tester at the owner's real live office.

**Rule:** capture the app's own authenticated requests, with listeners attached before navigation; do not use a plain Playwright context request as proof of API authorization.

**Why:** a browser context shares cookies with Playwright's request client, but not the app's bearer-token getter. A tester reported successful live forms as broken because its separate cookie-only probes returned 401.

**How to apply:** assert policy/session response status from app-generated requests and never log headers or auth bodies. Loaded forms plus an empty late-attached response listener do not prove a failed API call.

**Mobile session envelope:** a temporary Supabase storage seed must contain the complete session shape, including `expires_at` and `user`, not just access/refresh tokens.

**Why:** GoTrue silently discarded an incomplete synthetic session, so the Expo app redirected to its public welcome screen even though the helper ran successfully.

**How to apply:** mirror the real SDK session envelope without exposing it in tool output. On the direct Expo domain, helper paths and redirects are root-relative, not prefixed by the artifact preview path.

**Prefer a self-cleaning fixture harness over ad-hoc identities.** When a feature already has a live smoke harness that mints throwaway identities and session-seeding helper pages, reuse it for browser verification instead of hand-creating accounts: it tears rows, auth users, helper files and git excludes down in one command, so nothing leaks past the session. **Why:** hand-seeded testers left symlinks, exclude lines and fixture rows behind more than once.

## Care-team smoke harness helper is not auto-served
The api-server care-team live-smoke harness writes helper HTML under `tmp/` but only *removes* the `artifacts/*/public/<helper-dir>` symlinks at cleanup — it never creates them. After `prepare`/`helper`, symlink the helper dir into the web artifact's `public/` yourself (and add the path to `.git/info/exclude`), or the helper URL SPA-falls-back to index.html and the tester lands on the sign-in card with an empty localStorage. Cleanup removes both.

## Care-team smoke harness drift (Sept 2026)
`verify --keep` now fails at conversation creation (`patient_chat_conversations_coach_identity_check`) — the harness predates that constraint. `prepare` + `helper` still work; have the tester create threads/replies/notes through the real UI instead. `cleanup` can fail its "audit rows removed" assertion when the tester's browser is still polling as a fixture user (a late `access_denied` audit row lands after the delete); audit rows are append-only outside the harness's replica-role transaction, so just re-run `cleanup` after the tester is idle.

**Harness rows only cover the harness's own feature.** When a browser check needs data from another domain (e.g. billing rows for a staff panel), seed that domain fully enough that its OWN gates pass — a synthetic office with orders but no connected payment account made every payments-area link look broken — and delete those rows yourself before `cleanup`; the harness never knows about them.
