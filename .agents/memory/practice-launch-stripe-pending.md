---
name: Practice setup gate accepts pending Stripe verification
description: Which Stripe connected-account states let an office finish practice setup, and where that rule lives.
---
Stripe "pending" (details submitted, nothing currently/past due, disabled_reason empty or requirements.pending_verification) counts as done for practice setup, the same as "ready". Any other disabled_reason blocks, even if the stored charge/payout flags are true.

**Why:** User decision (2026-09-25): offices stuck waiting on Stripe review should still get into their workspace; patient charging stays off on its own because checkout checks charges_enabled.

**How to apply:** The rule is in four places that must move together: the TS state helper, the access setup snapshot, the complete_practice_launch SQL function (the DB re-checks it), and the web setup screen. Change all four in lockstep with tests on both sides.

## Finish hand-off
The "configuring your account" cover lives in the workspace gate, not the setup screen, so any setup UI that finishes triggers it.
**Why:** a rival setup design (wizard) may replace the setup screen; the gate sees completion either way.
**How to apply:** keep the dashboard in the same JSX slot (always-present `contents` wrapper) or it remounts when the cover lifts; only latch "was incomplete" from a response fetched after mount, never stale cache.
