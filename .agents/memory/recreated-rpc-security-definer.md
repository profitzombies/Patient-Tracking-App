---
name: Recreating Supabase RPCs drops later ALTERs
description: Why a drop + create-or-replace of an existing RPC can silently lose security definer (or grants) that a later migration added, and how to prove it.
---

**Rule:** before changing an RPC's signature (drop + recreate), grep every later migration for `alter function <name>` / `grant execute` and carry those attributes into the new definition — `security definer` especially.

**Why:** the care-team send RPC was originally plain and a later migration altered it to `security definer` so `service_role` could reach the `private` schema guards. A signature-extending recreate copied the original header, every unit test stayed green (they only read the SQL text), and the live send returned PostgREST 403 `permission denied for schema private` — surfaced to staff as a 502 "could not send".

**How to apply:** when extending an RPC, diff the *live* definition (`pg_get_functiondef`) or check `prosecdef`, not just the first migration; after applying, prove the data plane with one real RPC call against a throwaway fixture. Contract tests should assert the header keeps `security definer` when the function depends on it.
