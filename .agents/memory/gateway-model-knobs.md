---
name: Gateway model knobs
description: Which OpenAI-proxy request knobs actually work here — reasoning_effort vocabulary per fleet, ignored image detail — and the probe-first discipline.
---

# AI-gateway request knobs: probe before promising

- **`reasoning_effort` vocabulary is fleet-specific.** The gpt-5.6 fleet REJECTS
  `"minimal"` with a 400; its vocabulary is `none | low | medium | high | xhigh`.
  `"none"` is the real minimum: ~5s vs ~12s on a probe plate read, 0 reasoning
  tokens, extraction quality unchanged (proven by the meal suites + live turns).
  The openai SDK (≥6.49) types include `'none'`, no cast needed.
  **Why:** a plan may ask for "minimal reasoning" verbatim; sending that string
  as-is fails the whole call. Translate to the fleet's vocabulary and say so.
- **Image `detail` is ignored by the proxy** — `"low"` and `"high"` both produce
  identical prompt token counts. A "cheaper classify via detail: low" step is an
  honest no-op; report it instead of shipping a placebo knob.
- **How to apply:** before building on any per-request knob (reasoning, detail,
  etc.), run a small probe script against the proxy comparing token usage and
  latency with/without it. If the gateway rejects or ignores the knob, leave
  behavior unchanged and report honestly — never silently switch models.
  Transient full-gateway 500 outages (~1 min) happen; re-probe before concluding.
