# Tap to Pay on iPhone — review note and status

## Status for the first store build

**Tap to Pay is not in the first store build.** The entitlement
`com.apple.developer.proximity-reader.payment.acceptance`, the location
usage string and the Android NFC/location permissions are added by
`artifacts/thinnr-mobile/app.config.js` only when `TAP_TO_PAY_ENABLED=1`
is set at build time; the first production build leaves it unset. Staff can
still take in-person card payments through the Stripe card form
(Payments → Sell to patient), which needs no entitlement.

Apple grants the Tap to Pay entitlement per app through the
[Tap to Pay on iPhone request form](https://developer.apple.com/contact/request/tap-to-pay-on-iphone/)
and it typically takes days to weeks. Request it in parallel with the first
submission; ship it in a later build.

## Reviewer note when Tap to Pay IS NOT in the build (paste now)

> In-person payments: clinic staff can accept card payments in the Payments
> tab using Stripe's card entry form. This build does not include Tap to Pay
> on iPhone and does not request the proximity-reader entitlement or
> location permission. All payments in the review build run in Stripe Test
> mode (use card 4242 4242 4242 4242).

## Reviewer note when Tap to Pay IS in the build (future)

> Tap to Pay on iPhone: clinic staff (not patients) can accept contactless
> cards on the iPhone itself from Payments → Sell to patient → "Tap to Pay".
> The feature uses Stripe Terminal; Stripe requires location access while a
> payment is being taken, which is why the app asks for location only on
> that screen and only for staff. Tap to Pay is available only on supported
> iPhones in supported countries and only after the clinic has completed
> Stripe onboarding; the review account's clinic is set up in Stripe Test
> mode, so you can run a test tap with any Stripe test card or see the
> "Tap to Pay unavailable on this device" state on the simulator or an
> unsupported device. The feature follows Apple's Tap to Pay on iPhone
> guidelines: it is used only to accept payment for goods sold by the
> clinic, shows the Apple-provided payment sheet, and never reads cards for
> any other purpose.

Also required then:
- The entitlement must be enabled on the App ID in the developer portal
  **and** present in the provisioning profile (EAS re-syncs it; see
  `docs/mobile-release.md` §4).
- Tap to Pay merchant education: Apple asks that the first use shows its
  "How to accept payments" screen — Stripe Terminal's SDK presents it
  automatically.
- Update [privacy-answers.md](privacy-answers.md) location rows to
  *Precise, optional, App functionality* on both stores.
- Android: Tap to Pay on Android (Stripe Terminal) needs NFC + fine
  location; Play's "Location" data-safety row flips the same way.
