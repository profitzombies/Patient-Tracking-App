---
name: Coach card attachments
description: How the coach chat attaches rich cards (e.g. product suggestions) to replies — marker protocol, server enforcement, client slot.
---

# Coach card attachments (SSE)

The coach SSE stream carries rich attachments as a separate `data: {"card":{"kind","payload"}}` event emitted before `done` — never as inline text.

**Protocol:** the model signals an attachment with a bracketed control marker on the final line of its reply (e.g. `[[product:ID]]`). A streaming filter strips markers from the visible text and collects ids; markers can split across SSE chunks at any byte, so the filter holds back any stream tail that is still a valid marker prefix and drops a dangling prefix at flush.

**Server enforcement (the real guarantee):** instructions about attachments enter the system prompt only when the latest user message matches curated intent topics; the route accepts a marker id only if it was offered for that turn, keeps at most one card per reply, and builds the card payload entirely from curated data — model output never contributes payload fields. Ordinary program questions therefore can't produce cards even if the model hallucinates a marker.

**Client:** `lib/coach-api.ts` surfaces card events via `onCard`; the chat context attaches the first card to the streaming message and trims trailing whitespace on done (marker removal leaves a newline). Renderers self-register into the card slot (`registerCoachCard(kind, Component)`) and the chat screen imports them for side effect. Renderers must re-resolve ids against local curated data and return null for unknown ids.

**Why:** cards must be trustworthy in a medical-adjacent demo; free-text model output is not. Keeping the model's contribution to a bare id makes invented products/prices structurally impossible.

**How to apply:** new card kinds (recipes, check-ins, etc.) follow the same shape: curated data module → intent gate → prompt block with marker rule → route-side allow-list → registered renderer. Don't invent per-kind SSE event shapes.

**One-tap reply suggestions ride the same marker protocol:** the streaming filter is multi-kind (`[[product:ID]]`, `[[replies:ID]]`) — one shared filter, never two chained ones. A replies id only *selects* a curated label set server-side; the labels go out as their own `data: {"quickReplies":[...]}` event before done, so chip wording is never model text. No suggestion → client falls back to its static yes/no pair, which makes missed markers on yes/no questions cost nothing (the model does skip the marker on some turns). Unlike the intent-gated product block, the replies prompt block is always-on — it only picks UI labels, so there is nothing to gate.

Product specifics: catalog JSON lives in the mobile app (`data/product-catalog.json`) and is read by the server at runtime; names/prices must stay identical to the staff dataset's MOCK_PRODUCTS — the demo-parity script enforces this. getthinnr.com publishes no prices (B2B), so prices are demo values labeled as such on the PDP.

## Reasoning effort vs marker emission (found 2026-08-23)

Lowering `reasoning_effort` to "low" on the streaming coach call kept answers
grounded and trimmed the worst silent wait (~3.4s → ~0.7–1.6s TTFT when
product instructions inflate the prompt), but consistently suppressed the
OPTIONAL one-tap replies marker on a prompt that reliably gets chips at the
default effort (0/5 runs vs 2/2). Marker emission is a model judgment call —
cheaper reasoning skips it.

**How to apply:** don't lower effort on marker-driven calls without
re-measuring marker emission rates across several runs. The recipe pipeline
(structured output, server-built card, no markers) is the safer place to trade
effort for latency.
