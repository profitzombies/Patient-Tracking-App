# Account claiming & login

Real THINNR members from the migrated rolls — patients, providers, and office
staff — claim their accounts themselves: they prove they own the email or
mobile number the clinic has on file, set a password, and are signed in. The
same flow doubles as password reset ("Forgot your password?" points at it).

## Where it lives

| Piece | Path |
| --- | --- |
| API routes | `artifacts/api-server/src/routes/claim.ts` (`/api/claim/identify\|verify\|birthday\|complete\|whoami\|add-phone`) |
| Delivery (SMS/email) | `artifacts/api-server/src/claim/delivery.ts` |
| Normalization + password rules | `artifacts/api-server/src/claim/normalize.ts` |
| Per-IP limits | `artifacts/api-server/src/claim/limits.ts` |
| Mobile screen | `artifacts/thinnr-mobile/app/claim-account.tsx` (links from `patient-login`) |
| Web page | `artifacts/thinnr-operations/src/pages/ClaimAccount.tsx` at `/claim` (links from sign-in) |
| Web claimed-account landing | `ClaimedWorkspaceScreen` in `src/pages/AuthScreens.tsx` (no demo profile row → API `whoami` fallback in `src/contexts/session.tsx`) |
| DB migration (already applied) | `supabase/migrations/20260902000000_account_claiming.sql` |

## Flow contract

1. **Identify** — email or phone. The response is byte-identical whether or
   not an account exists (decoy `requestId`; in dev mode a decoy `devCode`
   too). Nothing is ever revealed about who is on file.
2. **Verify** — 6-digit code, salted-hash stored, 10-minute expiry, 5
   attempts, 3 sends/hour absorbed silently. Staff emails shared by more than
   one provider/team row dead-end with a neutral "contact your clinic" 409.
3. **Birthday** — only when one phone matches several patients. ONE attempt;
   a miss dead-ends neutrally. No retry by design.
4. **Complete** — the password is typed twice; the API refuses a missing or
   mismatched `passwordConfirm` (both apps gate the button on the match, the
   server re-checks it). Password must have 8+ chars, an uppercase, a lowercase, and
   a symbol (NO digit requirement, per spec). Supabase also rejects leaked
   passwords (HIBP). Linking writes only `auth_user_id` + `claimed_at` on the
   matched row; a 0-row guard deletes the just-created auth user and 409s.
5. **Session** — the client signs in with the server-returned identifier.
   `whoami` resolves kind/name/office for routing. Claimed accounts get **no
   demo profile row** (deferred constraint triggers skip provisioning), so
   the web app falls back to `whoami` and shows the claimed landing page;
   patients are routed to the mobile companion.

Precedence when one identifier matches several roles: hq_admin > provider >
team_member > patient.

## Delivery modes

Delivery mode on the API server can be set globally with
`CLAIM_DELIVERY_MODE`, or independently with `CLAIM_SMS_DELIVERY_MODE` and
`CLAIM_EMAIL_DELIVERY_MODE` (a channel-specific value wins):

- `dev` (default): no SMS/email is sent; the code rides the API response and
  the apps show it inline ("Test mode…").
- `live`: Twilio Verify sends SMS codes, Resend sends email codes. These are
  the ONLY messages the system ever sends. Unconfigured live mode → 503.

Env vars for live mode: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_VERIFY_SERVICE_SID`, `RESEND_API_KEY`, `CLAIM_EMAIL_FROM`, plus
`TWILIO_ACCOUNT_DELETION_VERIFY_SERVICE_SID` — a SECOND Verify service used only
by the public delete-account page. Twilio keeps one pending code per phone
number per Verify service (and re-sends it), so a destructive proof must not
share the sign-in service: with its own service a sign-in or recovery text can
never confirm a deletion. Without it, phone identities on that page get 503.

Current rollout: `CLAIM_SMS_DELIVERY_MODE=live` and
`CLAIM_EMAIL_DELIVERY_MODE=live`. Phone claim/recovery uses real Twilio Verify
SMS, and email claim/recovery uses Resend from the configured sender.

## Repeating the designated patient login tests

The mobile app has a server-gated **Private test control** on Today. It is
returned only to the one designated patient while that patient is signed in;
the API checks the live bearer token against the exact linked patient row.
Hiding the card is not the authorization boundary.

1. Sign in as the designated patient and open **Account claim paths** on Today.
2. Choose one of the four exact scenarios:
   - first-time claim by phone (restores `+1 (813) 514-5141` and keeps email on file)
   - password recovery by phone
   - first-time claim by email only (removes phone from claim matching)
   - password recovery by email
3. Review the listed effects, then tap **Prepare and sign me out**.
4. The app clears patient-only device state, signs out, and opens **Claim your
   account** with a one-time reminder and the prepared identifier filled in.
5. Dismiss the reminder or start the claim to clear it.

Preparation changes only the designated patient's phone/auth linkage and
related claim-verification rows. Diary, server-side coaching history, clinical
data, progress, subscriptions, and clinic data are preserved. Any contact
collision across patients, staff, providers, role assignments, profiles, or
Auth users blocks preparation rather than guessing.

## Tests

| Suite | Command |
| --- | --- |
| Mocked API routes (27) | `pnpm --filter @workspace/api-server exec vitest run src/routes/claim.test.ts` |
| Live end-to-end vs real Supabase (7, incl. zero-demo-rows + RLS) | `RUN_CLAIM_LIVE=1 pnpm --filter @workspace/api-server exec vitest run src/claim/claim-live.test.ts` |
| Mobile claim UI (52 checks) | `pnpm --filter @workspace/thinnr-mobile run test:claim-flow` |

The live suite creates synthetic `#99xxx`-marker rows and deletes them
children-first; it is env-gated so normal `api-tests` runs skip it.

## Go-live checklist

1. Create a Twilio Verify service; set the three `TWILIO_*` secrets. Create a
   second Verify service ("Thinnr Account Deletion") and set its SID as
   `TWILIO_ACCOUNT_DELETION_VERIFY_SERVICE_SID`.
2. Verify the sending domain in Resend; set `RESEND_API_KEY` and
   `CLAIM_EMAIL_FROM` (an address on the verified domain).
3. Set `CLAIM_SMS_DELIVERY_MODE=live`; set `CLAIM_EMAIL_DELIVERY_MODE=live`
   only after Resend is configured, then restart the API server.
4. Smoke: claim a synthetic test account by SMS and by email.
5. Andrew signs in by running the claim flow against his HQ email (his
   `hq_admin` auth user exists; the flow acts as password reset for it).

## Security posture

- Identify/verify/birthday responses are neutral — no account enumeration.
- Identify is also **timing-neutral**: every account-dependent outcome (hit,
  miss, send-capped) is held to a minimum response time
  (`CLAIM_IDENTIFY_FLOOR_MS`, default 350ms) and delivery fires after the
  response, so response timing can't out an account either.
- Send caps are enforced **atomically in the database**
  (`claim_register_send`: advisory lock + count + insert in one transaction,
  `supabase/migrations/20260903000000_claim_send_atomics.sql`), so parallel
  requests cannot race past the 3-per-identifier-per-hour limit. Add-phone
  carries the same per-destination cap plus a per-account cap (6/hr) so a
  claimed login can't rotate numbers to spray texts. Per-IP limiters remain
  as a secondary damper only — the server trusts proxy headers broadly
  (`trust proxy: true`), so IPs are spoofable and never the real control.
- Verification ledger (`claim_verifications`) is service-role only.
- Claiming writes exactly two columns on the matched row; all other writes
  to migrated tables stay locked (anon: none; authenticated: SELECT via
  RLS + column-limited patient UPDATE).
- Auth provisioning triggers require server-set markers
  (`thinnr_provisioned`/`thinnr_claim`), closing the self-signup hijack of
  staff emails; they are DEFERRABLE CONSTRAINT triggers because GoTrue
  merges `app_metadata` after the initial `auth.users` insert.
