---
name: Supabase DDL via management API
description: How to run migrations/SQL against this project's Supabase when there is no direct Postgres socket, and the advisor-check habit after DDL.
---

The workspace has no direct Postgres connection to Supabase (no pooler URL in env; only `SUPABASE_URL`, anon/service keys, and `SUPABASE_ACCESS_TOKEN`).

**Rule:** run DDL and ad-hoc SQL through the Supabase management API: `POST https://api.supabase.com/v1/projects/{ref}/database/query` with `Authorization: Bearer $SUPABASE_ACCESS_TOKEN` and JSON body `{"query": "..."}`. The project `ref` is the first host label of `$SUPABASE_URL`. Keep the canonical migration file in `supabase/migrations/` and apply it verbatim so the repo copy matches the live schema.

**Why:** psql/drizzle-push against Supabase fail here; the management API is the only writable SQL path, and it accepts multi-statement batches (wrap in one body, it runs in a transaction).

**How to apply:** after any DDL batch, hit `GET /v1/projects/{ref}/advisors/security` and read new findings. Expect intentional WARNs for anon-callable SECURITY DEFINER RPCs (narrow demo entry points); anything else new should be fixed before moving on. Data-plane verification (RLS behavior) is separate: curl PostgREST with the anon key and assert 401 on writes / 200 on reads.
- **Legacy live check constraints may not exist in any repo migration.** **Why:** the live patients table carried a `activation_status` CHECK predating the repo's migration history; inserting a new state value passed every unit fake and failed only against the real DB (23514). **How to apply:** before introducing a new enum-like value for an existing column, dump `pg_constraint` for the live table and widen the CHECK in the same migration that starts writing the value; verify with `pg_get_constraintdef` after applying.
