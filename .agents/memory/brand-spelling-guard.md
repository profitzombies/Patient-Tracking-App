---
name: THINNR brand-spelling guard
description: The rules that keep every AI surface spelling the brand THINNR, and the coverage traps found while enforcing them.
---

# THINNR brand-spelling guard

The spoken brand sounds like "thinner" and the archived program documents
deliberately misspell it, so any model output grounded in them can echo the
misspelling. One shared guard module owns all rewriting; surfaces never keep
copies.

**The rule:** prose rewriting is capitalized-only — `THINNER`/`Thinner`
become THINNR; lowercase "thinner" is ordinary English ("blood thinner
medications", "a thinner soup") and is never touched. Transcripts are the
one exception: speech comes back lowercase, so a transcript-only rewrite
upgrades lowercase mentions ONLY before curated brand-pairing words
(program/coach/protocol/...) and never after blood/paint head words. Never
apply the spoken rewrite outside transcripts.

**Why:** verbatim program materials keep their original typos (protected by
fidelity checks), so grounding text will always contain the misspelling —
prompt rules alone don't hold; the deterministic guard is the contract.

**How to apply:** complete-string surfaces inherit via the shared model-text
cleaning choke point; streaming surfaces add the chunk-bridging smoother,
flushed on EVERY writable end (error drains included); transcription also
sends a spelling-bias prompt (the model gateway forwards transcription
prompts — verified by probe). **Coverage trap:** a surface's conversational
reply going through the cleaner does not cover its STRUCTURED card fields —
recipe name/steps/ingredients initially bypassed via a dash-only cleaner and
review caught it. Audit every patient-visible string on card payloads, not
just the reply.

**Deliberately untouched:** knowledge routing keywords stay raw lowercase
matching vocabulary (only display summaries normalize); mixed-case "Thinnr"
is correct letters and out of contract; archived docs stay verbatim.

**Retrofit lesson:** an output guard only protects new output — AI text
persisted before it (knowledge summaries, training chapters/transcripts)
stays wrong in the DB. Refresh through real paths (re-extract endpoint, or
an idempotent retrofit script applying the same shared normalizers), and
check stored rows whenever adding any output guard.
