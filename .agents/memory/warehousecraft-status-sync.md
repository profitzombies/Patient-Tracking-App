---
name: WarehouseCraft status feed sync
description: How shipped/tracking/delivered/back-order state is polled from WarehouseCraft and written through the shipment path; live-API quirks the docs get wrong.
---

# WarehouseCraft status feed sync

**Rule:** the feed is authoritative only for orders whose submission is `sent`; every feed write goes through the same shipment write path as staff writes with `source: "provider"`, and one forward-only transition guard covers both writers (staff shipped→to_ship is a 409 now).

**Why:** emails/push/audit/mirroring already fire from that path; a second write path would double-send. Staff "Mark shipped/delivered" stays for edge cases and must never rewind a feed-set state.

**Live API quirks (verified against the tenant, not the vendor docs):**
- Documented `api/OrderStatus/ByDate` returns 404. The tenant answers `/api/OrderStatusDatas?startDate=&endDate=` (date-only, inclusive Central days; months-wide windows time out), `/api/OrderStatusDatas/{OrderId}` (answers for OTHER clients' orders too — always verify ClientOrderId == our order_number) and `?clientOrderId=` (404 on miss).
- Timestamps are zone-less Chicago-local. The 3PL says the feed rarely reports delivered; DeliverDate/delivered tracking status is honoured when present but nothing depends on it arriving.
- Vendor email dated 2026-09-17 explicitly confirms no webhooks, approves polling every 15 minutes, and says the order API does not report delivered (a separate optional shipping API does). Shipped and Closed both mean shipped.
- Cadence lives in ONE constant (the job definition's intervalMs); the stalled default is three missed polls and the env knob overrides it. As of 2026-09-22 the job polls every 5 minutes (owner's decision; the vendor had approved 15 — the owner tells the vendor, no code depends on their answer). Each poll = one date-window request + up to 50 by-id follow-ups, so shortening the interval multiplies tenant load proportionally; keep overlap/baseline/follow-up limits when changing cadence.

**Semantics chosen:** processing→processing raw-status changes are bookkeeping ("noted", no transition); shipped→shipped with a changed tracking number is "tracking_updated" (warehouse tracking overrides staff, no email); provider shipped_at = warehouse ShipDate; delivered still mirrors legacy `fulfillment_status: "shipped"`; back order = processing + flag + staff alert, patient copy stays "Preparing your order".

**Test traps:** the client config falls back to NOVEX_* env creds, so any test touching the real client path must stub WAREHOUSECRAFT_*/NOVEX_* blank or it hits the live warehouse. A fake PostgREST store must return row COPIES — in-place mutation makes `current.status` equal the new status before the email rule and back-order detection run, which looks like an app bug but is not.

**How to apply:** new feed-derived states join the mapping table + guard in one place; new HQ health tiles for the poll come from the poll ledger (`sync: null` = unreadable, `undefined` = older payload, never zeros).
