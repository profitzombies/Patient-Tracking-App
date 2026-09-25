# Practice launch / mandatory Stripe API

All routes under `/api`, bearer authenticated. Staff office is resolved server-side; `?office=...` is for authorized HQ only. Errors `{error,code?}`; stale writes return 409. No demo fallback. No tour API or tour state in active snapshots.

GET `/office/launch`:
```
{ office:{providerId,officeName}, canEdit:boolean, required:true,
  fullSetupRequired:boolean, billingScope:"test:acct_..."|"live:acct_...",
  version:number, detailsConfirmed:boolean, productsConfirmed:boolean,
  completedAt:string|null,
  details:{officeName,providerName,email,phone,address1,address2,city,state,postalCode},
  security:{ready:boolean},
  payments:{state:"not_started"|"action_required"|"pending"|"ready",sandbox:boolean},
  products:[{productId,name,enabled,sellPriceCents,suggestedPriceCents,minimumPriceCents,subscriptionEnabled,subscriptionEligible,existingPrice,available}] }
```
`fullSetupRequired` is true for new offices, false for formerly grandfathered offices. EVERY office requires owner confirmation with both charges and payouts enabled. Pending verification remains gated. `completedAt` is effective CURRENT billing-identity completion; disconnected, pending, or actionable Stripe state returns null. New mode requires fresh confirmation; switching back restores valid prior confirmation. Security readiness uses existing authenticated staff/MFA policy.

Owner-only:
- PUT `/office/launch/details`: `{expectedVersion,details:{officeName,providerName,email,phone,address1,address2,city,state,postalCode}}`.
- POST `/office/launch/products`: `{expectedVersion,products:[{productId,enabled,sellPriceCents,subscriptionEnabled}]}`. Whole active catalog. Suggested price is twice THINNR fee; preserve existing price when applying suggestions.
- Automatic suggested prices: first-time full setup has no products step. When the office's own people read (or complete) setup while `fullSetupRequired && !productsConfirmed`, the API calls the service-role RPC `autoconfirm_practice_launch_products` before answering. It saves the suggested prices for the current payment identity with `on conflict do nothing` (a price the office already holds is never overwritten; an uncovered suggestion is saved switched off), sets `products_confirmed`, bumps `version` and writes the identity receipt, all in one transaction. It is a no-op for grandfathered offices (`required=false`) and when a receipt for this identity already exists. HQ reads never trigger it. A failed write never fails the read; the next read retries. The returned snapshot already carries the bumped `version`.
- POST `/office/launch/complete`: `{expectedVersion}`. Fresh Stripe sync, both charges/payouts ready, security readiness. New offices also require details and current-identity product confirmation. Formerly grandfathered offices do not need details/product review.

Products and complete MUST send `X-Billing-Scope` matching snapshot; absent/mismatched header returns 409. All launch writes return full snapshot.

`setupOverride:{active,at,note}` reports an HQ waiver of the gate. While active, `completedAt` is the waiver timestamp and the office reaches the workspace; every other field still reports what is actually missing, and no payment action becomes possible without real Stripe credentials. HQ inspecting another office reports `hqInspection:true`; it reads this screen but is never held behind the gate. Office staff are.

HQ only (`provider_manage`):
- POST `/office/launch/override?office=<id>`: `{expectedVersion,enabled,note?}`. Grants or removes the waiver; office callers are refused. Repeating the current state is a no-op; a stale version returns 409. Confirmations, Stripe state, and financial history are untouched, so removing the waiver restores the real gate exactly.
- POST `/office/launch/regate?office=<id>`: `{expectedVersion}`. Invalidates ALL identity confirmations; returns snapshot. Preserves Stripe account, details/products, and financial history. Owner must reconfirm after fresh Stripe sync. This is NOT a connection replacement.

Owner only:
- POST `/billing/office/connect/restart`: `{}` plus mandatory `X-Billing-Scope`. Returns `{restarted:true}`. Reload billing status and launch afterward; show both existing-account and new-account choices again.
- Blocks with 409 for accounts enabled for charges OR payouts, accounts already submitted/under verification (readiness could change remotely), any local financial/customer/link/cart records, remote financial activity or balance, or an unresolved concurrent setup operation. Remote inspection failure fails closed (503). No force parameter or HQ override. HQ support must investigate without replacing a financially used connection.
- Archives detached local account identity, retains all history, NEVER deletes/deauthorizes the remote Stripe account. A timed-out mutating setup operation is deliberately locked for support rather than automatically unlocked.

Existing `/billing/office/connect/create` and `/billing/office/connect/oauth/start` remain compatible with clients omitting `X-Billing-Scope`; when supplied it must match. They pin selected environment server-side, use database claims and immutable connection identity; OAuth state binds generation and identity. Restart invalidates old callbacks, and active connections cannot be overwritten. Environment-only Stripe configuration remains unchanged. Refresh GET after sync/return/mode switch. Native clients are not changed; mandatory server gating applies to them too.