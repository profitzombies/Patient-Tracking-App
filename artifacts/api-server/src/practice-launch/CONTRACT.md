# Practice launch API (744)

All routes are under `/api`, use bearer authentication, and accept `?office=...` for authorized HQ inspection only. Staff office is always resolved server-side. Errors `{error,code?}`; stale versions return 409. No demo fallback. Snapshot additionally includes `billingScope: "test:acct_..." | "live:acct_..."`. Products and complete POSTs MUST send `X-Billing-Scope` equal to the snapshot value; this prevents a mode switch changing a Test review into a Live confirmation. A mismatch/missing header returns 409.

GET `/office/launch` returns:
```
{ office:{providerId,officeName}, canEdit:boolean, required:boolean,
  version:number, detailsConfirmed:boolean, productsConfirmed:boolean,
  completedAt:string|null,
  details:{officeName,providerName,email,phone,address1,address2,city,state,postalCode},
  security:{ready:boolean},
  payments:{state:"not_started"|"action_required"|"pending"|"ready",sandbox:boolean},
  products:[{productId,name,enabled,sellPriceCents,suggestedPriceCents,minimumPriceCents,subscriptionEnabled,subscriptionEligible,existingPrice,available}],
  tour:{step:number,status:"not_started"|"active"|"skipped"|"completed"} }
```
Security readiness is authoritative existing authenticated staff/MFA policy, not a new checkbox. Payments use existing `/billing/office/connect/*`; setup never collects bank details or accepts Stripe terms.

PUT `/office/launch/details`: `{expectedVersion, details:{officeName,providerName,email,phone,address1,address2,city,state,postalCode}}`.
POST `/office/launch/products`: `{expectedVersion, products:[{productId,enabled,sellPriceCents,subscriptionEnabled}]}`. Send whole current active catalog. Exact suggested price is twice THINNR fee (60% of catalog floor, truncated to cents before doubling), shipping/card fees excluded. Existing price is prefilled and must be preserved by the suggested action. Disabled is a true storefront exclusion, distinct from subscription disabled.
POST `/office/launch/complete`: `{expectedVersion}`. Requires details, products and Stripe ready/pending (no currently actionable requirements). Repeat completion succeeds. New offices blocked from operational routes until complete; legacy offices grandfathered.
PUT `/office/launch/tour`: `{step:0..5,status:"active"|"skipped"|"completed"}`. Per authenticated staff and office, optional; HQ read-only. Owner and teammates may take/skip the sample tour before setup completes; show non-owner teammates an owner-action notice. This never grants operational access.

All writes return the complete GET snapshot. Owner-only setup writes (not team admins, not HQ). Refresh GET after Stripe return/sync and mode switches. `completedAt` is effective CURRENT billing identity completion, null if not submitted in that environment or Stripe has newly actionable requirements. Practice details remain confirmed across mode changes. New mode requires product review and submission; returning to an already submitted mode restores its progress when Stripe remains pending/ready. Grandfathered offices remain exempt. Tour never grants launch permission. Pending verification permits tour, NOT charging. Existing payment endpoints remain readiness-authoritative.