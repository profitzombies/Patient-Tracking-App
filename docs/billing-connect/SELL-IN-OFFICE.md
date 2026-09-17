# Sell to a patient in the office (card form or QR code)

Design contract shared by the API server and the operations web app. Money
rules from `docs/billing-connect/SPEC.md` apply unchanged (direct charge on the
office's connected account, THINNR application fee, same order/subscription
rows, same reports, activity, and fulfillment queues).

## Concepts

- **Staff sale (card form)** — staff picks products for a patient, the staff
  browser collects the card with Stripe Elements on the office's connected
  account (`loadStripe(pk, { stripeAccount })`, deferred-intent
  `PaymentElement`, `stripe.createPaymentMethod({ elements })`), and posts only
  the `payment_method_id`. The server runs the SAME cart checkout the patient
  app uses (`billing/cart.ts` `planCart` / `checkoutCart`): claim key → derived
  rows → per-group charges, card saved to the patient's Stripe customer.
  Card details never touch our server.
- **Prebuilt cart (QR code)** — staff composes a cart; the server stores an
  expiring, single-use `billing_prebuilt_carts` row and returns a token. The
  public pay page (`/pay/cart/:token`) reveals nothing but the office name and
  a status until the payer proves the phone on file (phone match + verification
  code through the shared `claim_verifications` ledger / Twilio Verify). After
  verification the page shows the lines, address, and card steps, then runs the
  same cart checkout with the patient as payer. Staff screens poll the cart
  status and flip to Paid without a refresh.
- Prebuilt carts are the mechanism the care-team chat will reuse later to send
  a bundle to checkout (same record, same public flow).

## Table `billing_prebuilt_carts` (migration `supabase/migrations/20261023000100_billing_prebuilt_carts.sql`)

| column | type | notes |
| --- | --- | --- |
| id | uuid pk | `gen_random_uuid()` |
| token | text unique | 32+ random url-safe chars (same generator style as payment links) |
| provider_id | text fk providers | office |
| patient_id | uuid null fk patients on delete cascade | optional |
| created_by_user_id | uuid null | staff actor |
| label | text null | optional note shown to staff only |
| lines | jsonb | `CartLineInput[]` (product_id, quantity, purchase, cadence_weeks) — identical shape to the patient cart |
| quote | jsonb | `CartQuote` snapshot at creation (display only; checkout re-plans) |
| status | text check | `open`, `verified`, `checkout`, `paid`, `failed`, `expired`, `revoked`, `locked` |
| expires_at | timestamptz | default now()+30 min; staff may pass 5..1440 minutes |
| phone_attempts | int default 0 | wrong-phone counter; at 5 → status `locked` |
| verification_id | uuid null | current `claim_verifications` row |
| verified_at | timestamptz null | |
| session_hash | text null | sha256 of the pay-page session token issued at verify; retained through paid status polling, cleared on revoked/expired/locked, and unusable after `expires_at` |
| checkout_attempt | int default 0 | bumps only after a DEFINITE failure; cart id = derivedUuid(`prebuilt:${id}:attempt:${n}`) |
| cart_id | uuid null | current `billing_carts` id |
| paid_at | timestamptz null | |
| created_at / updated_at | timestamptz | |

- `claim_verifications.purpose` gains `cart_pay` (widen the check constraint in the same migration).
- Privacy: transient row → deleted on patient purge (mirror `20261022000200_billing_carts_privacy.sql`); join the identity write-barrier trigger protocol the way `billing_carts` does. Never store address or card data on this row.
- Effective status is derived on read: `open`/`verified` past `expires_at` → `expired`; paid detected from `billing_orders.cart_id = cart_id` with status paid (or the row's `paid_at`).

## Office / HQ endpoints (router `billing-office.ts` or a new `billing-office-sales.ts`, mounted in `routes/index.ts`)

Scope: `requireOfficeBillingScope(req, res, { write: true, sell: true })` — new
`sell` option lets ANY active office member (owner/admin/staff) sell; HQ still
needs `provider_manage` and passes `?office=<provider_id>` (drill-in). Audit
each sale/cart creation with the existing admin audit helper.

- `GET /billing/office/sales/context?patient_id=` → `StaffSaleContext`
  `{ patient: { id, name, email, phone }, default_address: ShippingAddress | null,
     products: PublicLinkProduct[] (officeOffering), shipping_charge_cents,
     subscribe_save_percent, stripe_account_id, publishable_key, sandbox,
     available: boolean, unavailable_reason: 'not_connected'|'no_products'|null }`
  (404 unknown patient in this office; address from the patient's last order, else null).
- `POST /billing/office/sales/quote` `{ patient_id, lines }` → `CartQuote` (planCart).
- `POST /billing/office/sales` `{ patient_id, lines, shipping_address, payment_method_id, cart_id }`
  (+ optional `Idempotency-Key`) → `CartCheckoutResponse` (same body as the
  patient app: `cart_id, status: paid|requires_action|partial|failed, items[] {kind, order_id, order_number, subscription_id, status, client_secret, error, total_cents}, stripe_account_id, publishable_key, sandbox`).
  402 when `failed`. Contact edits (name/email/phone) ride on `shipping_address`
  (name + phone) — they do not rewrite the patient record.
- `POST /billing/office/carts` `{ patient_id?, lines, label?, expires_in_minutes? }` → `PrebuiltCart`
  `{ id, token, url, status, patient: {id,name}|null, lines, quote, label, expires_at, created_at, paid_at, orders: [{order_id, order_number, kind, status}] }`.
  `url` = `${publicOrigin}/pay/cart/${token}` (same origin helper as payment links).
- `GET /billing/office/carts/:id` → `PrebuiltCart` (staff polls every 3 s).
- `POST /billing/office/carts/:id/revoke` → `PrebuiltCart` (status `revoked`; no-op if paid).
- `GET /billing/office/carts?patient_id=&status=` → `{ items: PrebuiltCart[] }` (recent, newest first, limit 50).

## Public endpoints (`billing-public.ts`, per-IP limited like the link routes)

- `GET /billing/public/carts/:token` → `PublicCartPeek`
  `{ status: 'open'|'verified'|'expired'|'used'|'revoked'|'locked', office: { name }, sandbox }`.
  Nothing else before verification. Unknown token → 404 `{ error }`.
- `POST /billing/public/carts/:token/phone` `{ phone }` →
  `{ request_id, devCode? }` when the digits (last 10) match the patient on file
  (or, for a patient-less cart, any 10-15 digit number) and a code was sent
  through `registerSend`/`claim_register_send` with purpose `cart_pay`
  (delivery per `deliveryMode('sms')`; dev mode returns `devCode` inline).
  Wrong number → 400 `{ error: "That number doesn't match the patient on file.", attempts_left }`;
  fifth wrong number → status `locked`, 423 `{ error }`. Expired/used/revoked → 410.
- `POST /billing/public/carts/:token/verify` `{ request_id, code }` →
  `{ session }` (random token; sha256 stored on the row; status → `verified`).
  Shared code rules: 5 code attempts per row, 10-minute TTL, generic wrong-code error.
- `GET /billing/public/carts/:token/details` (header `X-Cart-Session`) → `PublicCartDetails`
  `{ office: {name, city, state}, patient: { name, email, phone } | null,
     lines: CartQuoteLine[], quote: CartQuote, products: PublicLinkProduct[] (only the ones in the cart),
     default_address: ShippingAddress | null, shipping_charge_cents, tax_enabled,
     stripe_account_id, publishable_key, sandbox, expires_at }`.
- `POST /billing/public/carts/:token/checkout` (header `X-Cart-Session`)
  `{ shipping_address, payment_method_id, payer?: { name, email, phone } }` →
  `CartCheckoutResponse` (402 on `failed`; the payer may retry with another card:
  a definite failure bumps `checkout_attempt`, ambiguous errors resume the same cart id).
  Patient carts pay as that patient (payer row per patient per office, card saved
  to their Stripe customer). Patient-less carts resolve a payer from `payer`
  + the verified phone through the links `resolvePayer` helper.
- `GET /billing/public/carts/:token/status` (header `X-Cart-Session`) →
  `{ status, orders: [{ order_number, kind, status, total_cents }], office_name, paid_at }`
  (the pay page polls this after `requires_action`).

## Web (operations)

- `src/components/billing/SellToPatientDialog.tsx` — opened from
  `PatientDetail` (live patient record) and `OfficePaymentsArea` (with the
  existing patient search). Steps: **Products** (offering list; per product:
  one-time or subscribe, cadence select from `subscription_cadences_weeks`,
  quantity 1..10; running quote via `/sales/quote`) → **Charge card here**
  (contact + shipping form prefilled from context, editable; Stripe deferred
  `PaymentElement`; `createPaymentMethod`; POST `/sales`; `handleNextAction`
  on `requires_action`; completion card with receipt/order numbers) or
  **Show QR code** (POST `/carts`; `qrcode` → data URL; short link + copy;
  poll `GET /carts/:id` every 3 s; states open → verified → paid/failed/expired;
  Paid shows order numbers; Cancel = revoke).
- Demo persona: the button renders disabled (no nudge toast), matching other
  payments write controls. HQ drill-in passes `?office=` on every request and
  includes the office in query keys.
- `src/pages/public/pay/PublicPayArea.tsx` — new `/cart/:token` route before
  `/:token`: peek → phone → code → details (lines, prefilled address, card) →
  paid receipt. Friendly copy for expired / used / revoked / locked. Payment-link
  behaviour unchanged.
- `src/lib/billing-api.ts` (`officeBilling.sales*`, `officeBilling.carts*`,
  `publicBilling.cart*`) and `src/lib/billing-types.ts` mirror the shapes above.

## Proof

- API: `src/billing/prebuilt-carts.test.ts` (lifecycle: expiry, single use,
  phone match, wrong-phone lockout, session gating), `src/routes/billing-office-sales.test.ts`
  (permissions: 401 anon, staff allowed, disabled member/other office 403,
  HQ with `?office=`, quote + checkout body pass-through), public route tests.
- Web: `scripts/verify-billing-office.tsx` (sell dialog: products, quote,
  card path completion, QR path polling to Paid, demo disabled) and
  `scripts/verify-billing-public.tsx` (cart peek, phone, code, details, checkout, paid).
- Browser pass: office demo persona (button disabled) and a live test-mode
  office: card path with 4242 test card and QR path with dev-mode code.
