---
name: OpenAPI codegen vs workspace zod version
description: type integer in openapi.yaml breaks orval codegen against workspace zod 3; use type number
---

# OpenAPI codegen vs workspace zod version

Using `type: integer` in the OpenAPI spec makes orval v8 emit `zod.int()` — a zod v4 API — while the workspace pins zod 3, so codegen output fails typecheck.

**Why:** orval v8 targets the zod 4 surface for integer types; other packages depend on zod 3 semantics, so upgrading zod is not the cheap fix.

**How to apply:** in the spec use `type: number` (optionally with `minimum`/`maximum`) and round/clamp server-side where integer semantics matter.
