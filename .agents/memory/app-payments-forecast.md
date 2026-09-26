---
name: App payments forecast and reports
description: Rules for the HQ App payments page (office access revenue) — forecast semantics, outstanding vs future, export kind naming, demo anchoring.
---

- The forecast must reuse the charger's own date and price rules (next-charge anchor, price override, plan cycle), never a parallel reimplementation.
  **Why:** HQ compares forecast against collected money; a drift between the charger and the projection shows up as fake variance.
  **How to apply:** any change to how the charger picks the next charge date or amount must be mirrored in the forecast (server tests pin it: overrides, yearly, trial end, past due).

- A charge whose anchor is at or before "now" (past due, restricted, unpaid) is OUTSTANDING, never future revenue. At-risk = future charges whose office has a payment-method problem (no method, card expiring before that charge date, unverified bank) or is past due.
  **Why:** folding arrears into the forecast double-counts once they are collected.

- App payment export kinds are named `app_payments_*`, deliberately NOT `billing_*`.
  **Why:** the export permission layer admits office owners to `billing_` kinds; these are HQ-only network-wide reports (a DB CHECK also pins requester_kind='hq' and provider_id null).

- Demo sample data is anchored to DEMO_TODAY_KEY/DEMO_NOW (cross-artifact seed parity), live views use today's UTC day because server charge dates are UTC.

- Web RTR test Select stubs pick options by the first matching data-value, so page select values are prefixed (trial-7, due-30, problem-any, win-12m, hist-3m) to stay unique across selects.
