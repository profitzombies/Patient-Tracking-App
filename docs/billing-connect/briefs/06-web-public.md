# Brief 06 — Public payment pages (`/pay/...`, no session)

Owner files (under `artifacts/thinnr-operations/`):
- `src/pages/public/pay/*` (the `PublicPayArea.tsx` stub exists and is mounted
  with `nest` at `/pay` in `App.tsx` ahead of the persona router — fill it;
  routes are RELATIVE: `/:token`, `/:token/done`, `/cancel/:cancelToken`).
  NOTE: `/cancel/:cancelToken` must be declared BEFORE `/:token` so "cancel" is
  never treated as a token.
- `src/components/billing/StripeElementsForm.tsx` — `loadStripe(publishableKey, { stripeAccount })`
  from `@stripe/stripe-js` (memoize per key+account), `<Elements stripe options={{ clientSecret, appearance }}>`
  from `@stripe/react-stripe-js`, `PaymentElement`, and a Pay button that calls
  `stripe.confirmPayment({ elements, confirmParams: { return_url } })`;
  surface `error.message` inline (announced), disable while submitting,
  and expose `onProcessing(boolean)`.
- `scripts/verify-billing-public.tsx` + package script
  `"test:billing-public": "TZ=UTC tsx --tsconfig tsconfig.billing-public.json scripts/verify-billing-public.tsx"`;
  `tsconfig.billing-public.json` extends `tsconfig.json` with `jsx: react-jsx`
  and path stubs for `@stripe/stripe-js` and `@stripe/react-stripe-js` in
  `scripts/billing-public-stubs/` (you own that dir). You may add that ONE
  script line to `package.json`.
- `docs/billing-connect/DECISIONS.md` (append under "## 06-web-public").

Do NOT edit `App.tsx`, `lib/billing-*.ts`, `hooks/use-billing.ts`,
`components/billing/primitives.tsx`. Use `publicBilling` from
`lib/billing-api.ts` and the shapes in `lib/billing-types.ts`
(`PublicLink`, `PublicOrderRequest`, `PublicOrderResponse`, `PublicOrderStatus`,
`PublicSubscription`). These pages render OUTSIDE the SessionProvider: no
`useSession`, no office hooks, no react-query provider assumptions — use
plain `useEffect`/`useState` or a local `QueryClientProvider` inside the area.

## Design
These are patient-facing checkout pages on the same Heritage system (cream
paper, cobalt primary, Playfair display titles) but calmer and narrower
(max-w 640px, centered, generous whitespace). Look at `src/pages/SecurityReport.tsx`
and `src/pages/AuthScreens.tsx` for how public/unauthenticated pages are laid out
and how the THINNR wordmark is rendered; reuse the wordmark component. Mobile
(390px) must work perfectly — patients will open these on phones. Every
control has a label; errors are announced (`role="alert"`).

## Behavior (SPEC §5 one-time / subscription, §7 items 19–21)
`/pay/:token`
1. Load `publicBilling.link(token)`. 404/inactive ⇒ "This payment link is no
   longer active. Ask your office for a new one." Network error ⇒ retry.
2. Header: office name (+ city/state), THINNR "powered by" fine print,
   `SandboxBadge` when `sandbox`.
3. Product picker: each offered product as a row with name, unit price,
   quantity stepper (0–10). When any product has `subscription_available`,
   show a purchase-mode choice: "One-time order" / "Subscribe every 4 weeks"
   (segmented control). In subscription mode exactly ONE product with
   `subscription_available` can be selected, quantity fixed at 1, with the
   copy "Ships every 4 weeks. Cancel any time from your receipt email."
4. Payer: name, email, phone — read-only summary when `locked_payer` is set
   (per-patient link), inputs otherwise (email + phone required, validate
   format).
5. Shipping address: name (prefilled from payer), line1, line2, city, state
   (2-letter select), ZIP (5 or 5+4), country fixed US, phone optional.
6. Order summary: subtotal, shipping (`shipping_charge_cents`), tax
   ("Calculated at payment" when `tax_enabled`, "—" otherwise), total (before
   tax). Fine print: "Your payment goes to <office name>, the merchant for this
   order. THINNR provides the platform."
7. "Continue to payment" → `publicBilling.createOrder(token, body)` → on
   success, freeze the form into a summary (with an "Edit order" button that
   discards the pending order client-side and re-enables the form) and render
   `StripeElementsForm` with `client_secret`, `publishable_key`,
   `stripe_account_id`, `return_url = ${window.location.origin}/pay/${token}/done?order=${order_id}&token=${token}`.
   Show the server totals (now including tax) above the Pay button. Field
   errors (`field`) land on the field; other errors in an alert.
   Payment failures from Stripe render inline; the user can retry.
`/pay/:token/done?order=&token=`
   Poll `publicBilling.orderStatus(order, token)` every 2s up to 60s while
   `pending`; `paid` ⇒ receipt summary (order number, items, subtotal, shipping,
   tax, total, office name, "We emailed your receipt to <payer_email>",
   subscription renews-on line when present); `failed` ⇒ "Payment did not go
   through" with a link back to `/pay/:token`; timeout ⇒ "Still confirming…
   check your email" copy with a refresh button.
`/pay/cancel/:cancelToken`
   Load `publicBilling.subscription(cancelToken)`, show product, office, price
   + shipping, next renewal date, and a confirm button "Cancel at the end of
   the current period" → `publicBilling.cancelSubscription` → confirmation
   state. Already-canceled ⇒ neutral notice.

## Test (`scripts/verify-billing-public.tsx`)
react-test-renderer with scripted global fetch and the Stripe stubs. Cover:
inactive link message; one-time flow builds the exact `PublicOrderRequest`
body (items, payer, shipping_address, purchase) and then mounts the Elements
stub with the returned client secret and stripeAccount; subscription mode
enforces one product qty 1; locked payer renders read-only and sends no
`payer`; field error from the server lands on the field; done page polls until
`paid` and renders the receipt; cancel page POSTs and shows the confirmation.
Finish with typecheck + your script green.
