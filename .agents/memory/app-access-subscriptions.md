---
name: Patient app-access subscriptions
description: Rules for offices charging patients for the app's AI features — where the entitlement is decided, what "program" means, how the subscription shares the product tables, and the non-obvious Stripe/webhook traps.
---

**One pure rule module decides access; every surface (patient endpoint, premium-route gate, roster state, provider screens) calls it with loaded facts.**
**Why:** the lock must agree everywhere or a client can be told "locked" while a route still answers (or vice versa).
**How to apply:** never re-derive "is this patient free" inline; extend the entitlement module and its exhaustive unit test.

**"Program" is the patient's program id (thinnr/glp/none — live CHECK), NOT the diet selection (keto, mediterranean…).** THINNR = free through the current episode start + 42 days (a provider restart opens a new window); any other program id = trial from account activation; a missing program id reads as THINNR.
**Why:** leadership tied the free window to the THINNR protocol, and the diet picker is a separate preference that THINNR patients also set.

**App-access subscriptions ride the SAME subscription/order tables as product replenishments, distinguished by kind, with fulfillment `not_required`.**
**Why:** webhooks, the patient's list, cancel, dunning and office reporting keep working unchanged; `not_required` keeps the shipment + warehouse triggers out. THINNR's share is a flat percent snapshotted per order (no floor price, never the office share).

**Coverage semantics:** active/past_due/unpaid cover; canceled covers until the period end (cancel = access to paid-through, then lapsed); an unpaid `incomplete` attempt covers nothing.

**Retrying checkout must retire the earlier unpaid attempt on Stripe FIRST, then locally.** Retrieve it: still `incomplete` → cancel on the connected account (voids its open invoice so a payment sheet left in another tab cannot start a second recurring charge); already paid (webhook in flight) → refuse as "already subscribed" and leave the row for the webhook; unknown to Stripe → just release the local slot.
**Why:** cancelling only in the DB left a live payable Stripe subscription behind.

**Gate order on premium routes:** HQ coach-paused 503 first, then the entitlement 402 (`retryable:false`, `upgradeRequired:true`, entitlement attached); infra errors fail OPEN (never lock patients on an outage). The patient app sends its bearer on barcode lookups when signed in; anonymous/staff lookups stay a separate open path.

**Every signed-in AI spend is a premium route** — chat/stream, photo/menu/label reads, recipe images, barcode lookup. A new model-backed patient route must call the gate after identity resolves and before reserving any usage slot; the gate test enumerates the routes, so add it there.
**Why:** one ungated route (recipe images were missed first) lets a locked patient keep spending model budget.
