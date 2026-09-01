---
name: Patient identity reconciliation write barrier
description: The concurrency rule every patient-owned table must follow so identity archival cannot strand late dependent writes.
---

**Rule:** Every public table with a `patient_id` column must install the shared patient identity write guard. Reconciliation and dependent INSERT/UPDATE statements must take the same ordered transaction-level advisory locks, then read the current patient row with a row lock before accepting the write.

**Why:** Moving dependent rows and then soft-archiving a duplicate is not safe by itself. A writer can begin before reconciliation, wait, and otherwise resume with a stale statement snapshot after archival, attaching new data to the disabled row. A post-lock `FOR KEY SHARE` read is required to observe the committed archive and reject that write.

**How to apply:** Any migration that adds a new public `patient_id` table must rerun the identity guard installer in the same migration. Keep the postcondition audit at zero unguarded tables, and preserve the real two-session race proof: archive commits while a child insert waits; the insert must fail rather than land on the archived patient.