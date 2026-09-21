---
name: WarehouseCraft order submission
description: Durable rules for sending paid orders to the 3PL (WarehouseCraft/NovEx): tenant routes, intent queue shape, classification, edit/cancel gating, and the surfaces that read it.
---

**Rule:** The tenant answers the legacy `/api/OrderDatas/*` routes, not the public-docs `api/Order/Create|Edit|Cancel` paths (those 404 on this account). Lookup-by-ClientOrderId echoes `ShippingMethod` as the display name ("USPS Ground Advantage"), not the enum sent on create — never assert the enum on read-back. Recorded shapes live in the shipping fixtures folder; re-record there rather than hand-editing.

**Why:** First integration attempt against the documented paths returned 404s; the account's swagger exposes the older controller. The lookup-shape mismatch produced a false test failure that was fixed in the test, not the client.

**Vendor test-environment evidence:** Email dated 2026-09-15 confirms the supplied API credentials initially point to a test environment with SKUs Test01–Test05. Email dated 2026-09-14 says the vendor switches those credentials to production on its end when requested.

**Why:** The same credentials can change environment without a local URL/key change. The vendor's initial sandbox confirmation is real evidence, but not permanent proof after a production cutover.

**How to apply:** Use the vendor's test SKUs for coordinated sandbox tests; check for a subsequent cutover before submitting. Do not assume a local test flag overrides the vendor-side environment, and never copy emailed credentials into code, logs, or memory.

**How to apply:**
- Submission intent is a DB trigger on the paid transition plus an app-side `ensureSubmission` fallback; the submissions table IS the queue, the shipment row only mirrors the outcome. New order-creating paths need neither hook (the trigger fires) but must set `warehouse_sku` on catalog rows or the intent lands in needs_attention as "incomplete" without calling the warehouse.
- Classification: duplicate ClientOrderId → lookup → sent; explicit rejection / other 4xx → permanent (needs_attention + staff alert); network/5xx/401/429 → transient with 2min·2^(n−1) backoff (cap 6 h, 12 attempts then exhausted). Kill switch = `billing_settings.warehouse_auto_submit`; the drain skips without touching intents.
- Edits/cancels look the warehouse status up first; only the editable statuses (plus Committed for address edits) are mirrored, otherwise the caller gets `locked` with the warehouse status and staff/patient copy says the current shipment is already being packed. Cancel mirroring is called from the HQ route, not `recordShipment` (import cycle).
- Surfaces: HQ acts (retry, kill switch, error text); office web and provider mobile are read-only and never show the raw warehouse error. Office/mobile demo fixtures stay byte-identical (parity suite) — `warehouse` is optional on the DTO and demo warehouse states exist only in HQ demo data.
- Trigger functions declared `security definer` must `revoke execute … from public, anon, authenticated` or the Supabase security advisor flags them as anon-callable RPCs.
- Tenant guard: the connection is `test` unless `WAREHOUSECRAFT_TENANT_MODE=live` is set (production secrets are separate from dev, so live creds + the flag go in the Publishing tool only). Stripe live-mode orders against a test tenant are HELD (pending, no attempt spent, error kind/attempt time untouched so health accounting is unaffected); once held they leave the drain's batch budget until the mode is live, then drain automatically. Sandbox orders against a live tenant skip terminally. Never bypass this by pointing dev at live credentials.
- Warehouse numeric OrderIds are per tenant: every MUTATING call (cancel, address edit) must go through the verified-lookup helper (mode matches the order's livemode, ClientOrderId lookup succeeds now); never fall back to a cached numeric id or cached status.
- Fake-store gotcha: the in-memory store used by the submission suite mutates the row object passed to `update()`; read pre-update fields (e.g. "was it already held?") BEFORE calling update or idempotency branches silently misfire in tests while PostgREST behaves differently.
- Order numbers (= ClientOrderId) are `TH-` + 8 chars; 6 chars collided at birthday scale in the sample test, and a `order_number` unique violation fails that checkout attempt (PostgREST ignore-duplicates only covers the pkey) rather than double-submitting.
