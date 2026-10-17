---
name: Reseller agreement date anchors the included period
description: Durable billing decisions for the HQ-recorded reseller agreement date — where the anchor lives, when it moves, and the one charge boundary every date reader must share.
---

**The agreement date lives on the office; the anchored period lives on the subscription row and
is rewritten only when the date (or the kind, to reseller-with-date) actually changes.**
**Why:** reading the date at derivation time would silently undo HQ's manual period edits and
reset-trial; re-anchoring on every save would move money dates from unrelated profile edits.
**How to apply:** compare before/after facts in the HQ account routes; software-only offices
ignore the date everywhere; a lifetime row has nothing to anchor; clearing the date falls back to
the owner's REAL recorded first sign-in, never "today". The anchoring write is version-guarded and
`changed:false` from the apply helper is ambiguous (already there OR lost race): compare the returned
row's period to the intended one, re-read and retry a few times, then surface a conflict — the
account date is already saved, so a lost write must never read as success. The idempotent retry
is a same-date save that re-anchors only when no anchoring history row names that exact date —
that keeps HQ's later hand-set periods safe while healing a create/edit whose anchoring never landed.

**One charge boundary: coverage ends at the LATER of paid-through and the included period end.**
A corrected agreement date (or an HQ grant) can extend the included period past a period already
paid for; the charger, forecast, setup snapshot and HQ card must all read the same later date.
**Why:** charging at the old paid-through date while the state machine says "included period"
is a real billing error the review caught — the two dates can legitimately cross.
**How to apply:** never read `paid_through ?? included_period_ends_at` for a money date; use the
shared coverage helper and keep the state derivation (either future date = access) in step.

**An already-elapsed window is not a restriction.** The office stays setup-incomplete until the
wizard completes, then goes past-due at the next pass with the normal grace. Every office-facing
sentence needs an elapsed variant ("free access ended on …"), and calendar dates are formatted in
UTC so a west-of-UTC browser cannot show the day before — this applies to the office wizard and
office access card too, not only HQ helpers (a reviewer caught `dateStyle:'long'` without
`timeZone:'UTC'`); run date-formatting suites under a western TZ as well as UTC.
