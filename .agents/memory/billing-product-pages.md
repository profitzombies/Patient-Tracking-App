---
name: Billing product pages & subscription plans
description: Durable decisions behind product-page content, per-product cadences, subscribe-and-save, and the office floor-price fallback in the billing catalog.
---
- **Subscribe-and-save is modelled as discounted per-cadence recurring Stripe prices, never coupons.** The legacy 4-week full-price id is what existing subscriptions renew on and is never archived.
  **Why:** office-net reporting must be exact integer cents per renewal; coupons make the net depend on Stripe rounding. Existing subscriptions were promised "renews exactly as today".
  **How to apply:** any cadence-aware checkout must read the per-cadence price map and re-ensure it before creating the subscription; when the HQ switch is off the percent is 0 everywhere and the 4-week entry reuses the legacy price.
- **An office price row is optional: no row = sold to that office's patients at the catalog floor price, one-time only.** "Offered" in the office price list means "has its own price row", not opt-in.
  **Why:** the product plan required unpriced products to fall back to the floor; the earlier "missing row = not offered" rule was superseded and the spec reconciled.
  **How to apply:** do not reintroduce opt-out semantics via row absence; if an explicit per-office opt-out is ever wanted, it needs its own column, not a deleted row.
- **Seeded product-page copy is verbatim program-document wording, guarded so HQ edits survive re-runs; the local SQL suite proves seed parity against the mobile catalog JSON.** Change the copy in the source documents/catalog first, then re-seed, never by hand in the migration.
- **Line-based text editors in HQ round-trip exactly and are covered by tests**; a fact name containing the row separator cannot be expressed, which is a known limit until a structured editor lands.
