---
name: Tap to Pay (Stripe Terminal) on the provider phone
description: Live-sandbox facts and money-safety rules for phone-as-reader sales; read before touching Terminal server code, the native tap component, or the Sell to patient tap step.
---

## Stripe sandbox facts (verified live, not from docs)
- A Terminal location REQUIRES a full address; an office without a street address on its account gets a named "no address" reason, not a location.
- Card-present PaymentIntents accept manual capture + application fee + `setup_future_usage: off_session` on the connected account; the reusable `generated_card` appears only for some taps (contactless cards yes, most wallets no), so a subscription tap must be able to ask for a card on file afterwards.
- Collecting needs `allowRedisplay: "always"` or the tapped card is never saveable.
- Attaching an outside payment to an application-fee invoice FAILS; subscriptions started by a tap are activated by paying the first invoice `paid_out_of_band` after the intent captures.
- One PaymentIntent cannot be shared across order groups: a multi-group sale is one tap PER group.
- A card-present intent sits in `requires_payment_method` until the tap: generic replay code that reads that status as "declined" will fail healthy tap orders.

## Money-safety rules
- Never retry a declined tap on the same intent: cancel + a NEW cart key, or fall back to card form / QR.
- The phone only collects; the server mints intents, captures, and cancels, so every money transition stays on the existing CAS/ledger paths.
- Ambiguous outcomes lock the screen: after a sale is staged, no retry or fallback may start until the server has answered an explicit `not_charged` for that cart. No HTTP status is proof (a 409 can mean "already charged"); every error keeps the lock. The cancel endpoint doubles as the settle call: it captures anything already authorized, voids the rest, and answers not_charged / partial / paid.
- The settle path fails CLOSED: the intent's cancel is the FIRST thing done to a tap order, before its invoice, subscription, or row is touched (a capture that wins the race must still find a payable invoice and an incomplete subscription); a row is failed only after Stripe has accepted the cancel (never read-then-cancel; a refusal is re-read and a captured intent is a 409 `manual_resolution`); any read or void failure is a 503 `settlement_unknown`, never a guessed "failed".
- The unsettled cart key outlives the screen: persist it on the device when the sale is staged, clear it only on a definite answer, restore it on reopen (same patient → same locked sale, any other patient → blocked until confirmed). Component state alone loses the key on back/app kill.
- Account swap after staging is terminal: capture/cancel must release authorizations on the PINNED account and fail rows, never capture there; an intent that already captured on an account nobody reconciles is refused loudly, not buried under a failed row.
- Staff-facing tap sales bind the quoted pre-tax total exactly like card sales; the route, the sale input, and the phone must all carry it or the guard is decorative.

## Build facts
- Native Terminal imports live only in the `.native.tsx` component via dynamic import; web is always unavailable; Node suites hand the screen a scripted bridge.
- The RN Terminal config plugin does NOT add the iOS proximity-reader entitlement; it is hand-added in app.json.
- Physical-device proof is impossible in this workspace (Expo Go cannot load the module; the entitlement is Apple-granted). Say so in drift_reason; a follow-up task owns the device test.

**Why:** each sandbox fact cost a failed live call; the safety rules came from completion reviews that found a swapped account could capture on a foreign account, a lost cancel reply could let a patient pay twice, a swallowed Stripe error could hide a captured intent under a failed row, and a screen-only lock was lost on back.
**How to apply:** any new Terminal surface (readers, phone refunds) must reuse the terminal-sales transitions and the bridge seam rather than calling the SDK from screens, and must keep the settle-before-fallback lock.
