---
name: Organization-wide send caps
description: Why org-wide notification caps are reserved inside the database, not counted in the worker.
---
**Rule:** an organization-wide cap (e.g. daily outreach sends) is reserved by a single DB RPC that couples the count and the deduped insert under an advisory transaction lock. Workers never "count today, then insert" locally.

**Why:** the notification worker runs in several processes and external scheduler ticks; a review rejected a local tally because overlapping ticks could each see capacity and overshoot the HQ cap.

**How to apply:** when adding another capped send path, extend the capped-enqueue RPC pattern (count derived from committed rows of that kind, `existing` for a dedupe hit takes no slot) and prove it two ways: a real-PostgreSQL test with one connection holding the lock in an open transaction while a second calls, and an in-memory concurrency test whose count yields *after* reading (mutation-proven: removing the memory store's gate must fail it). Treat a dedupe hit from a rival worker as "not this run's send".
