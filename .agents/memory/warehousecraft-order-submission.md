---
name: WarehouseCraft order submission
description: Durable rules for sending paid orders to the 3PL (WarehouseCraft/NovEx): tenant routes, intent queue shape, classification, edit/cancel gating, and the surfaces that read it.
---

**Rule:** The tenant answers the legacy `/api/OrderDatas/*` routes, not the public-docs `api/Order/Create|Edit|Cancel` paths (those 404 on this account). Lookup-by-ClientOrderId echoes `ShippingMethod` as the display name ("USPS Ground Advantage"), not the enum sent on create — never assert the enum on read-back. Recorded shapes live in the shipping fixtures folder; re-record there rather than hand-editing.

**Why:** First integration attempt against the documented paths returned 404s; the account's swagger exposes the older controller. The lookup-shape mismatch produced a false test failure that was fixed in the test, not the client.

**How to apply:**
- Submission intent is a DB trigger on the paid transition plus an app-side `ensureSubmission` fallback; the submissions table IS the queue, the shipment row only mirrors the outcome. New order-creating paths need neither hook (the trigger fires) but must set `warehouse_sku` on catalog rows or the intent lands in needs_attention as "incomplete" without calling the warehouse.
- Classification: duplicate ClientOrderId → lookup → sent; explicit rejection / other 4xx → permanent (needs_attention + staff alert); network/5xx/401/429 → transient with 2min·2^(n−1) backoff (cap 6 h, 12 attempts then exhausted). Kill switch = `billing_settings.warehouse_auto_submit`; the drain skips without touching intents.
- Edits/cancels look the warehouse status up first; only the editable statuses (plus Committed for address edits) are mirrored, otherwise the caller gets `locked` with the warehouse status and staff/patient copy says the current shipment is already being packed. Cancel mirroring is called from the HQ route, not `recordShipment` (import cycle).
- Surfaces: HQ acts (retry, kill switch, error text); office web and provider mobile are read-only and never show the raw warehouse error. Office/mobile demo fixtures stay byte-identical (parity suite) — `warehouse` is optional on the DTO and demo warehouse states exist only in HQ demo data.
- Trigger functions declared `security definer` must `revoke execute … from public, anon, authenticated` or the Supabase security advisor flags them as anon-callable RPCs.
