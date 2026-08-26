---
name: OpenAPI codegen vs workspace zod version
description: type integer in openapi.yaml breaks orval codegen against workspace zod 3; use type number. Also - stale project-references dist causes phantom missing-export typecheck errors.
---

# OpenAPI codegen vs workspace zod version

Using `type: integer` in the OpenAPI spec makes orval v8 emit `zod.int()` — a zod v4 API — while the workspace pins zod 3, so codegen output fails typecheck.

**Why:** orval v8 targets the zod 4 surface for integer types; other packages depend on zod 3 semantics, so upgrading zod is not the cheap fix.

**How to apply:** in the spec use `type: number` (optionally with `minimum`/`maximum`) and round/clamp server-side where integer semantics matter.

**Lenient client-context fields:** for advisory request fields a client sends best-effort (e.g. a device clock reading), do NOT put a `pattern` in the spec — the generated zod would 400 the whole request on junk. Bound abuse with `maxLength` only and parse leniently server-side, degrading to legacy behavior when unparseable.

**Stale-dist typecheck trap:** consumers (e.g. api-server) resolve the shared libs through TypeScript project references, i.e. against the libs' built `dist/` declarations — not their source. A raw per-package `tsc --noEmit` after codegen/lib changes can fail with phantom "no exported member" errors even though the source exports the symbol. Always typecheck via the root script (it runs `tsc --build` for libs first); a missing-export report is only real if it survives that.
