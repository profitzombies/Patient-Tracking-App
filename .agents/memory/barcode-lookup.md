---
name: Barcode lookup pattern
description: Diary barcode scanner — shared facts table filled from Open Food Facts; unit-honesty and fixture lessons
---

Rule: Barcode lookups are server-proxied through one route backed by a shared product-facts table (service-role only, no user data), with Open Food Facts as the fill-on-miss source. Keys are canonical codes (UPC-A/GTIN-14 variants unify onto GTIN-13) and only FOUND results are cached or stored — misses self-heal when a product is added upstream later.

**Why:** One module owns the third party (swap stays cheap), repeat scans skip it entirely, and the open-demo posture matches the AI Support routes (per-IP limiter, explicit found/not_found/error, honest copy pointing at the label scanner instead of invented numbers).

**How to apply:**
- Unit honesty: OFF's per-100 nutriment fields can describe 100 g OR 100 ml (`nutrition_data_per`), and the labeled serving has its own unit. Scale per-100 to a serving only when the units verifiably match; anything unverified (count servings, oz, ml against a gram basis) falls back to an honest per-100 label. "1 ml weighs 1 g" is an invented number — a completion review rejected exactly that.
- Fixture gotcha: fake-looking codes are often REAL products (a 9999… code resolved to a live OFF entry). Verify a miss code against the live API before baking it into tests or e2e.
- Typed-code ambiguity: 6/7 digits can only be compressed UPC-E (expand to UPC-A), but 8 typed digits must stay EAN-8 — the families collide at that length.
