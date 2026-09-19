---
name: Legal holds
description: How patient/office legal holds block every destructive path and how the HQ UI derives hold state.
---
Rule: the hold predicate lives INSIDE every delete statement (trim RPCs, compaction, storage reconcile, purge claim), never as a pre-check in the worker; office-level holds resolve through the patient's provider in the same predicate.

**Why:** a worker-side check races the claim and misses new callers; putting it in the SQL means any future clean-up path that reuses the RPCs is hold-aware for free, and the real-PG suite can prove each path skips held rows.

**How to apply:** new destructive SQL against patient-owned rows must call the shared predicate; deletion requests park as `held` (grace clock resumes on lift, patient DTO shows it as pending; office readers treat it as an open request). HQ UI reads hold state from the holds list endpoint filtered by office — not from account/roster DTOs — while the office badge rides a PostgREST computed column on the patient row. Office-wide holds show read-only on a patient page; controls hide for non-Admin HQ roles and the demo persona.
