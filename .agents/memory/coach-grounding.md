---
name: Coach chat grounding architecture
description: How the AI coach stays verbatim-grounded in THINNR docs and safely exposed; constraints for extending it (recipe/product cards, new compartments)
---

# Coach chat grounding architecture

The patient AI coach is a stateless SSE endpoint that grounds every reply in "knowledge compartments" — verbatim slices of the program docs archive read from disk at runtime and cached in memory. Nothing is copied or reworded into server code.

**Rules that must survive future changes:**
- Compartments slice the manual by its page markers and the knowledge base by exact section-heading lines. If the docs archive changes, slicing keys must be re-verified against the file, not assumed.
- Structured/JSON sources may only contribute their *verbatim* fields to the prompt. Editorial metadata (section keys, UI titles) must be excluded — a review flagged exactly this leak once. Attribution lines are allowed.
- The router sends 1–3 compartments per turn, never the whole manual; fixed fallback pair when nothing matches.
- Patient context (name, program day, phase) is derived **server-side** from the fixed demo seed (anchor 2026-08-22, demo patient at day 94) — never trusted from the client. If the demo seed changes, the server mirror must change with it.
- The endpoint spends paid credits with no user accounts, so it is bounded by per-IP rate limiting, a concurrent-stream cap, a daily budget, and a CORS allowlist (localhost + Replit-hosted origins; Expo web is a different origin than the API, so same-origin is not enough). Any future public AI endpoint in this demo needs the same treatment — a completion review rejected the first version for lacking it.
- Chat history is session-only client state by design — no persistence. Messages carry an optional card slot with a renderer registry so recipe/product cards can be added without changing the thread contract.

**Why:** patients must only ever see official program wording for rules; paraphrase drift and cost-exhaustion are the two failure modes reviews actually caught.

**How to apply:** when adding coach features (recipe cards, product suggestions), add new compartments or card kinds — do not inline program text into prompts, widen the router, or add unthrottled model endpoints.


**Recipe/cravings structured turns (products instead use the marker protocol — see coach-card-attachments.md):**
- Intent-gated turns return one schema-validated JSON object over the same SSE contract; never stream partial JSON.
- Cravings enforcement must be deterministic and two-sided: a cited approved-item id must exist AND the display name must provably be that item; grocery lines come from official catalog names, never model free text. One corrective retry, then an honest decline — no silent substitution.
- Suggestions stay session-only until an explicit save/log; AI numbers are always labeled estimates; treat save-vs-generated-photo as a race — whichever finishes last must attach the photo to the saved record.
