---
name: Connect guard needs an implicit mode default
description: Why Stripe connect/attach silently timed out on a fresh deployment and how the guard RPC treats a missing billing_mode_state row.
---

**Rule:** Any SQL that keys on the HQ billing-mode selection must treat "no `billing_mode_state` row for this deployment" as the same implicit Test / version 0 the application layer assumes; never require the row to exist.

**Why:** `guard_office_connect` raised 40001 when the row was missing (HQ had never switched modes). PostgREST retries 40001 (serialization failure) with backoff, so the client saw a 15 s timeout instead of an error — every office Stripe connect and the e2e fixture attach died silently. Fixed by accepting exactly the implicit default under the same advisory lock first activation takes.

**How to apply:**
- Raising with errcode 40001 from a guard trigger/RPC means the caller sees a timeout, not a message; use it only for genuine retry-safe races.
- Fixture rows in `billing_connected_accounts` must go through `claimConnect` + `connectGuard("attach")` (the identity trigger blocks direct inserts); removal needs a transaction-local `set_config('thinnr.connect_mutation','allowed',true)` over the management API plus `billing_connect_guards` / `billing_connect_archive` rows.
