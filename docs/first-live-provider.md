# First live test provider: handoff checklist

A checklist for bringing the first internal test office onto the live site
(https://app.trythinnr.com). Payments stay in **Test** mode for this run, so
nothing here moves real money. For the full go-live list, see
`docs/billing-connect/LAUNCH.md`.

## 1. Stripe dashboard (one-time, both Test and Live)

Stripe keeps Test and Live settings separately. Do each item in **both** modes.

- [ ] **OAuth redirect URL.** Go to Connect → Settings → Onboarding options → OAuth → Redirects
      and add exactly:
      `https://app.trythinnr.com/api/billing/oauth/callback`
      The "Connect an existing Stripe account" option fails with a Stripe
      redirect error until this is added. The readiness check can't read this
      setting, so it always marks this item for you to confirm by hand.
- [ ] **Deauthorization event.** Go to Developers → Webhooks and open the **Connect** endpoint
      (`…/api/billing/webhooks/{test|live}/connect`). Add the event
      `account.application.deauthorized` so that when an owner disconnects THINNR
      in Stripe, the office shows as disconnected right away. The endpoints
      already carry `account.updated` and `capability.updated`, which is what
      moves onboarding status on its own.

## 2. Run the readiness check

HQ → System health → **Provider launch readiness** → Run check. Re-run it
after any reset or setting change.

- Fix every **Fail** before the first run. Each row has a plain-language fix.
- Expected **Warn** items for this Test-mode run:
  - "Mode is Test"
  - the OAuth redirect row, which you confirm by hand as above
  - the deauthorized event, until you add it
- The Stripe payment mode is shared by development and the published site
  (same `BILLING_DEPLOYMENT_ID` and the same database). Switching it at
  HQ → Settings → Stripe payment mode changes it for both.

## 3. First run on the live site

1. **Pick a fresh owner email.** Every office needs its own owner email.
   Plus-addressing works, for example `you+office1@yourdomain.com`. Reusing an
   owner email blocks sign-in.
2. **Create the office.** HQ → Accounts → Add provider account. The owner
   gets a "Sign in to THINNR" email that opens the live sign-in page. If it
   doesn't arrive, open the office's account page and press **Resend owner
   invite**. It reports sent, not configured, or failed, and it's rate-limited.
3. **Owner signs in on desktop.** They enter the email code, then enroll a
   phone for the SMS code. Office owners must complete the SMS step on first
   sign-in. They land on **Practice setup** for their own office. This screen
   uses no demo data.
4. **Connect Stripe from the setup screen.** The owner sees two choices:
   - **Connect an existing Stripe account.** This goes to Stripe, then returns
     to THINNR with a "Stripe account connected" notice. If Stripe refuses,
     the reason shows inline on the setup screen.
   - **Start setup.** This creates a new Stripe account and opens Stripe's
     embedded form in the page. In Test mode, use Stripe's test values
     (SSN `000-00-0000`, routing `110000000`, account `000123456789`, phone
     code `000000`). Status updates on its own through Stripe's webhook, and
     the page re-checks every 20 seconds while Stripe is verifying.
5. **Get past the setup gate without a charge.** Pick either option:
   - **HQ override.** On the office's account page, go to Setup override →
     **Override setup** and add a note. The office opens immediately. The
     setup screen still shows what's actually missing. **Remove override**
     puts the gate back.
   - **Finish setup for real in Test mode.** Add the bank account and both
     cards using Stripe test details, pick a plan and accept the terms. Test
     mode never charges real money, and the first office-access charge only
     falls due after the included period. HQ can lengthen or reset that
     period on the office access panel.

## 4. Invite your first patient

Patients use **Expo Go** for this run (no App Store build yet). The invite
email links the live site's Expo Go page,
`https://app.trythinnr.com/thinnr-mobile/`, set as `PATIENT_INVITE_URL` for
the published site. The readiness check's **Patient app link** row fails if
that setting is missing or points at a development preview address.

1. **Get the office past the setup gate.** The HQ override from step 3.5 is
   fine for this run.
2. **Invite from the roster.** In the office, go to Patients → **Invite
   patient** and enter the patient's name, email and US mobile number. The
   roster shows whether the invite email was sent; **Resend invite** tries
   again.
3. **What the patient does** (the email walks them through it):
   1. Install the free **Expo Go** app from the App Store or Google Play.
   2. Open the email link on the phone and tap **Open in Expo Go**. On a
      computer, the page shows a QR code to scan with the phone's camera.
   3. In THINNR, tap **Create New Account**, then **I have an invitation**.
      Not **Log In**: they have no password yet.
   4. Enter the invited phone number or email address, then the 6-digit code
      that is texted or emailed.
   5. Create a password (the name is optional), then accept the consent
      screen and finish onboarding. They are linked to the office
      automatically, with no provider code needed.
4. **Each republish refreshes the Expo Go bundle.** Patients get the new
   version the next time they open the app from the link. Development builds
   never reach them: the page serves the published build and talks to the
   published API.

## 5. Resetting a test office

Resets are fine for internal testing:
- If Stripe setup is unfinished, the owner can use **Restart Stripe
  setup** on the setup screen.
- To start over completely, create a new office with a new plus-addressed
  email.

## 6. Automated proof

`pnpm --filter @workspace/thinnr-operations run test:first-provider-live`
walks the same path against the running API and Stripe **Test** mode. It
covers: the office held at setup, the OAuth start URL and its production
callback, "Start setup" creating a real test account, the embedded form
loading, a Stripe `account.updated` webhook syncing the office through the
published site, and the HQ no-charge override opening and closing the gate.
It refuses to run in Live mode and removes everything it creates. It can't
cover the parts that need a person: the inbox, the SMS code on a real phone,
and logging in to Stripe on the OAuth screen. Step 3 covers those.

`STAFF_API_BASE=https://app.trythinnr.com pnpm --filter @workspace/thinnr-operations run test:patient-invite-live`
opens a throwaway office with the HQ override, invites a throwaway patient
(Resend's `delivered+…@resend.dev` test inbox, so nobody real is emailed),
and confirms the invite is recorded as sent and that the email that went out
links the Expo Go page and gives the Expo Go steps. It removes the office,
patient and users it created and fails on any leftovers. Run it against the
published site after a republish; the development workspace links its own
temporary preview instead, so it fails the link check there.
