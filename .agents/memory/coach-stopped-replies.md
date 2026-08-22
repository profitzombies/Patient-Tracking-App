---
name: Coach stopped-reply contract
description: How patient-stopped coach replies are flagged and replayed so the model never continues a cut-off sentence.
---

Rule: an assistant reply the patient stops mid-stream keeps its partial text on screen, but must carry `stopped: true` end-to-end — on the client message, in the request history, in the chat wire schema, and into the server, which appends the interruption note (a constant defined beside the coach prompt) before replaying history to BOTH model pipelines (plain streaming and structured recipe turns). The note is model-only context: it must never appear in SSE output or on screen; the bubble shows a small STOPPED micro-label instead. The flag is ignored on user messages and empty content.

**Why:** un-annotated truncated replies read as finished answers — the model would continue the cut-off sentence or treat half-stated guidance as complete. Verified with real model calls: follow-ups get fresh answers, and even "go on" re-answers complete instead of splicing onto the fragment.

**How to apply:** any new consumer or producer of coach chat history (persistence, retry affordances, new model pipelines) must preserve the flag and route history through the shared annotation helper next to the prompt builder — never map role/content by hand.
