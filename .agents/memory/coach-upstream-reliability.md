---
name: Coach upstream reliability conventions
description: SSE keepalive + idle-deadline rules for every coach pipeline (chat, recipe, cravings, menu, image)
---
- Every coach SSE route writes `: keepalive` comment lines on a timer from just after headers until the route ends, and every upstream model/image call runs under an idle deadline (a linked child AbortController whose timer restarts on each streamed chunk). Both knobs are env-tunable (`COACH_UPSTREAM_TIMEOUT_MS`, default 120s; `COACH_KEEPALIVE_MS`, default 10s) and are read **per call**, so tests and staging shrink them without rebuilds.
- **Timeout ≠ transient.** Deadline expiry throws `UpstreamTimeoutError` immediately and must NOT consume the transient retry in recipe/menu `callModel` — a retried timeout stacks another full silent wait on top, which is the bug being fixed. Genuine upstream errors keep transient + corrective retries.
- The mobile client treats a stream that ends **without a `done` event** as the retryable error unless the user aborted — never silent success. User-tapped Stop stays silent (that path is untouched; verify-coach-stop pins both directions, including the flipped "dropped connection = error" contract).
- Recipe-image generation runs under the same deadline with slot release in `finally`; with only 2 concurrent slots, a leaked slot is how the image pipeline used to jam permanently. Image failures stay invisible in chat by design.
- **Why:** proxies drop idle SSE connections; non-streaming recipe/menu turns used to sit silent for minutes (worst case several sequential long calls), which surfaced as the random "coach is unavailable" bubble or, worse, a truncated reply presented as complete.
- **How to apply:** any new coach pipeline or model call must ride the shared upstream helpers (deadline + touch per chunk + finish in `finally`) and route-level keepalive; failure logs carry `pipeline` + `elapsedMs` so mystery errors stay explainable. Sinkhole staging: a TCP listener that accepts and never responds (`net.createServer().listen(...)`) + tiny `COACH_UPSTREAM_TIMEOUT_MS` reproduces hangs deterministically; port-9 base URL reproduces fail-fast refusals.

## Stop/abort callback races
An abort can land between a reader.read() resolving and its buffer draining — the drain then still fires onDelta/onDone after the user stopped. Guard at BOTH layers, in every SSE chat client (coach and support):
1. Client: the SSE drain takes the AbortSignal and marks itself finished when aborted; the read loop breaks on aborted.
2. Screen: wrap callbacks in a guard that no-ops when that request's controller is aborted or no longer the current one — a stale onDone/onError otherwise flips isStreaming for a DEAD request, re-enabling send while the live stream runs (overlapping requests, corrupted UI).

**Stop with no text yet** (user stops during the long grounding/thinking pause): drop the empty assistant bubble entirely — never replay empty content to the server; the question simply stands unanswered.
