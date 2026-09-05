---
name: Supabase bulk migration size
description: Request-size constraint and chunking rule for large generated data migrations sent through the Supabase management API.
---

Split generated bulk-data migrations into ordered, idempotent transactional chunks whose individual SQL bodies stay comfortably below 3 MB.

**Why:** The Supabase management database-query endpoint accepted a roughly 2.7 MB generated seed but rejected a roughly 3.1 MB version with `request entity too large`. One oversized migration therefore cannot be applied through this workspace's only writable SQL path.

**How to apply:** Partition deterministic seed rows into sequential migration files, keep each file independently transactional and rerunnable, and verify every committed part byte-for-byte against the generator.