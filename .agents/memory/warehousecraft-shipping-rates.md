---
name: WarehouseCraft shipping rates & pick-and-pack
description: How live carrier rating, NovEx pick-and-pack fees, fallback semantics, and renewal re-quotes fit the billing stack; API quirks observed on the real endpoint.
---

# WarehouseCraft shipping rates & pick-and-pack

**Credentials.** The workspace's `NOVEX_API_*` secrets ARE the WarehouseCraft
(NovEx tenant) credentials; the client reads optional `WAREHOUSECRAFT_API_*`
first and falls back to them. Never add a third set. Origin warehouse is
assumed Memphis (unconfirmed by the 3PL; documented in the module comment).

**Observed API behavior (undocumented response; fixture recorded from a real
call).** Origin block is required; `items[].lbs × quantity` drives the rates,
dims are ignored; a bad ZIP / missing destination returns 400 with an EMPTY
body (→ 422 to the patient); any other 4xx/5xx/timeout/empty rate list is a
fallback, never an error.

**Amount semantics (decided, keep consistent).**
- live patient amount = carrier rate + (pass-through ? pick-pack + packaging : 0);
  standard free at/above HQ threshold, expedited never free.
- FALLBACK patient amount = flat HQ charge EXACTLY (no handling added) so
  address-less, legacy link, and demo paths stay byte-identical.
- THINNR's recovery inside the application fee = carrier cost + pick-pack +
  packaging in BOTH cases; `shipping_cost_cents` on rows = carrier cost (live)
  or flat cost (fallback). Missing product weight → fallback `missing_weight`.
- Renewal: bad address at renewal is a fallback (nothing to fix mid-invoice);
  THINNR's product share comes from the initial order's item rows (older rows:
  fee − flat charge); pending plan changes use pending fee − pending charge.

**Why:** patients must see one predictable "Shipping & handling" line, offices
may absorb the fee but THINNR always incurs it, and the fallback must never
block checkout or change legacy numbers.

**How to apply:** every new address-known sale path (office sales, public
carts, tap sales) goes through `planCart(..., shipping)` — never a second copy
of the rules. `subscriptions.ts` must not import `cart.ts` (cycle); shared
shipment helpers live in `store.ts` / `renewal-shipping.ts`. Suites that mock
`./store` by factory need `shipmentTerms`/`shipmentColumns` via importOriginal.
The renewal reminder takes an injectable `shipping` fn so tests stay hermetic.
