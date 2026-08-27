---
name: Gateway model knobs
description: Which OpenAI-proxy request knobs actually work here — reasoning_effort vocabulary per fleet, ignored image detail — and why quality-touching knobs need the multi-plate harness, not a single probe.
---

# AI-gateway request knobs: probe for acceptance, harness for quality

- **`reasoning_effort` vocabulary is fleet-specific.** The gpt-5.6 fleet REJECTS
  `"minimal"` with a 400; its vocabulary is `none | low | medium | high | xhigh`.
  The openai SDK (≥6.49) types include `'none'`, no cast needed.
  **Why:** a plan may ask for "minimal reasoning" verbatim; sending that string
  as-is fails the whole call. Translate to the fleet's vocabulary and say so.
- **`reasoning_effort: "none"` was a real-world accuracy regression for plate
  reads.** It halved latency (~3–5s vs ~7–12s, 0 reasoning tokens) and looked
  clean on a single probe plate — then degraded real meal-photo reads in use and
  was reverted (2026-08). The meal read ships at the model's DEFAULT effort (the
  knob omitted); that is the accuracy bar.
  **Why:** one clean photo cannot represent sauces that hide food, mixed dishes,
  or ambiguous portions; "the probe matched" is acceptance evidence, not quality
  evidence. Mocked suites prove contracts, not read quality.
- **A single probe validates only that the gateway ACCEPTS a knob** (no 400, no
  silent ignore). Any knob that can touch READ QUALITY must pass the multi-plate
  side-by-side harness (`artifacts/api-server/scripts/meal-read-harness`):
  parity with the default read across the ENTIRE varied fixture set, recorded
  run committed to its `results/`. A candidate that misses parity anywhere does
  not ship.
- **Image `detail` is ignored by the proxy** — `"low"` and `"high"` both produce
  identical prompt token counts. A "cheaper classify via detail: low" step is an
  honest no-op; report it instead of shipping a placebo knob.
- **How to apply:** before building on any per-request knob, probe acceptance
  against the proxy; before SHIPPING one that could affect output quality, run
  the harness gate. If the gateway rejects or ignores the knob, leave behavior
  unchanged and report honestly — never silently switch models. Transient
  full-gateway 500 outages (~1 min) happen; re-probe before concluding.
- **Photo-turn cost is a log fact now:** photo completion/failure log lines
  carry per-stage token usage (`usage.{classify,meal,menu,label}` — prompt/
  completion/reasoning counts) next to the stage timings; don't estimate.
