---
name: Provider account lock pattern
description: Presence-keyed Supabase lock table + single-choke-point RLS enforcement for shutting off an office's access
---

# Provider account lock (HQ kill switch)

The rule: a lock is a presence-keyed row (pk = account code; insert = lock, delete = unlock, `locked_at` only for copy). World-readable select so demo badges render; writes RLS-gated to real `hq_admin`.

**Why:** boolean-column designs need UPDATE policies, seed rows, and drift handling; a presence row makes "no lock exists" byte-identical to the pre-feature demo and makes unlock trivially restorative (nothing re-created).

**How to apply:**
- Enforce at the choke point: office scope resolves through `private.caller_provider_account()` / `private.caller_is_staff()` — make those lock-aware (null/false while locked) and every office-scoped RLS branch and SECURITY DEFINER RPC collapses at once, no per-policy edits. HQ-admin paths bypass by role, so HQ keeps drill-in visibility for free.
- Keep the locked staffer's own `profiles` row readable — the client needs role + account code to render the "account is locked" notice instead of a generic error.
- The client gate (App-level, checked on the raw account code before seeded-account resolution) is UX only and fails open; RLS is the authority. Ejection/restore rides the existing 10s-poll + realtime pattern — proven in both directions with two isolated browser contexts in one tester session.
- Only seeded accounts get the lock UI: session-added demo accounts reuse ids across sessions/browsers, so a shared lock keyed on them would leak between visitors.
- Live proof shape (`test:account-lock`): baseline own-row id → lock → blocked reads/writes + HQ still sees rows → unlock → same row id back; throwaway HQ admin + any created rows removed in `finally`.
