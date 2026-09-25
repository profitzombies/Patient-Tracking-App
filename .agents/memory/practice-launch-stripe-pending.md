---
name: Practice setup gate accepts a submitted Stripe form
description: Which Stripe connected-account states let an office finish practice setup, where that rule lives, and how later Stripe asks surface.
---
Setup counts Stripe as done once the form is submitted and the account is neither disconnected nor rejected (disabled_reason rejected.*, listed, platform_paused). Items Stripe asks for after submission (currently_due/past_due, requirements.* reasons) do NOT block; they surface on the office Overview banner ("reviewing" vs "needs more from you"). Unsubmitted, disconnected and rejected accounts still block.

**Why:** User decisions (2026-09-25): first "pending verification counts", then widened because Stripe routinely asks for more after review starts and owners got stuck behind a greyed-out Continue. Patient charging stays off on its own because checkout checks charges_enabled.

**How to apply:** The rule is in lockstep places: the TS state helper, the access setup snapshot, the complete_practice_launch SQL function (DB re-checks it; migration applied live), the web wizard Connect/Review gates + legacy setup screen, and the billing route gate (permissions matrix test). The stored account is only as fresh as the last sync: the wizard must call the sync endpoint after Stripe's embed exits, never trust the stored row right after submission.

## Finish hand-off
The "configuring your account" cover lives in the workspace gate, not the setup screen, so any setup UI that finishes triggers it.
**Why:** a rival setup design (wizard) may replace the setup screen; the gate sees completion either way.
**How to apply:** keep the dashboard in the same JSX slot (always-present `contents` wrapper) or it remounts when the cover lifts; only latch "was incomplete" from a response fetched after mount, never stale cache.
