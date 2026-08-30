---
name: Legacy DB archive-and-reset pattern
description: Safe archive-then-wipe of a Supabase database via the management API — copy/verify/gate mechanics and the re-run traps.
---

- **Archive-first with `CREATE TABLE IF NOT EXISTS archive.X AS SELECT`** — atomic per table and retry-safe. The management API copies even multi-hundred-MB tables in seconds; no chunking needed. Each management-API request is one transaction, so split large migrations into apply batches.
- **Audit manifests a migration populates must be WRITE-ONCE (`ON CONFLICT DO NOTHING`).**
  **Why:** management-API applies are not recorded in `supabase_migrations.schema_migrations`, so a later standard migration run re-executes the file — an upsert (`DO UPDATE`) would overwrite frozen pre-reset counts with post-reset state and silently destroy the audit record.
  **How to apply:** freeze recorded rows at insert, register the version row in `schema_migrations` manually after applying, and prove safety by re-running the populate block and diffing the manifest.
- **Count equality is not enough — checksum both sides.** Order-independent: `sum(('x' || left(md5(row::text), 8))::bit(32)::bigint)` per table; cheap at millions of rows. Destructive scripts must require the verifier's PASS marker and re-check live-vs-archive drift immediately before deleting.
- **TRUNCATE fires no per-row triggers** (sync/demote triggers silently skipped — fine for a full reset, a trap elsewhere), and every table FK-ing a wiped table must join the TRUNCATE list even when empty.
- **Auth archives store identity/timestamps/metadata only** — never `encrypted_password` or any `*token*` column.
- **Disposable smoke admin for staff surfaces:** GoTrue admin-create a pre-confirmed throwaway (no email is sent), insert an active membership (validation trigger wants a confirmed user, matching lowercased email, `activated_at`), password-grant sign-in for API + UI checks, then delete it and re-assert exact end-state counts.
- **Storage rule that held:** never delete objects with uncertain ownership — orphans are harmless, wrong deletions are not.
