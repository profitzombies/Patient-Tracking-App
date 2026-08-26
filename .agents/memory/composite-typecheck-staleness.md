---
name: Composite typecheck staleness
description: Phantom "no exported member" typecheck errors mean rebuild the referenced lib's declarations first; ts lib predates ES2023.
---

# Composite typecheck staleness

**Rule:** Phantom typecheck errors in untouched files (`no exported member`, long-gone request shapes) mean a referenced workspace lib's emitted declarations are stale — rebuild that lib (`tsc -b`) and re-check before believing any of it.

**Why:** Typecheck resolves project references through emitted `.d.ts`, while vitest/vite/tsx resolve source — so tests stay green while typecheck reports months-old symbols.

**How to apply:** Especially after codegen into a shared lib. Only errors surviving a fresh `tsc -b` of the referenced projects are real. Separately: the workspace ts lib predates ES2023 — avoid `findLastIndex` and friends.
