---
name: New exports on factory-mocked shared libs
description: Adding a named export to a workspace lib that many route suites replace with a vi.mock factory breaks every suite at import time; how to wire optional hooks safely.
---
Rule: when a shared lib (e.g. the OpenAI client package) gains a new export that app-level code wires at import time, do NOT import it by name in `app.ts`. Look it up on the module namespace (`if ("hook" in mod) mod.hook(...)`) or have the consumer tolerate its absence.

**Why:** ~25 api-server route suites mock that package with a factory that lists only `openai`; vitest's mock proxy throws `No "X" export is defined on the mock` on the first access of any other key, so a single new named import in `app.ts` failed 16 test files that never touched the feature. The individual feature suites stayed green, so only a full `vitest run` revealed it.

**How to apply:** after touching a lib that suites mock by factory, run the whole api-server suite once (not just the feature suites) before registering validation. Prefer the `in` lookup over editing dozens of mock factories.
