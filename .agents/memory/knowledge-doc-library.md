---
name: Knowledge doc library
description: AI Support knowledge base — ingest/extraction contracts, routing aids, replace-race handling, seeding and verification split
---

# Knowledge doc library (AI Support grounding source)

The provider AI Support chat grounds on `knowledge_documents`: full extracted text plus per-doc routing aids (short summary + keyword list) written **at ingest time**, so answer routing can pick 1–3 docs per turn the same way the coach picks verbatim compartments — without re-reading every document.

**Rules that must stay true:**
- Extraction happens on finalize, server-side, with persisted status transitions `uploaded → extracting → ready/failed` and a retry endpoint. A document is never silently empty: empty/image-only PDFs go to `failed` with a "scanned or image-only" message (no OCR by policy).
- Routing aids are total by construction: the AI writer (gpt-5-nano, JSON) falls back to a deterministic heuristic on any failure, so `ready` always implies summary + keywords exist.
- Every extraction persist is **conditional on the object path it started from** (`updateDocumentIfPathCurrent`); replace swaps the path first, so a stale extraction run can never overwrite a newer file's row. Replace also deletes the old storage object and clears old text/aids in the same swap.
- In-flight extraction dedupes on `${id}\n${objectPath}` so retry spam can't double-run.

**Why:** the chat task consumes this; if aids became optional or persists unconditional, grounding would route badly or replace races would resurrect stale text (same class of bug as training's stale-thumbnail re-check).

**How to apply:** seeding/re-seeding goes through the real HTTP path (idempotent by original filename), never direct DB inserts. The library is LIVE shared state — any e2e run that uploads must delete its fixture documents afterward. The routes are deliberately open (any demo persona manages the library; per-IP limits are the only brake), so never "fix" a missing auth gate there.
