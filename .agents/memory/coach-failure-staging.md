---
name: Staging coach failures for tests
description: How to deterministically produce (and heal) coach chat error states in e2e tests
---
- The api-server keeps serving while its model upstream is broken: restart the "artifacts/api-server: API Server" workflow with AI_INTEGRATIONS_OPENAI_BASE_URL overridden to an unreachable address (e.g. http://127.0.0.1:9/v1). Coach requests then fail fast and the client shows its error bubble. Restart the workflow without overrides to heal.
- **Why:** coach failure paths (error bubbles, Retry) cannot be triggered from the UI while the upstream is healthy, and the testing subagent can perform override restarts itself — so break → assert → heal → assert fits in a single tester session.
- **How to apply:** any e2e work on coach chat failure/retry/stop states. Related invariant: only status "done" messages are sent in request history, so failed replies are excluded — an as-yet-unanswered question stays in history and the model may fold its answer into the next healthy exchange.
- Sequencing: have the tester obtain any coach suggestion cards it needs while the upstream is HEALTHY, before breaking it. A chat message sent while broken fails loudly with the chat error panel (expected, separate surface) — testers misread that as the bug under test and abort.
