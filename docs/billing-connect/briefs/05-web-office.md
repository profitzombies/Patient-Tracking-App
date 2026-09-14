# Brief 05 — Office Payments screens (operations web, `/payments/...`)

Owner files (under `artifacts/thinnr-operations/`):
- `src/pages/office/payments/*` (the `OfficePaymentsArea.tsx` stub exists and is
  mounted with `nest` at `/payments` in `OfficeApp.tsx` — fill it; routes are
  RELATIVE: `/get-paid`, `/` (dashboard), `/transactions`, `/transactions/:orderId`,
  `/prices`, `/links`, `/subscriptions`, `/payouts`, `/settings`).
- `src/components/layout/nav-config.tsx`: add
  `{ path: '/payments', label: 'Payments', mobileLabel: 'Payments', icon: CreditCard }`
  to `OFFICE_NAV_ITEMS` after Subscriptions and to the `Operations` section.
  Check `src/pages/MenuLab.tsx` / the menu lab variants still typecheck (they
  iterate the nav list; if any variant hard-codes a count, fix it).
- `src/components/billing/ConnectEmbed.tsx` — Connect.js loader:
  `loadConnectAndInitialize` from `@stripe/connect-js` with
  `publishableKey` + `fetchClientSecret: () => officeBilling.accountSession(components, office).then(r => r.client_secret)`,
  `appearance` matching the Heritage palette (cobalt primary `#1f3a8a`-ish —
  read the real CSS variables in `src/index.css`), and
  `ConnectComponentsProvider` from `@stripe/react-connect-js`. Export
  `<ConnectEmbed components=[…] office={…}>{children}</ConnectEmbed>` plus
  thin wrappers `ConnectOnboarding({ onExit })`, `ConnectAccountManagement`,
  `ConnectPayouts`, `ConnectBalances`, `ConnectNotificationBanner`,
  `ConnectTaxSettings`, `ConnectTaxRegistrations`, `ConnectDocuments`.
  Handle the 409 `unsupported` response by rendering a "Manage in Stripe"
  link card (`https://dashboard.stripe.com/`) instead of the component.
  Show an inline error box (with retry) if Connect.js fails to load.
- `scripts/verify-billing-office.tsx` + package script
  `"test:billing-office": "TZ=UTC tsx --tsconfig tsconfig.billing.json scripts/verify-billing-office.tsx"`.
  `tsconfig.billing.json` is created by brief 04 (copy of
  `tsconfig.office-admin.json`); if it does not exist yet when you get there,
  create it identically — same content, so a race is harmless. You may add
  that ONE script line to `package.json`. In the test, stub
  `@stripe/connect-js` and `@stripe/react-connect-js` via tsconfig paths in a
  `scripts/billing-stubs/` dir you own (tsconfig.billing.json gets two extra
  path entries — coordinate by writing them in DECISIONS.md AND adding them; brief
  04 does not touch those keys).
- `docs/billing-connect/DECISIONS.md` (append under "## 05-web-office").

Do NOT edit `App.tsx`, `OfficeApp.tsx`, `AdminShell.tsx`, `lib/billing-*.ts`,
`hooks/use-billing.ts`, `components/billing/primitives.tsx`. Brief 04 owns
`src/components/billing/RefundDialog.tsx` (props
`{ order: OrderDetail, onConfirm(amount_cents|undefined, reason), pending, error }`);
import it. If it does not exist yet when you need it, create it with exactly
that contract in the SAME path — whichever agent lands second must keep the
existing file (check before writing).

## Screens (SPEC §7, items 10–18)
Read first: `src/pages/OfficeTeam.tsx` (live office page with owner/admin/staff
gating, mutations, toasts), `src/pages/Overview.tsx` (metric tiles + chart),
`src/pages/Subscriptions.tsx` (existing seeded office subscriptions page —
the payments subscriptions page is DIFFERENT and lives under `/payments/subscriptions`),
`src/pages/Security.tsx`, `src/hooks/use-live-office-scope.ts`,
`src/components/patient/heritage.tsx`, `src/components/admin/primitives.tsx`.

Behavioral requirements:
- Gate: `useOfficeBillingScope()`. Signed-out demo persona ⇒ seeded demo
  screens from `src/pages/office/payments/demo-data.ts` (static literals, no
  clock) behind a notice "Live payments appear here once your office is signed
  in". Signed-in ⇒ live only. HQ drill-in passes `?office=` automatically via
  the hooks (`liveOffice`) — read-only banner "Viewing as HQ" is fine.
- Role: `status.viewer.can_manage === false` (staff) or a 403 from `/status`
  ⇒ `UnauthorizedState`-style card ("Only office owners and admins can manage
  payments.") on every payments page.
- No account yet (`status.account === null`): every `/payments/*` page except
  `/get-paid` redirects to `/payments/get-paid` (use `Redirect` gated on the
  loaded status, never while loading).
- `/get-paid`: two cards when no account — "Connect an existing Stripe
  account" (button → `officeBilling.oauthStart` → `window.location.assign(url)`;
  hidden with a short note when `oauth_available` is false) and "Set up a new
  account" (button → `createAccount` → then render `ConnectOnboarding`). With an
  account: status chip via `accountStatusLabel`, charges/payouts/details flags,
  requirements with deadline (`humanizeRequirement`), `ConnectNotificationBanner`,
  `ConnectOnboarding` when `details_submitted` is false or requirements are
  currently due, "Refresh status" → `sync`. Handle `?connected=1` and
  `?error=` from the OAuth redirect with a toast. Explain plainly: the office is
  the merchant, pays Stripe's card fees, and THINNR's program fee is deducted
  automatically.
- `/` dashboard: balances, next payout, collected / THINNR fees / Stripe fees /
  net, subs, to-ship count, series chart, quick links; date range via the URL.
- `/prices`: table per product: name, floor, break-even minimum, sell price
  dollar input, 4-week subscription toggle, "Offered" toggle; save per row;
  client-side validation below minimum (use the minimum from the payload) and
  the server 400 `field` lands on that row; rows below minimum flagged.
  When `stripe_mirror === 'failed'` in the response show a warning toast.
- `/links`: generic office link card (URL + copy button using
  `navigator.clipboard` with fallback), per-patient builder (debounced
  `searchPatients`, pick → create → copy), table of links with uses / last used
  / deactivate confirm.
- `/transactions` + detail: office perspective (`FeeBreakdown perspective="office"`,
  no profit), fulfillment status read-only with tracking, refund via
  `RefundDialog`.
- `/subscriptions`: list + cancel dialog (now / at period end).
- `/payouts`: balance + payout history table.
- `/settings`: tabs Bank & payouts (`ConnectPayouts`), Identity & business
  (`ConnectAccountManagement`), Sales tax (`ConnectTaxSettings` +
  `ConnectTaxRegistrations` with the plain explanation that tax is the office's
  responsibility and Stripe Tax pricing applies to their account), Documents
  (`ConnectDocuments`). Tab in the URL (`?tab=`).
- `SandboxBadge` in every page header when `status.sandbox`.
- Every table row that opens a detail uses the approved clickable-row pattern.

## Test (`scripts/verify-billing-office.tsx`)
react-test-renderer + scripted fetch (pattern `scripts/verify-office-team.tsx`).
Cover: demo persona renders without fetch; staff role gets the permission
card; no-account status redirects `/payments` to `/payments/get-paid` and shows
both setup cards (OAuth card hidden when `oauth_available` is false);
prices page rejects a below-minimum entry locally with the minimum in the
message and PUTs `{ sell_price_cents, subscription_enabled }` for a valid one;
links page POSTs the chosen patient id; the HQ drill-in appends `?office=`.
Finish with typecheck + your script green.
