---
name: Live patient-data rail
description: Architecture rules for per-patient live data — account seam, server-truth gating, media rail, atomic compound writes.
---
Rule: Per-patient live data rides ONE seam: an account context defaulting to the demo account (suites mounting the store without the provider stay byte-identical demo), a whoami role gate (only a patient session unlocks real mode), and a store that for real accounts skips the seed, hydrates from the API, and persists only local-only slices under a per-account key (server-backed slices stored zeroed).

**Why:** zero test blast radius, leak-proof account switches, no path where a real account's data exists only on-device.

**How to apply:** each new live slice joins the same rail: server state + API, hydrate through the same gate, mutate through the shared optimistic helper (commit → server op → revert + visible notice on failure, epoch-checked). App code never touches Supabase tables — API server only, service-role-only tables.

**Media rail:** mint→PUT→finalize with ownership baked into the object path; finalize re-validates the stored bytes before writing the ledger row (failure discards the stray object). Rows store paths only; display URLs are built at render. Reads are token-gated — a bare path must never be a bearer capability: a patient-scoped HMAC token in the URL (image tags can't send headers) must verify against the path's patient namespace plus a live ledger row, so removal kills the URL instantly. The client holds the token in a zero-dependency module — a runtime import on a shared context/lib seam drags its whole graph into every Node suite runner and explodes esbuild on raw react-native. Failure asymmetry is deliberate: media upload failures stay quiet best-effort, data-write failures are loud (rollback + notice).

**Upload-then-record flows:** a helper that uploads bytes first and records the row second must RETURN success, and every caller must gate its success UI on it — a swallowed false announces success while the record write rolled back, orphaning the upload. Failed record → keep the session/form up with a retry that repeats ONLY the record step (uploads are held and reused); abandoning → discard the orphaned uploads server-side via an endpoint that deletes only unreferenced, caller-owned rows of that media kind and returns the deleted paths so the bytes go too.

**Two-phase delete under a local undo window:** remove locally at once (keep a restorable record), commit the server delete only when the window lapses. Commit no-ops if the item is back in state, resurfaces + notices on failure, and deletes row AND bytes in one server op (RPC returns paths, route clears storage best-effort). The PROVIDER owns a commit backstop — screen timers die with the screen: pending entry + unref'd timer fired through a latest-callback ref, restore claims synchronously before any await, commit claims first-come single-flight; pending queues clear only on account-IDENTITY change (a same-account rehydrate keeps them).

**Flags singleton:** sparse per-account state (nudge opt-outs, onboarding answers/completion, notification prefs) lives in ONE single-row-per-patient table written via partial-merge PUT (clients send changed keys only, absent row = defaults, size-capped jsonb). Even fire-and-forget preference writes honor the server-truth gate: queue in the store (newest-wins, single-flight flush), release once hydration lands truth, retryable notice on failure.

**Grid rows referencing owned media need a 1:1 invariant:** unique (patient_id, object_path) in the DB, a within-batch duplicate check, a ledger-membership check on upsert, 409→400 mapping. Without it two rows share one object and deleting either destroys the other's bytes.

Rules that must hold end-to-end:
- A hydrated field isn't persistence until a consumer applies it — every account-persisted slice needs an e2e check that a REMOUNT restores it into its owning provider, and that a key change resets it so accounts never bleed.
- Screens with date-navigation state may mount before live entry facts arrive. Initialize with the demo anchor, then replace only that untouched anchor with the server-confirmed `todayKey`; otherwise current meals and water stay hidden on the demo date.
- Compound mutations must be atomic on the server: the whole logical mutation in one SQL function (EXECUTE revoked from anon/authenticated, service-role only) called via `/rest/v1/rpc/...`; batch inserts inside need `clock_timestamp()` when created-order matters.
- No real-account writes before server truth: gate every mutation on a flag only a successful hydration sets — after a failed hydration, writes stay blocked behind the same retry notice.
