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

## 4. Resetting a test office

Resets are fine for internal testing:
- If Stripe setup is unfinished, the owner can use **Restart Stripe
  setup** on the setup screen.
- To start over completely, create a new office with a new plus-addressed
  email.

## 5. Automated proof

`pnpm --filter @workspace/thinnr-operations run test:first-provider-live`
walks the same path against the running API and Stripe **Test** mode. It
covers: the office held at setup, the OAuth start URL and its production
callback, "Start setup" creating a real test account, the embedded form
loading, a Stripe `account.updated` webhook syncing the office through the
published site, and the HQ no-charge override opening and closing the gate.
It refuses to run in Live mode and removes everything it creates. It can't
cover the parts that need a person: the inbox, the SMS code on a real phone,
and logging in to Stripe on the OAuth screen. Step 3 covers those.
