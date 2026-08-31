---
name: Live patient-data rail
description: Architecture rules for per-patient live data — account seam, server-truth gating, atomic compound writes.
---
Rule: Per-patient live data rides ONE seam: an account context whose **default is the demo account** (any suite that mounts the store without the provider stays byte-identical demo), a whoami role gate (only a patient session unlocks real mode; staff sessions browse the demo persona), and a store that — for real accounts — skips the seed, hydrates from the API, and persists only local-only slices under a per-account storage key (server-backed slices are stored zeroed).

**Why:** zero test blast radius, leak-proof account switches, and no path where a real account's data exists only on-device.

**How to apply:** extend the same rail for each new live slice (custom foods, photos, check-ins, ...): add it to the server state + API, hydrate through the same gate, and mutate through the shared optimistic helper (commit → server op → revert + visible notice on failure, epoch-checked). App code never touches Supabase tables — API server only, service-role-only tables.

Two correctness rules a completion review rejected the first cut for missing:
- **Compound mutations must be atomic on the server.** Anything a route performs as multiple sequential PostgREST calls can partially commit, and a "rolled back" optimistic write then resurrects at the next hydration. Put the whole logical mutation in one SQL function (EXECUTE revoked from anon/authenticated, service-role only) and call it via `/rest/v1/rpc/...` — batch inserts inside it need `clock_timestamp()` if created-order matters.
- **No real-account writes before server truth.** After a failed hydration the store holds empty fallback state; a write computed from it (a favorites toggle is a whole-list replace) overwrites the account's real server data. Gate every mutation on a server-truth flag that only a successful hydration sets — failed hydration leaves writes blocked behind the same retry notice.
