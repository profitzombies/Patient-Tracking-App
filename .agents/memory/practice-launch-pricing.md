---
name: Practice launch pricing intent
description: Owner-approved default office price = the product's Retail MSRP (catalog floor_price_cents); the older 2× THINNR fee rule is retired.
---

Every office's default patient price for a product is its Retail MSRP. MSRP is stored in `billing_products.floor_price_cents`. Staff-facing copy says "Retail MSRP" and never "Floor"; internal field names keep `floor`. THINNR's share (60%), the office minimum and fees are all still computed from that same number.

**Why:** On 2026-09-25 the owner explicitly replaced the earlier "2× the THINNR product fee" suggestion (which worked out to 1.2× MSRP). Existing offices were reset to MSRP once through the normal office-price edit path. Intentional custom prices were overridden on the owner's instruction. Existing patient subscriptions kept their signed-up prices.

**How to apply:** The default is decided client-side in TS (`suggestedPriceCents`), and the autoconfirm/save SQL RPCs insert whatever prices the client sends, so a default change needs no migration. Keep the rule that a default below the office minimum is saved switched off. Any change to this financial meaning needs explicit owner confirmation. A bulk re-price must go through `setOfficePrice` under a pinned billing identity, so audit rows and Stripe recurring prices stay in lockstep; the reset script shows the pattern.
