---
name: Composite typecheck staleness
description: Phantom "no exported member" typecheck errors mean rebuild the referenced lib's declarations first; ts lib predates ES2023.
---

# Composite typecheck staleness

**Rule:** Phantom typecheck errors in untouched files (`no exported member`, long-gone request shapes) mean a referenced workspace lib's emitted declarations are stale — rebuild that lib (`tsc -b`) and re-check before believing any of it.

**Why:** Typecheck resolves project references through emitted `.d.ts`, while vitest/vite/tsx resolve source — so tests stay green while typecheck reports months-old symbols.

**How to apply:** Especially after codegen into a shared lib. The OpenAPI client lib's `dist/` is gitignored, so a merge that regenerates its source (new enum member) leaves every operations-web typecheck in the completion gate red until someone runs `tsc -b lib/api-client-react` in that workspace — do it as a pre-gate step whenever `openapi.yaml` changed since the dist timestamp. Only errors surviving a fresh `tsc -b` of the referenced projects are real. Separately: the workspace ts lib predates ES2023 — avoid `findLastIndex` and friends.
