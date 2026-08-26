---
name: Synthetic image fixtures
description: How to make deterministic, vision-model-readable image fixtures (e.g. nutrition labels) with zero dependencies, and certify them before e2e.
---

The workspace has NO image tooling: no sharp, no PIL, no chromium/playwright binaries, no canvas. Do not burn time hunting for one or installing heavyweight deps for a test fixture.

**Pattern that works:** a ~150-line Node script (no deps) that emits PNGs directly — raw RGB scanlines + `node:zlib` deflate + hand-rolled CRC32 chunks — and draws text with a 5x7 bitmap pixel font scaled up (scale 3-10). Vision models read this blocky text with 100% field accuracy; a synthetic Nutrition Facts panel with deliberately unusual values (235 cal / 9g fat / 34g carbs / 7g protein) came back from the real extraction model exactly, field for field. Generator + committed outputs live in `artifacts/thinnr-mobile/scripts/e2e-fixtures/`; extend that script for new fixtures instead of starting over.

**Why deliberately-odd numbers:** an e2e prefill assertion only proves the model read THIS image if the values are unusual enough not to be hallucinated defaults.

**Certify before e2e:** curl the live endpoint with the fixture as a data URI and confirm the extraction JSON before handing the file to the Playwright tester. That separates "fixture is unreadable" from "client is broken" — the two failure modes otherwise look identical in an e2e run.

**How to apply:** any time a test needs a deterministic photo-like input (labels, menus, receipts, "not a photo of X" negatives — the negative fixture can be crude pixel art, the model describes it fine).
