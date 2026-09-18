---
name: AI usage ledger & prompt-cache layout
description: How model calls are metered/attributed, why the coach chat prompt is one system message in canonical order, and how tier switches are gated.
---

## Metering
- Meter at the shared client seam (lib wrapper), attribute through AsyncLocalStorage request context, buffer + batch-write; never await the ledger on the reply path.
- Cost is an estimate stamped with a pricing version; an unknown model stores NULL and the UI must say "unpriced", never 0.
- The gateway's `gpt-5.6-terra/luna` names are priced at the flagship gpt-5 tier by assumption; no invoice confirmed it (2026-09-18).

## Prompt cache rules (measured live 2026-09-18)
- The provider reuses a stored prefix only through a user-message boundary, minimum 1024 tokens. A per-turn block placed after the history never caches (≤1k tokens reused vs ~8k).
- One system message [persona, patient line, rules, sources in CANONICAL registry order, product block] + history gives ~99% cached tokens on every turn whose source set repeats the previous turn; a set change is a legitimate 0.
- Sort compartments by registry order, never by score — same set must yield identical bytes.
- Layout changes move the optional one-tap marker rate (13/24 baseline; trailing/patient-line-after-rules layouts fell to 7/24). Any chat prompt re-layout must re-measure the chip rate; chips are part of the reply shape.

**Why:** cache share is the only lever that cuts chat cost without touching the model; the marker regression was invisible to unit tests and only showed in a 24-reply live sample.

## Tier gate
- Cheaper tiers are evaluated with `harness:coach-chat` and `harness:meal-read --models`; results live in `docs/ai-model-tiers.md`.
- `gpt-5.4-mini` grounds and refers correctly for chat but emits ZERO one-tap markers and swaps question closers for offers → rejected for `coach.chat`. Plate reads: 0/6 parity (totals 20-40% low). Photo/label/menu never move tiers.
- Grounding checker traps: two-column PDF transcriptions split quoted lines across columns; nested “quotes” come back as single quotes; American punctuation lands inside closing quotes — strip trailing punctuation and read flagged replies by hand before calling a miss.
- `gpt-5.4-nano` is not served by the gateway; `gpt-5-mini` burns ~250 reasoning tokens on a five-word answer.
