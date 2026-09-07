---
name: OpenAPI codegen vs workspace zod version
description: OpenAPI shapes that trigger incompatible or colliding Orval Zod output, plus stale project-reference diagnostics.
---

# OpenAPI codegen vs workspace zod version

Using `type: integer` in the OpenAPI spec makes orval v8 emit `zod.int()` — a zod v4 API — while the workspace pins zod 3, so codegen output fails typecheck.

**Why:** orval v8 targets the zod 4 surface for integer types; other packages depend on zod 3 semantics, so upgrading zod is not the cheap fix.

**How to apply:** in the spec use `type: number` (optionally with `minimum`/`maximum`) and round/clamp server-side where integer semantics matter.

**Lenient client-context fields:** for advisory request fields a client sends best-effort (e.g. a device clock reading), do NOT put a `pattern` in the spec — the generated zod would 400 the whole request on junk. Bound abuse with `maxLength` only and parse leniently server-side, degrading to legacy behavior when unparseable.

**Stale-dist typecheck trap:** consumers (e.g. api-server) resolve the shared libs through TypeScript project references, i.e. against the libs' built `dist/` declarations — not their source. A raw per-package `tsc --noEmit` after codegen/lib changes can fail with phantom "no exported member" errors even though the source exports the symbol. Always typecheck via the root script (it runs `tsc --build` for libs first); a missing-export report is only real if it survives that.

**Path/query name collision:** Orval v8 can assign the same operation-derived name to a generated Zod path schema and its generated query-parameter type when one operation has both path and query parameters.

**Why:** the API-Zod barrel exports both generated symbols, so otherwise-valid codegen fails with a duplicate-export collision even though the runtime contract is sound.

**How to apply:** keep a narrowly asserted post-codegen rename for the query type, fail the codegen step if the expected generated declaration is absent, and finish with the root library typecheck.

**The collision fix is an allow-list, not automatic.** Every NEW operation that has both a path parameter and query parameters must be added to the rename list in `lib/api-spec/fix-zod-parameter-type.mjs`, or codegen fails on the duplicate export. Also: a YAML flow-mapping `description` containing `:` or `|` must be quoted, or the spec silently loses the mapping.
