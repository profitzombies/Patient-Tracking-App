---
name: Local throwaway PostgreSQL for SQL migration tests
description: How to unit-test Supabase SQL functions hermetically in vitest by booting a temp Postgres, and the env quirks that bite.
---
Rule: SQL functions that carry product semantics (aggregates, day bucketing, null-vs-zero) get a hermetic vitest that boots a throwaway PostgreSQL with `initdb` + `pg_ctl` (unix socket in a tmpdir, no TCP), applies a minimal schema stub plus the REAL migration file verbatim, and asserts parity against the TypeScript reference implementation on a seeded fixture. `describe.skipIf` with a loud warning when the binaries are absent.

**Why:** there is no direct pg socket to the live project (management API only), the live data is tiny, and RPC fakes in route tests cannot catch SQL mistakes (window-off-by-one, timezone anchoring, grant leaks). The parity test caught nothing by luck: shrinking the 30-day window by one day in either copy fails it.

**How to apply:**
- The workspace env sets `PGDATABASE=heliumdb` / `PGHOST=helium` (the Replit helium DB) — every `psql`/`pg_ctl` call must pass `-h <sockdir>` and `-d postgres` explicitly or it silently targets the wrong server.
- Port collisions: derive from the pid (`54400 + pid % 1000`); unix sockets only. Kill via `pg_ctl stop -m immediate` in `afterAll`.
- Cast/qualify per plpgsql-table-return-contracts.md; keep the migration file the single source (the test reads it from `supabase/migrations`), never a copied SQL string.
- Register it as its own validation command so a failure names the SQL, not the route suite.
