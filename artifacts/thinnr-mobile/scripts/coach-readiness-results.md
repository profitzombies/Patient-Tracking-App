# Coach readiness synthetic timing record

Method: Node `react-test-renderer` with `CoachChatProvider`, a held
`fetchCoachConversation` promise, and a fixed 12 ms release delay. Counts are
the provider transport method invocations; elapsed time is wall-clock time
from action invocation until the held request is released and selection
settles. This is a deterministic readiness protocol, **not** a network
latency benchmark.

Run these commands from `artifacts/thinnr-mobile`. Development Metro bundling
and font startup are excluded from the provider measurements.

## Before cache/readiness implementation

Executed from an isolated source module, without reverting the working tree.
The repeatable fixture generator requires an immutable ref and removes its
temporary module when it finishes:

```sh
pnpm exec node scripts/verify-coach-readiness-baseline.mjs \
  --baseline-ref c2a1caa3b16191d1aba39430f26660566d598a98
```

Actual output:

```json
{
  "baselineRef": "c2a1caa3b16191d1aba39430f26660566d598a98",
  "protocol": "held fetchCoachConversation + fixed 12ms release",
  "cold": { "requests": 1, "heldDelayMs": 18 },
  "warm": { "requests": 1, "heldDelayMs": 13 },
  "focus": { "requests": 1, "heldDelayMs": 13 }
}
```

## After cache/readiness implementation

Executed with:

```sh
pnpm exec tsx --tsconfig tsconfig.coach-readiness.json \
  scripts/verify-coach-readiness.tsx
```

Actual output:

```text
baseline cold/warm/ordinary-focus requests=1/1/1; post=1/0/0; forced-refresh=1; cold-held-ms=19; ttl-ms=15000
✓ coach readiness check: 40 checks passed
```

The post suite also holds/coalesces list pages, asserts terminal (403) versus
retryable (503) cache behavior, active-stream focus stability, retained local
user turns on a warm return, and cache/scope purge across clear, A→B, sign-out,
and return-to-A transitions.

It also starts a send during a held refresh, rejects an append after account
clearing, denies older-page access, and resolves or rejects old history work
after revocation/account replacement. The screen checks cover blocked
input/photo/send while unknown, usable headers, retry, retained drafts and
transcripts during refresh, older-page placeholders, and unchanged Stop controls.
The history harness measured destination dispatch at **0.52 ms while transcript
work was still held** (Node, not browser paint).

The old history handler awaited selection before pushing the chat route, so
the measured selection wait sat on the navigation path. The new handler
dispatches before waiting. Neither the 18 ms baseline nor the 19 ms current
hydration measurement claims a network speed improvement: the eliminated work
is the ordinary focus refetch and the fresh-cache refetch, not faster AI replies.

Also executed after the core change:

```text
pnpm run test:chat-account  →  124 checks, 0 failures
pnpm run test:coach-stop    →  ✓ coach stop-control check: 100 checks passed
```

The account suite includes a mocked presigned PUT held across
`clearLocalState`, then released: no purged photo turn is appended or restored.
The paired same-account navigation case retains the photo on its original
conversation without altering the newly selected thread.
It returns to that conversation through the fresh cache, waits for any
persistence effects, then cold-hydrates again to prove the saved photo survives.
Browser navigation/request evidence is recorded separately in
`docs/coach-navigation-browser-check.md` at the workspace root.

## Completion-wide validation limit

The project-wide run launched over 80 independent suites concurrently.
Forty-three logs reported process/thread exhaustion (`Cannot fork`, `EAGAIN`,
`uv_thread_create`, or “resource temporarily unavailable”); several processes
aborted with exit 134 and remaining stalled commands were stopped. That run
does **not** establish project-wide regression health. The changed Coach suites
were then rerun sequentially and passed with the counts above; route, screen,
onboarding and type checks are recorded separately. No application assertion
was disabled to work around this runner limit.