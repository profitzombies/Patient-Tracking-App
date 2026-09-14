# Brief 04 — HQ Payments screens (operations web, `/admin/payments/...`)

Owner files (under `artifacts/thinnr-operations/`):
- `src/pages/admin/payments/*` (the `HqPaymentsArea.tsx` stub exists and is
  already mounted with `nest` at `/admin/payments` in `App.tsx` — fill it; routes
  inside are RELATIVE: `/`, `/providers`, `/providers/:providerId`,
  `/transactions`, `/transactions/:orderId`, `/fulfillment`, `/catalog`,
  `/catalog/history`, `/subscriptions`).
- `src/components/admin/AdminShell.tsx`: add `{ path: '/admin/payments', label: 'Payments', icon: CreditCard }`
  to `NAV_ITEMS` after Exports and to the `Manage` section paths.
- `src/data/hq/team.ts`: add a `'payments'` `HqPermission`, grant it to
  Super Admin + Admin only (mirror of the server's `financial_read` mapping in
  `artifacts/api-server/src/lib/staff-auth.ts`), and map `/admin/payments` in
  `permissionForAdminPath`.
- `src/components/billing/hq/*` for HQ-only pieces (e.g. FulfillmentDialog,
  RefundDialog can live in `src/components/billing/RefundDialog.tsx` because
  brief 05 (office) also needs it — you own that file; brief 05 will import it.
  Keep its props generic: `{ order: OrderDetail, onConfirm(amount_cents|undefined, reason), pending, error }`).
- `scripts/verify-billing-hq.tsx` + `tsconfig.billing.json` (copy
  `tsconfig.office-admin.json`, same stub mapping) and package script
  `"test:billing-hq": "TZ=UTC tsx --tsconfig tsconfig.billing.json scripts/verify-billing-hq.tsx"`.
  You may add that ONE script line to `package.json`.
- `docs/billing-connect/DECISIONS.md` (append under "## 04-web-hq").

Do NOT edit `App.tsx`, `OfficeApp.tsx`, `nav-config.tsx`, `lib/billing-*.ts`,
`hooks/use-billing.ts`, `components/billing/primitives.tsx` (use them; if a
hook/type is missing, write a local hook in your page using `hqBilling` from
`lib/billing-api.ts` with the same key prefix `billingKeys.hq(user)` and note it).

## Screens (SPEC §7, items 1–9)
Read these existing pages for the family patterns before writing anything:
`src/pages/admin/HqOverview.tsx` (metric tiles, series chart, recent activity),
`src/pages/admin/Accounts.tsx` (filter bar + table + clickable rows + URL state),
`src/pages/admin/AccountDetail.tsx` (detail layout with section cards),
`src/pages/admin/Exports.tsx` (dialogs, mutations, toasts), and
`src/components/admin/primitives.tsx` + `src/components/patient/heritage.tsx`.

Behavioral requirements:
- Gate: `useHqBillingScope()`. Signed-out demo persona ⇒ render the page with a
  `PreviewBanner` ("Live payments appear here once HQ is signed in") and
  seeded demo numbers from a small `src/pages/admin/payments/demo-data.ts`
  (static, deterministic, no clock reads — anchor dates are literals). Signed-in
  ⇒ live hooks only; NEVER show demo data to a signed-in user. Errors ⇒ the
  app's error box with a retry button; loading ⇒ skeletons.
- Role: pages check `canHq(hqRole, 'payments')` like other admin pages and
  render `UnauthorizedState` otherwise. Refund + fulfillment actions are
  hidden unless the role is Super Admin/Admin (server enforces `provider_manage`).
- `SandboxBadge` in the page header whenever any loaded payload says `sandbox`
  (the office status endpoint carries it; for HQ, read `publicBilling.config()`
  once via a tiny hook `useBillingSandbox()` you write in
  `src/pages/admin/payments/use-billing-sandbox.ts`).
- Money via `MoneyCell`/`formatCents`; statuses via `StatusPill` + the label
  maps in `lib/billing-format.ts`. Dates via `formatDate`/`formatDateTime`.
- Filters (office, status, kind, date range, search) persist in the URL query
  string (wouter `useSearch` + `navigate(..., { replace: true })` per keystroke
  is the approved pattern).
- Fulfillment queue is the most important HQ screen: tabs To ship / Shipped /
  Canceled (URL `?status=`), each row shows order number, office, payer,
  items (name × qty), shipping address block, paid date; "Mark shipped" opens a
  dialog with carrier (select: USPS, UPS, FedEx, Other) + tracking number
  (required) → `useUpdateFulfillment`; "Cancel order" asks for a reason. Toast
  on success ("Shipped. The patient was emailed the tracking number.").
  Include a "Copy address" button per row.
- Transactions detail: everything in SPEC item 5, `FeeBreakdown perspective="hq"`
  with `profit`, Stripe ids as fine print, refund dialog (amount defaults to
  the refundable remainder; reason required; explains THINNR's fee is kept).
- Catalog: table + add/edit dialog (dollar inputs parsed with
  `parseDollarsToCents`; show computed THINNR share, break-even minimum and
  profit/unit live as the user types — compute client-side with the same
  formula as SPEC §3: share = floor(0.6 × floor), minimum per §3), retire /
  reactivate with confirm, settings card (shipping charge, shipping cost,
  card fee bps + fixed) with optimistic-version 409 handling ("Someone else
  changed these settings. Reload to see the latest.").
- Providers table: status pill from `accountStatusLabel`, below-minimum flag,
  row → detail; detail shows requirements list (`humanizeRequirement`),
  onboarding timeline from `events`, price list vs floor/minimum, etc.
- Subscriptions: program-wide list with cancel (now / at period end) dialog.
- Every table row that opens a detail uses the approved clickable-row pattern
  used in `Accounts.tsx`.
- Desktop-first, but nothing may overflow at 1024px.

## Test (`scripts/verify-billing-hq.tsx`)
Render the real pages under react-test-renderer with scripted global fetch
(pattern: `scripts/verify-office-team.tsx`, session/scope stubs in
`scripts/a11y-stubs`). Cover at least: demo persona renders banner and issues
no fetch; signed-in fulfillment tab switch changes the `?status=` query and
the request URL; mark-shipped validates tracking, PUTs the right body, and
shows the toast; catalog add dialog computes share/minimum from the typed
floor price and rejects a 3-decimal input; transactions detail renders the
fee breakdown and the HQ profit block; unauthorized role shows
`UnauthorizedState`. Finish with `pnpm --filter @workspace/thinnr-operations run typecheck`
and your script green.
